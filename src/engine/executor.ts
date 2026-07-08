/* eslint-disable max-lines-per-function, complexity, max-depth */

/**
 * DAG executor core — RISK step (S26 / kb-14).
 *
 * Executes a compiled GraphIR against the provided RunState, orchestrating
 * per-node adapter invocations, concurrency-pool scheduling (AND semantics),
 * lazy fanOut expansion at ready-time, output-schema post-hoc validation,
 * retry/skip propagation (no fail-fast), and RunSummary generation.
 *
 * The executor is adapter-agnostic: it checks for the FakeAgentAdapter
 * duck-typing signal (`adapter.emitEvents`) and calls it directly when present
 * (no subprocess), otherwise falls back to the child-process spawner
 * ({@link runAgent}) with the adapter's `parseEventStreamLine`.
 *
 * ### Concurrency model
 * Independent ready nodes whose scheduler pools have capacity are launched
 * concurrently (one in-flight promise per node). The main loop awaits the
 * FIRST in-flight completion via `Promise.race`, then re-evaluates readiness,
 * fanOut expansion, and schedulability. A node that cannot acquire its slots
 * remains `ready` and is retried on a subsequent pass once capacity frees. This
 * is what makes the layered concurrency pools (S28) meaningful.
 *
 * ### State machine
 * ```
 * pending ──(all deps met)──→ ready ──(tryAcquire)──→ running ──(done)──→ completed
 *                              │                          │
 *                              │                          └──(error/schema-fail + shouldRetry)──→ running (fresh session)
 *                              │                          └──(exhausted)──→ failed ──→ dependents → skipped
 *                              └──(tryAcquire fails)──→ ready (waits for capacity)
 * ```
 *
 * ### References
 * - PLAN.md §7.1 (DAG executor core)
 * - PLAN.md §19 (fake adapter integration)
 * - IMPLEMENTATION_PROMPT §7.1 (node state machine)
 */

import type { TSchema } from "typebox";

import type { AgentAdapter } from "../adapters/types.js";
import type { AuditLogger } from "../run/audit.js";
import type { Scheduler, SchedulableNode } from "./scheduler.js";
import type {
  GraphIR,
  IRNode,
  NodeRuntime,
  NodeSpec,
  NormalizedEvent,
  PoolUsage,
  RunState,
} from "../types.js";
import { debounce } from "../utils.js";
import { CONFIG_DEFAULTS, DEFAULT_AGENT_TYPE } from "../constants.js";
import { createNodeCtx } from "./context.js";
import {
  resolvePolicy,
  shouldRetry,
  propagateSkip,
  backoffMs,
  buildSuccessorsMap,
  buildPredecessorsMap,
  type SkipReason,
} from "./retry.js";
import { rehydrateFn, rehydrateArity, validateOutputAgainstSchema } from "../dsl/fn-serialize.js";
import type { RunAgentResult } from "../spawn/spawner.js";
import { resolveProfileSync } from "../profiles/resolve.js";
import type { ResolveOptions } from "../profiles/resolve.js";
import { evaluateCond, executeLoop, type LoopDispatch } from "./loop.js";
import { executeSynthesis } from "./synthesize.js";
import {
  finalTextFromEvents,
  sessionIdFromEvents,
  toolCountFromEvents,
  fileEditsFromEvents,
  summarizeNode,
  computeTotals,
  invokeAdapter,
  type RunSummary,
} from "./events.js";

// ─── Public types ─────────────────────────────────────────────

/** Options for {@link executeDAG}. */
export interface ExecuteDAGOptions {
  /** The compiled graph IR to execute. */
  ir: GraphIR;
  /** Mutable in-memory run state (updated in place as nodes run). */
  runState: RunState;
  /**
   * Adapter lookup function. Receives the adapter type (default "pi") and
   * optionally the current node id so callers can vary adapters per node.
   */
  getAdapter: (type?: string, nodeId?: string) => AgentAdapter;
  /** Concurrency-pool scheduler (AND-semantics). */
  scheduler: Scheduler;
  /** Optional abort signal for cancellation. */
  signal?: AbortSignal;
  /**
   * Called after significant state changes to request a TUI re-render.
   * Receives the current run state and pool-usage snapshot so the caller
   * (e.g. the run_workflow tool) can render a live widget.
   */
  onUpdate?: (runState: RunState, poolUsage: PoolUsage) => void;
  /**
   * Override for the retry backoff base in ms (default: 2000). Exponential:
   * `retryBackoffMs * 2^(attempt-1)` for attempt >= 1.
   */
  retryBackoffMs?: number;
  /** Profile resolution options passed to resolveProfileSync for each node. */
  profiles?: ResolveOptions;
  /**
   * Optional audit logger for per-node lifecycle events (start, tool, retry,
   * complete, fail, skip). When provided, node-level events are emitted to
   * the audit log as the node runs.
   */
  audit?: AuditLogger;
}

/** Coalesce rapid `onUpdate` calls into a single TUI re-render. */
const UPDATE_DEBOUNCE_MS = 50;

// ─── Module-scope helpers (pure) ──────────────────────────────

/** Resolve `ms` later. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve the agent type for a node (defaults to "pi"). */
function resolveAgentType(node: IRNode): string {
  if (node.kind === "node" || node.kind === "reduce") return node.agentType ?? DEFAULT_AGENT_TYPE;
  return DEFAULT_AGENT_TYPE;
}

/**
 * Determine the outcome of a completed node run from its event stream.
 *
 * The last `error` event (if any) makes the run fail (with its retryability);
 * otherwise a `done` event (or any benign stream) is a success.
 */
function determineOutcome(events: NormalizedEvent[]): {
  succeeded: boolean;
  errorMessage?: string;
  retryable: boolean;
} {
  let lastError: { message: string; retryable: boolean } | undefined;
  for (const e of events) {
    if (e.type === "error") {
      lastError = { message: e.message, retryable: e.retryable };
    }
  }
  if (lastError) {
    return { succeeded: false, errorMessage: lastError.message, retryable: lastError.retryable };
  }
  return { succeeded: true, retryable: false };
}

/**
 * JSON-parse a node's final text and validate it against an output schema using
 * the canonical TypeBox post-hoc validator. Returns the parsed output on success
 * or a descriptive error string on failure. Never throws.
 */
function validateNodeOutput(
  finalText: string | undefined,
  schema: unknown,
): { ok: true; parsed: unknown } | { ok: false; error: string } {
  if (!finalText) {
    return { ok: false, error: "Node produced no output text to validate against the schema" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalText);
  } catch {
    return { ok: false, error: "Output is not valid JSON; cannot validate against the schema" };
  }
  const result = validateOutputAgainstSchema(parsed, schema as TSchema);
  if (result.ok) return { ok: true, parsed };
  return { ok: false, error: `Schema validation failed: ${result.errors.join("; ")}` };
}

/**
 * Idempotent handle to a held scheduler slot.
 *
 * `release()` decrements the slot's pools exactly once, regardless of how many
 * times it is called. This lets {@link runNode} release unconditionally from a
 * `finally` block on every exit (return, throw, abort) without tracking whether
 * the slot was already released inline. After the slot is released mid-attempt
 * (before a retry backoff) and re-acquired, a fresh handle guards the new hold.
 */
interface SlotHandle {
  release(): void;
}

/**
 * Wrap a slot the caller already holds in an idempotent {@link SlotHandle}.
 * No acquisition happens here — the caller must hold the slot; this only makes
 * release safe to call repeatedly (a no-op after the first call).
 */
function slotHandle(scheduler: Scheduler, schedulable: SchedulableNode): SlotHandle {
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      scheduler.release(schedulable);
    },
  };
}

// ─── Main entry point ────────────────────────────────────────

/**
 * Execute a compiled DAG against the given run state.
 *
 * Algorithm (concurrent, scheduler-gated):
 *  1. Mark `pending` nodes whose dependencies (dep/fanOut predecessors) are all
 *     `completed` as `ready`.
 *  2. For each `ready` node: fanOut nodes expand lazily (rehydrate iterate →
 *     items → each → child IRNodes added to the live graph); other structural
 *     kinds (cond/loop/reduce/parallel/sequence) complete as placeholders
 *     (their real logic is handled by S27/S30); plain `node`s acquire scheduler
 *     slots (AND semantics) and launch concurrently.
 *  3. Await the first in-flight node completion, then re-evaluate.
 *  4. On node completion: post-hoc output-schema validation (`Value.Check`).
 *     On failure: retry (fresh session per D4) or fail + propagate skip to
 *     transitive dependents (no fail-fast — independent branches continue).
 *  5. Terminate when nothing is ready/schedulable and nothing is in flight.
 *  6. Return a RunSummary with per-node results and aggregate totals.
 */
export async function executeDAG(options: ExecuteDAGOptions): Promise<RunSummary> {
  const { ir, runState, getAdapter, scheduler, signal, onUpdate, audit } = options;

  const defaultRetries = ir.options.defaultRetries ?? CONFIG_DEFAULTS.defaultRetries;
  const retryBackoff = options.retryBackoffMs ?? CONFIG_DEFAULTS.retryBackoffMs;
  const update = onUpdate
    ? debounce((rs: RunState, pu: PoolUsage) => {
        onUpdate(rs, pu);
      }, UPDATE_DEBOUNCE_MS)
    : undefined;
  const notify = (): void => {
    update?.call(runState, scheduler.usage());
  };

  /**
   * Fail a node and propagate skip to dependents.
   *
   * Sets the node's runtime to failed with the given error message, then
   * propagates `dep-failed` to all transitive dependents so they become
   * skipped (no fail-fast — independent branches continue).
   */
  function failNode(
    nodeId: string,
    rt: NodeRuntime,
    message: string,
    reason: SkipReason = "dep-failed",
  ): void {
    rt.error = message;
    rt.status = "failed";
    rt.endedAt = Date.now();
    if (audit) {
      audit.nodeFail(nodeId, message);
      propagateSkip(nodeId, runState, reason, successors, (skippedId, skipReason) => {
        audit.nodeSkip(skippedId, skipReason);
      });
    } else {
      propagateSkip(nodeId, runState, reason, successors);
    }
    notify();
  }

  // Mutable node map: seeded from the IR, extended with dynamic fanOut children.
  const nodeMap = new Map<string, IRNode>();
  for (const n of ir.nodes) nodeMap.set(n.id, n);

  // Pre-built adjacency maps from IR edges for O(1) predecessor/successor
  // lookups (instead of scanning all edges each time).
  const successors = buildSuccessorsMap(ir.edges);
  const predecessors = buildPredecessorsMap(ir.edges);

  // Override prompts for nodes whose prompt is dynamically changed (e.g.
  // loop body nodes on transcript-replay iterations). Checked first by
  // {@link buildPrompt}.
  const promptOverrides = new Map<string, string>();

  // In-flight node promises (concurrent execution). Deleted from `.finally`.
  const inFlight = new Map<string, Promise<void>>();

  // ── Closure helpers (close over runState / nodeMap / ir) ──

  /**
   * True when every predecessor of `nodeId` is `completed`.
   * Uses the pre-built reverse adjacency map for O(in-degree) lookups.
   */
  function depsMet(nodeId: string): boolean {
    const predIds = predecessors.get(nodeId);
    if (predIds) {
      for (const pred of predIds) {
        const rt = runState.nodes.get(pred);
        if (!rt || rt.status !== "completed") return false;
      }
    }
    // Also check explicit dependsOn (declared in the DSL node spec).
    const node = nodeMap.get(nodeId);
    if (node?.dependsOn) {
      for (const dep of node.dependsOn) {
        const rt = runState.nodes.get(dep);
        if (!rt || rt.status !== "completed") return false;
      }
    }
    return true;
  }

  /**
   * Expand a fanOut node: rehydrate+invoke its iterate fn against the run state
   * to produce an item array, then create one child IRNode per item via the
   * each fn (applying the resulting NodeSpec — prompt, outputSchema, etc.).
   * Children are named `<fanOutId>-<index>` and added to `nodeMap` + `runState`.
   */
  function expandFanOut(node: IRNode): void {
    if (node.kind !== "fanOut") return;
    const producerRt = runState.nodes.get(node.from);
    if (!producerRt || producerRt.status !== "completed") return;

    const ctx = createNodeCtx(runState, node.id);
    let items: unknown[];
    try {
      const result = rehydrateFn(node.iterateFnRef, ctx);
      items = Array.isArray(result) ? result : [];
    } catch {
      // Iterate fn threw — treat the fanOut as producing zero children.
      items = [];
    }

    for (let i = 0; i < items.length; i++) {
      const childId = `${node.id}-${i}`;
      let spec: Partial<NodeSpec> | null = null;
      try {
        const result: unknown = rehydrateArity(node.eachFnRef, ["item"], [items[i]]);
        if (result !== null && result !== undefined && typeof result === "object") {
          spec = result;
        }
      } catch {
        spec = null;
      }
      if (!spec) continue;

      const childNode: IRNode = {
        id: childId,
        kind: "node",
        agentType: spec.agentType,
        profileRef: spec.profileRef ?? "default",
        prompt: spec.prompt,
        outputSchema: spec.outputSchema,
        dependsOn: spec.dependsOn,
        stage: spec.stage,
        retries: spec.retries,
        timeoutSec: spec.timeoutSec,
        cwd: spec.cwd,
        primitive: { kind: "fanOut-child", meta: { parent: node.id, index: i } },
      };
      nodeMap.set(childId, childNode);
      if (!runState.nodes.has(childId)) {
        runState.nodes.set(childId, {
          status: "pending",
          attempts: 0,
          toolCount: 0,
          filesEdited: [],
        });
      }
    }
  }

  /** Build the final prompt for a node: static `prompt`, or rehydrated `promptFnRef`. */
  function buildPrompt(node: IRNode): string {
    // Check prompt override first (used by loop transcript-replay).
    const override = promptOverrides.get(node.id);
    if (override !== undefined) return override;
    if (node.kind !== "node") return "";
    if (node.promptFnRef) {
      try {
        const ctx = createNodeCtx(runState, node.id);
        const result = rehydrateFn(node.promptFnRef, ctx);
        if (typeof result === "string") return result;
        if (result === undefined || result === null) return "";
        return JSON.stringify(result);
      } catch {
        return node.prompt ?? "";
      }
    }
    return node.prompt ?? "";
  }

  /**
   * Run a single node to a terminal state (completed|failed), handling retries
   * (fresh session each retry per D4). The scheduler slot is already held on
   * entry for the first attempt; retries release, back off, and re-acquire.
   * Never rejects — all errors are captured into node state.
   */
  async function runNode(node: IRNode, schedulable: SchedulableNode): Promise<void> {
    const rt = runState.nodes.get(node.id);
    if (!rt) return;
    const policy = resolvePolicy(node, defaultRetries, retryBackoff);
    // Idempotent handle around the slot acquired before runNode was called.
    // `release()` is a no-op after the first call, so the finally block can
    // release unconditionally on every exit. Re-armed (a fresh handle) after
    // each successful retry re-acquire so the new hold is also covered.
    let slot = slotHandle(scheduler, schedulable);

    try {
      for (;;) {
        // Aborted before/at the start of an attempt: the finally block releases
        // the held slot (the handle is still unreleased here).
        if (signal?.aborted) {
          failNode(node.id, rt, "aborted");
          return;
        }

        rt.attempts += 1;
        const attempt = rt.attempts;
        const prompt = buildPrompt(node);
        const adapter = getAdapter(resolveAgentType(node), node.id);

        const events: NormalizedEvent[] = [];
        const onEvent = (event: NormalizedEvent | null): void => {
          if (event === null) return;
          events.push(event);
          // Real-time telemetry (final values reconciled from `done` below).
          if (event.type === "session") {
            rt.sessionId = event.id;
          } else if (event.type === "tool_call") {
            audit?.nodeTool(node.id, event.name);
          }
          notify();
        };

        let runResult: RunAgentResult | undefined;

        try {
          runResult = await invokeAdapter(adapter, {
            prompt,
            nodeId: node.id,
            attempt,
            cwd: node.cwd,
            signal,
            onEvent,
            onUpdate: notify,
            agentType: resolveAgentType(node),
          });
        } catch (err) {
          // Spawn / process error → non-retryable failure. The held slot is
          // released by the finally block (the handle is still unreleased here).
          failNode(node.id, rt, err instanceof Error ? err.message : String(err));
          return;
        }

        // FIX 2: Abort after run completes but before outcome evaluation → fail the node.
        if (signal?.aborted) {
          failNode(node.id, rt, "aborted");
          return;
        }

        // Release the slot held for this attempt so other nodes may run while
        // we validate / decide on a retry. The handle is idempotent, so the
        // finally block's release becomes a no-op if we exit without retrying.
        slot.release();

        // Synthesize a `done` event when the stream lacks one (e.g. real pi
        // output, which emits message_complete but no done).
        if (!events.some((e) => e.type === "done")) {
          events.push({
            type: "done",
            sessionId: rt.sessionId ?? sessionIdFromEvents(events) ?? "",
            finalText: finalTextFromEvents(events),
            durationMs: 0,
            toolCallCount: toolCountFromEvents(events),
          });
        }

        let outcome = determineOutcome(events);

        // FIX 1: Non-zero exit from subprocess overrides a successful event stream.
        if (
          outcome.succeeded &&
          runResult !== undefined &&
          runResult.exitCode !== null &&
          runResult.exitCode !== 0
        ) {
          outcome = {
            succeeded: false,
            errorMessage: `process exited ${runResult.exitCode}${runResult.stderr ? `: ${runResult.stderr.slice(0, 500)}` : ""}`,
            retryable: false,
          };
        }

        // Reconcile telemetry from the done event (authoritative).
        for (const e of events) {
          if (e.type === "done") {
            rt.finalText = e.finalText;
            if (e.sessionId) rt.sessionId = e.sessionId;
            if (e.costUsd !== undefined) rt.costUsd = e.costUsd;
            rt.toolCount = e.toolCallCount;
            break;
          }
        }
        if (rt.filesEdited.length === 0) {
          rt.filesEdited = fileEditsFromEvents(events);
        }

        if (outcome.succeeded) {
          // ── Output-schema post-hoc validation (D2 fallback) ──
          const schemaEntry = ir.schemas[node.id];
          const schemaRaw =
            schemaEntry !== undefined
              ? schemaEntry
              : node.outputSchema !== undefined && node.outputSchema !== true
                ? node.outputSchema
                : undefined;

          if (schemaRaw !== undefined) {
            const validation = validateNodeOutput(rt.finalText, schemaRaw);
            if (validation.ok) {
              rt.parsedOutput = validation.parsed;
              rt.status = "completed";
              rt.endedAt = Date.now();
              audit?.nodeComplete(node.id, {
                sessionId: rt.sessionId,
                durationMs: rt.endedAt - (rt.startedAt ?? rt.endedAt),
                toolCount: rt.toolCount,
              });
              notify();
              return;
            }
            // Schema failure → retryable (fresh session), else fail.
            rt.error = validation.error;
            if (shouldRetry(policy, attempt - 1)) {
              audit?.nodeRetry(node.id, attempt, rt.error);
              await sleep(backoffMs(policy, attempt));
              // Re-acquire slots for the next attempt (may contend with others).
              if (!(await scheduler.acquire(schedulable, signal))) {
                failNode(node.id, rt, rt.error);
                return;
              }
              slot = slotHandle(scheduler, schedulable); // re-arm for the new hold
              continue;
            }
            failNode(node.id, rt, rt.error);
            return;
          }

          rt.status = "completed";
          rt.endedAt = Date.now();
          audit?.nodeComplete(node.id, {
            sessionId: rt.sessionId,
            durationMs: rt.endedAt - (rt.startedAt ?? rt.endedAt),
            toolCount: rt.toolCount,
          });
          notify();
          return;
        }

        // ── Error outcome ──
        rt.error = outcome.errorMessage ?? "Unknown error";
        if (outcome.retryable && shouldRetry(policy, attempt - 1)) {
          audit?.nodeRetry(node.id, attempt, rt.error);
          await sleep(backoffMs(policy, attempt));
          if (!(await scheduler.acquire(schedulable, signal))) {
            failNode(node.id, rt, rt.error);
            return;
          }
          slot = slotHandle(scheduler, schedulable); // re-arm for the new hold
          continue;
        }

        failNode(node.id, rt, rt.error);
        return;
      }
    } finally {
      slot.release();
    }
  }

  /**
   * Acquire scheduler slots for a node and set it to `running`, then delegate
   * to {@link runNode}. Unconditionally sets the node's status to `running`
   * before invoking runNode (which owns the remainder of the lifecycle).
   */
  async function runNodeWrapper(node: IRNode): Promise<void> {
    const resolved = resolveProfileSync(
      (node as { profileRef?: string }).profileRef ?? "default",
      options.profiles ?? {},
    );
    const schedulable: SchedulableNode = {
      agentType: resolveAgentType(node),
      provider: resolved?.profile.provider,
      model: resolved?.profile.model,
    };
    if (!(await scheduler.acquire(schedulable, signal))) return;
    const rt = runState.nodes.get(node.id);
    if (rt) rt.status = "running";
    if (rt?.startedAt === undefined && rt) rt.startedAt = Date.now();
    audit?.nodeStart(node.id);
    return runNode(node, schedulable);
  }

  // Create the dispatch context for cond/loop helpers.
  const loopDispatch: LoopDispatch = {
    runState,
    nodeMap,
    ir,
    scheduler,
    signal,
    promptOverrides,
    runNodeWrapper,
    buildPrompt,
    getAdapter,
    resolveAgentType,
    createNodeCtx,
    rehydrateFn,
    failNode,
    notify,
  };

  /**
   * Execute a reduce node: gather member outputs and synthesize them.
   *
   * Two paths:
   *   1. Profile present → agent-run synthesis: resolve the profile, get the
   *      adapter, build a merge prompt, and dispatch to the adapter.
   *   2. No profile → pure-JS merge: rehydrate the merge fn (if any) or
   *      deep-merge member outputs.
   *
   * For council nodes (primitive.kind === "council"), the instruction prompt
   * from the council's synthesize spec (primitive.meta.prompt) is passed to
   * executeSynthesis so the merge prompt includes the user's custom
   * instruction alongside member outputs.
   *
   * SAFETY: The `executeSynthesis` call is wrapped in try/catch so that an
   * adapter-level throw (buildInvocation / runAgent spawn / emitEvents) is
   * captured into node state (failed + propagateSkip) instead of propagating
   * through the reduce promise, which would cause executeDAG to reject with
   * the node stuck in "running" (never failed/propagateSkip).
   */
  async function executeReduceNode(node: IRNode): Promise<void> {
    if (node.kind !== "reduce") return;
    const reduceNode = node;
    const rt = runState.nodes.get(node.id);
    if (!rt) return;

    const ctx = createNodeCtx(runState, node.id);

    // Extract the custom instruction prompt from primitive metadata.
    const instructionPrompt =
      node.primitive?.meta && typeof node.primitive.meta === "object"
        ? node.primitive.meta["prompt"]
        : undefined;

    let result: Awaited<ReturnType<typeof executeSynthesis>>;
    try {
      // Resolve the profile for agent-run synthesis.
      // (Moved inside try so every throw routes through failNode.)
      let adapter: AgentAdapter | undefined;
      if (reduceNode.profileRef) {
        const resolved = resolveProfileSync(reduceNode.profileRef, options.profiles ?? {});
        if (resolved) {
          const agentType = reduceNode.agentType ?? DEFAULT_AGENT_TYPE;
          adapter = getAdapter(agentType, node.id);
        }
      }

      result = await executeSynthesis({
        ctx,
        from: reduceNode.from,
        adapter,
        signal,
        agentType: reduceNode.agentType,
        instructionPrompt: typeof instructionPrompt === "string" ? instructionPrompt : undefined,
      });
    } catch (err) {
      // Adapter-level throw (buildInvocation / runAgent spawn / emitEvents,
      // or resolveProfileSync / getAdapter throw).
      failNode(node.id, rt, err instanceof Error ? err.message : String(err));
      return;
    }

    if (result.error) {
      rt.error = result.error.message;
      rt.status = "failed";
      rt.endedAt = Date.now();
      audit?.nodeFail(node.id, rt.error ?? "reduce node failed");
      propagateSkip(
        node.id,
        runState,
        "dep-failed",
        successors,
        audit
          ? (skippedId, skipReason) => {
              audit.nodeSkip(skippedId, skipReason);
            }
          : undefined,
      );
      notify();
      return;
    }

    // Success: set the node's output.
    const output = result.output;
    rt.finalText = typeof output === "string" ? output : JSON.stringify(output, null, 2);
    rt.parsedOutput = output;
    rt.status = "completed";
    rt.endedAt = Date.now();
    notify();
  }

  // ── Main execution loop ─────────────────────────────────

  for (;;) {
    if (signal?.aborted) break;

    let progressed = false;

    // Snapshot current node ids ONCE per outer-loop iteration (for phases
    // 1, 2a, and 2b below) to avoid re-spreading on every phase.
    const nodeIds = [...nodeMap.keys()];

    // ── Phase 1: mark pending → ready where deps are met ──
    for (const id of nodeIds) {
      const rt = runState.nodes.get(id);
      if (!rt || rt.status !== "pending") continue;
      if (depsMet(id)) {
        rt.status = "ready";
        progressed = true;
      }
    }

    // ── Phase 2a: Process structural nodes (cond / loop) BEFORE regular nodes ──
    // This ensures cond/loop handlers can claim their subgraph nodes before
    // Phase 2b schedules them independently.
    for (const id of nodeIds) {
      if (signal?.aborted) break;
      const rt = runState.nodes.get(id);
      if (!rt || rt.status !== "ready" || inFlight.has(id)) continue;
      const node = nodeMap.get(id);
      if (!node) continue;

      if (node.kind === "cond") {
        evaluateCond(node, loopDispatch);
        progressed = true;
        continue;
      }

      if (node.kind === "loop") {
        // Launch the loop handler as an in-flight promise (just like runNode
        // for regular nodes).
        const loopPromise = executeLoop(node, loopDispatch);
        inFlight.set(id, loopPromise);
        loopPromise
          .finally(() => {
            inFlight.delete(id);
          })
          .catch(() => {
            // executeLoop never rejects (errors are captured into node state).
          });
        progressed = true;
        continue;
      }
      // Other structural kinds (reduce, parallel, sequence) are handled
      // in Phase 2b as placeholders.
    }

    // ── Phase 2b: Process remaining ready nodes (fanOut / node / other) ──
    for (const id of nodeIds) {
      if (signal?.aborted) break;
      const rt = runState.nodes.get(id);
      if (!rt || rt.status !== "ready" || inFlight.has(id)) continue;
      const node = nodeMap.get(id);
      if (!node) continue;

      // Lazy fanOut expansion at ready-time.
      if (node.kind === "fanOut") {
        expandFanOut(node);
        rt.status = "completed";
        if (rt.startedAt === undefined) rt.startedAt = Date.now();
        rt.endedAt = Date.now();
        progressed = true;
        continue;
      }

      // Reduce / council node: wire executeSynthesis.
      // Gathers member outputs and either merges them in-process (pure-JS)
      // or dispatches to an agent via the adapter.
      if (node.kind === "reduce") {
        // Check all members are completed before synthesizing.
        const allCompleted = node.from.every((memberId) => {
          const memberRt = runState.nodes.get(memberId);
          return memberRt && memberRt.status === "completed";
        });
        if (!allCompleted) continue;

        // For agent-run synthesis (profileRef present), acquire scheduler
        // slots (AND semantics) to respect concurrency limits. Pure-JS
        // merge (no adapter, synchronous CPU) skips the slot.
        let schedulable: SchedulableNode | undefined;
        if (node.profileRef) {
          const resolved = resolveProfileSync(node.profileRef, options.profiles ?? {});
          schedulable = {
            agentType: resolveAgentType(node),
            provider: resolved?.profile.provider,
            model: resolved?.profile.model,
          };
          if (!scheduler.tryAcquire(schedulable)) continue;
        }

        rt.status = "running";
        if (rt.startedAt === undefined) rt.startedAt = Date.now();
        const reducePromise = executeReduceNode(node)
          .finally(() => {
            inFlight.delete(id);
            if (schedulable) scheduler.release(schedulable);
          })
          .catch(() => {
            // executeReduceNode never rejects (errors are captured into
            // node state via try/catch + failNode).
          });
        inFlight.set(id, reducePromise);
        progressed = true;
        continue;
      }

      // Other structural kinds (parallel/sequence) complete as placeholders
      // so their dependents unblock.
      if (node.kind !== "node") {
        rt.status = "completed";
        if (rt.startedAt === undefined) rt.startedAt = Date.now();
        rt.endedAt = Date.now();
        progressed = true;
        continue;
      }

      // Plain node: acquire scheduler slots (AND semantics) before launching.
      const resolved = resolveProfileSync(node.profileRef ?? "default", options.profiles ?? {});
      const schedulable: SchedulableNode = {
        agentType: resolveAgentType(node),
        provider: resolved?.profile.provider,
        model: resolved?.profile.model,
      };
      if (!scheduler.tryAcquire(schedulable)) continue; // stays ready; retried next pass

      rt.status = "running";
      if (rt.startedAt === undefined) rt.startedAt = Date.now();
      const runPromise = runNode(node, schedulable).finally(() => {
        inFlight.delete(id);
      });
      inFlight.set(id, runPromise);
      progressed = true;
    }

    notify();

    if (signal?.aborted) break;

    // ── Phase 3: await the first in-flight completion, or terminate ──
    if (inFlight.size > 0) {
      await Promise.race(inFlight.values());
      update?.flush();
    } else if (!progressed) {
      // Nothing ready/schedulable and nothing running → the run is finished.
      break;
    }
    // else: progressed (e.g. structural nodes completed or fanOut expanded) but
    // nothing launched this pass → loop again to pick up newly-ready children.
  }

  // Drain any in-flight coroutines so executeDAG settles fully on abort.
  await Promise.allSettled([...inFlight.values()]);

  update?.flush();

  // ── Build and return RunSummary ──────────────────────────
  const nodeEntries = Array.from(runState.nodes.entries());
  return {
    runId: runState.runId,
    nodes: nodeEntries.map(([id, rt]) => summarizeNode(id, rt)),
    totals: computeTotals(nodeEntries),
  };
}
