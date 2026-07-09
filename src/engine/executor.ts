/**
 * DAG executor core — orchestrator (RISK step / kb-14).
 *
 * Executes a compiled GraphIR against the provided RunState, orchestrating
 * per-node adapter invocations, concurrency-pool scheduling (AND semantics),
 * lazy fanOut expansion at ready-time, output-schema post-hoc validation,
 * retry/skip propagation (no fail-fast), and RunSummary generation.
 *
 * The per-node lifecycle, fanOut expansion, and reduce/synthesis logic live in
 * companion modules (`run-node.ts`, `fanout.ts`, `reduce-node.ts`) and share
 * mutable state via an {@link ExecutorContext} bundle (defined in
 * `executor-types.ts`). This file owns only the orchestration: building the
 * context, the main scheduling loop, and the RunSummary.
 *
 * The executor is adapter-agnostic: it checks for the FakeAgentAdapter
 * duck-typing signal (`adapter.emitEvents`) and calls it directly when present
 * (no subprocess), otherwise falls back to the child-process spawner via
 * `invokeAdapter`.
 *
 * ### Concurrency model
 * Independent ready nodes whose scheduler pools have capacity are launched
 * concurrently (one in-flight promise per node). The main loop awaits the
 * FIRST in-flight completion via `Promise.race`, then re-evaluates readiness,
 * fanOut expansion, and schedulability. A node that cannot acquire its slots
 * remains `ready` and is retried on a subsequent pass once capacity frees. This
 * is what makes the layered concurrency pools meaningful.
 *
 * ### State machine
 * ```
 * pending ──(all deps met)──→ ready ──(tryAcquire)──→ running ──(done)──→ completed
 *                              │                          │
 *                              │                          └──(error/schema-fail + shouldRetry)──→ running (fresh session)
 *                              │                          └──(exhausted)──→ failed ──→ dependents → skipped
 *                              └──(tryAcquire fails)──→ ready (waits for capacity)
 * ```
 */

import type { AgentAdapter } from "../adapters/types.js";
import type { AuditLogger } from "../run/audit.js";
import type { Scheduler, SchedulableNode } from "./scheduler.js";
import type { GraphIR, IRNode, NodeRuntime, PoolUsage, RunState } from "../types.js";
import type { ResolveOptions } from "../profiles/resolve.js";
import { debounce } from "../utils.js";
import { CONFIG_DEFAULTS, ABORT_DRAIN_TIMEOUT_MS } from "../constants.js";
import { resolveProfileSync } from "../profiles/resolve.js";
import { buildSuccessorsMap, buildPredecessorsMap } from "./retry.js";
import { rehydrateFn } from "../dsl/fn-serialize.js";
import { createNodeCtx, resolveReduceFrom } from "./context.js";
import { evaluateCond, executeLoop, type LoopDispatch } from "./loop.js";
import { summarizeNode, computeTotals, type RunSummary } from "./events.js";
import type { ExecutorContext } from "./executor-types.js";
import { resolveAgentType } from "./executor-types.js";
import { expandFanOut } from "./fanout.js";
import { runNode, buildPrompt, failNode, skipNode, depsMet } from "./run-node.js";
import { executeReduceNode } from "./reduce-node.js";

// ─── Public types ─────────────────────────────────────────────────

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
   * Absolute path to the run directory. When set, each agent node's session
   * transcript is persisted to `<runDir>/sessions/<sessionId>.json` on
   * completion (success or failure). Omitted in tests that don't write to disk.
   */
  runDir?: string;
  /**
   * Optional audit logger for per-node lifecycle events (start, tool, retry,
   * complete, fail, skip). When provided, node-level events are emitted to
   * the audit log as the node runs.
   */
  audit?: AuditLogger;
  /**
   * Override for the post-loop in-flight drain timeout in ms (default:
   * {@link ABORT_DRAIN_TIMEOUT_MS}). Bounds the trailing
   * `Promise.allSettled` so an adapter that ignores the abort signal and
   * never settles cannot hang executeDAG forever.
   */
  abortDrainTimeoutMs?: number;
}

/** Coalesce rapid `onUpdate` calls into a single TUI re-render. */
const UPDATE_DEBOUNCE_MS = 50;

// ─── Scheduling-loop phase helpers ────────────────────────────────

/**
 * Mark `pending` nodes whose dependencies are all `completed` as `ready`.
 * Returns whether any node became ready this pass.
 */
function markReadyNodes(ctx: ExecutorContext, nodeIds: string[]): boolean {
  let progressed = false;
  for (const id of nodeIds) {
    const rt = ctx.runState.nodes.get(id);
    if (!rt || rt.status !== "pending") continue;
    if (depsMet(ctx, id)) {
      rt.status = "ready";
      progressed = true;
    }
  }
  return progressed;
}

/**
 * Phase 2a: process ready structural nodes (cond / loop) BEFORE regular nodes,
 * so cond/loop handlers claim their subgraph nodes before Phase 2b schedules
 * them independently. Returns whether any structural node was handled.
 */
function dispatchStructuralNodes(
  ctx: ExecutorContext,
  loopDispatch: LoopDispatch,
  nodeIds: string[],
): boolean {
  let progressed = false;
  for (const id of nodeIds) {
    if (ctx.signal?.aborted) break;
    const rt = ctx.runState.nodes.get(id);
    if (!rt || rt.status !== "ready" || ctx.inFlight.has(id)) continue;
    const node = ctx.nodeMap.get(id);
    if (!node) continue;

    if (node.kind === "cond") {
      evaluateCond(node, loopDispatch);
      progressed = true;
      continue;
    }
    if (node.kind === "loop") {
      // Launch the loop handler as an in-flight promise (like runNode).
      const loopPromise = executeLoop(node, loopDispatch);
      ctx.inFlight.set(id, loopPromise);
      loopPromise
        .finally(() => {
          ctx.inFlight.delete(id);
        })
        .catch(() => {
          // executeLoop never rejects (errors are captured into node state).
        });
      progressed = true;
    }
  }
  return progressed;
}

/** Build a schedulable descriptor (agentType / provider / model) for a node. */
function schedulableFor(ctx: ExecutorContext, node: IRNode): SchedulableNode {
  const profileRef = (node as { profileRef?: string }).profileRef ?? "default";
  const resolved = resolveProfileSync(profileRef, ctx.options.profiles ?? {});
  return {
    agentType: resolveAgentType(node),
    provider: resolved?.profile.provider,
    model: resolved?.profile.model,
  };
}

/**
 * Launch a reduce node: requires all members completed; the agent-run path
 * (profileRef present) acquires a scheduler slot to respect concurrency limits.
 */
function scheduleReduceNode(
  ctx: ExecutorContext,
  node: IRNode & { kind: "reduce" },
  rt: NodeRuntime,
): boolean {
  // Expand any fanOut-parent ids in `from` to their dynamic children so the
  // gate waits for the children (not the parent, which completes the instant
  // it expands) and so a failed/skipped child propagates to this reduce.
  const members = resolveReduceFrom(ctx.runState, ctx.nodeMap, node.from);
  let failedMember: string | undefined;
  const allCompleted = members.every((memberId) => {
    const memberRt = ctx.runState.nodes.get(memberId);
    if (memberRt && (memberRt.status === "failed" || memberRt.status === "skipped")) {
      failedMember ??= memberId;
    }
    return Boolean(memberRt && memberRt.status === "completed");
  });
  // An upstream member (e.g. a fanOut child) failed/skipped → skip this reduce
  // and propagate to its dependents, mirroring dep-edge skip propagation.
  if (failedMember !== undefined) {
    skipNode(
      ctx,
      node.id,
      rt,
      `upstream reduce member "${failedMember}" did not complete`,
      "dep-failed",
    );
    return true;
  }
  if (!allCompleted) return false;

  // Agent-run synthesis (profileRef) respects concurrency via a slot; pure-JS
  // merge (no adapter, synchronous CPU) skips it.
  let schedulable: SchedulableNode | undefined;
  if (node.profileRef) {
    schedulable = schedulableFor(ctx, node);
    if (!ctx.scheduler.tryAcquire(schedulable)) return false;
  }

  rt.status = "running";
  if (rt.startedAt === undefined) rt.startedAt = Date.now();
  const reducePromise = executeReduceNode(ctx, node)
    .finally(() => {
      ctx.inFlight.delete(node.id);
      if (schedulable) ctx.scheduler.release(schedulable);
    })
    .catch(() => {
      // executeReduceNode never rejects (errors captured via try/catch + failNode).
    });
  ctx.inFlight.set(node.id, reducePromise);
  return true;
}

/** Acquire slots and launch a plain node; returns false when it must stay ready. */
function schedulePlainNode(ctx: ExecutorContext, node: IRNode, rt: NodeRuntime): boolean {
  const schedulable = schedulableFor(ctx, node);
  if (!ctx.scheduler.tryAcquire(schedulable)) return false; // stays ready; retried next pass

  rt.status = "running";
  if (rt.startedAt === undefined) rt.startedAt = Date.now();
  const runPromise = runNode(ctx, node, schedulable).finally(() => {
    ctx.inFlight.delete(node.id);
  });
  ctx.inFlight.set(node.id, runPromise);
  return true;
}

/**
 * Phase 2b: process a single ready node — fanOut (lazy expand), reduce
 * (synthesis), other structural kinds (placeholder completion), or a plain
 * node (scheduler-gated launch). Returns whether the pass made progress on
 * this node (a node that must wait returns false and is retried next pass).
 */
function scheduleReadyNode(ctx: ExecutorContext, id: string): boolean {
  const rt = ctx.runState.nodes.get(id);
  if (!rt || rt.status !== "ready" || ctx.inFlight.has(id)) return false;
  const node = ctx.nodeMap.get(id);
  if (!node) return false;

  // Lazy fanOut expansion at ready-time.
  if (node.kind === "fanOut") {
    ctx.audit?.nodeStart(node.id);
    const childCount = expandFanOut(ctx, node);
    rt.status = "completed";
    if (rt.startedAt === undefined) rt.startedAt = Date.now();
    rt.endedAt = Date.now();
    ctx.audit?.nodeComplete(node.id, {
      durationMs: rt.endedAt - rt.startedAt,
      childCount,
    });
    return true;
  }

  if (node.kind === "reduce") {
    return scheduleReduceNode(ctx, node, rt);
  }

  // Other structural kinds (parallel/sequence) complete as placeholders so
  // their dependents unblock.
  if (node.kind !== "node") {
    ctx.audit?.nodeStart(node.id);
    rt.status = "completed";
    if (rt.startedAt === undefined) rt.startedAt = Date.now();
    rt.endedAt = Date.now();
    ctx.audit?.nodeComplete(node.id, { durationMs: rt.endedAt - rt.startedAt });
    return true;
  }

  return schedulePlainNode(ctx, node, rt);
}

/** Minimal shape of the debounced onUpdate controller used by the main loop. */
type UpdateController = {
  call(runState: RunState, poolUsage: PoolUsage): void;
  flush(): void;
};

/**
 * Run the concurrent, scheduler-gated main loop to completion (or abort).
 *
 * Each pass: mark newly-ready nodes, dispatch structural nodes, launch ready
 * nodes, then await the first in-flight completion before re-evaluating.
 * Terminates when nothing is ready/schedulable and nothing is in flight.
 */
async function runMainLoop(
  ctx: ExecutorContext,
  loopDispatch: LoopDispatch,
  update: UpdateController | undefined,
): Promise<void> {
  for (;;) {
    if (ctx.signal?.aborted) break;

    const nodeIds = [...ctx.nodeMap.keys()];
    let progressed = false;
    if (markReadyNodes(ctx, nodeIds)) progressed = true;
    if (dispatchStructuralNodes(ctx, loopDispatch, nodeIds)) progressed = true;
    for (const id of nodeIds) {
      if (ctx.signal?.aborted) break;
      if (scheduleReadyNode(ctx, id)) progressed = true;
    }

    ctx.notify();
    if (ctx.signal?.aborted) break;

    // Await the first in-flight completion, or terminate when finished.
    if (ctx.inFlight.size > 0) {
      await Promise.race(ctx.inFlight.values());
      update?.flush();
    } else if (!progressed) {
      break;
    }
    // else: progressed this pass but nothing launched → loop again to pick up
    // newly-ready children (e.g. fanOut expansion).
  }
}

/**
 * Acquire scheduler slots for a node and set it `running`, then delegate to
 * {@link runNode}. Used by cond/loop dispatch (async acquire, blocking); the
 * main loop uses `tryAcquire` directly for plain nodes. Unconditionally sets
 * the node `running` before invoking runNode (which owns the rest of the
 * lifecycle).
 */
async function runNodeWrapper(ctx: ExecutorContext, node: IRNode): Promise<void> {
  const schedulable = schedulableFor(ctx, node);
  if (!(await ctx.scheduler.acquire(schedulable, ctx.signal))) return;
  const rt = ctx.runState.nodes.get(node.id);
  if (rt) rt.status = "running";
  if (rt && rt.startedAt === undefined) rt.startedAt = Date.now();
  return runNode(ctx, node, schedulable);
}

/**
 * Drain in-flight coroutines so executeDAG settles fully on abort. Bounded by a
 * timeout: a misbehaving adapter that ignores the abort signal could leave an
 * in-flight promise that never settles. On timeout, warn and give up.
 */
async function drainInFlight(
  inFlight: Map<string, Promise<void>>,
  abortDrainTimeoutMs: number | undefined,
): Promise<void> {
  const drainTimeoutMs = abortDrainTimeoutMs ?? ABORT_DRAIN_TIMEOUT_MS;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drainTimeout = new Promise<"timeout">((resolve) => {
    drainTimer = setTimeout(() => {
      resolve("timeout");
    }, drainTimeoutMs);
  });
  const drainResult = await Promise.race([
    Promise.allSettled([...inFlight.values()]).then(() => "settled" as const),
    drainTimeout,
  ]);
  if (drainTimer) clearTimeout(drainTimer);
  if (drainResult === "timeout") {
    console.warn(
      `[wisp] executeDAG: in-flight drain timed out after ${drainTimeoutMs}ms with ${inFlight.size} promise(s) still unsettled; giving up`,
    );
  }
}

// ─── Main entry point ─────────────────────────────────────────────

/**
 * Execute a compiled DAG against the given run state.
 *
 * Builds an {@link ExecutorContext} bundling the shared mutable state, wires a
 * {@link LoopDispatch} for cond/loop helpers, runs the concurrent main loop,
 * drains any in-flight coroutines, and returns a {@link RunSummary} with
 * per-node results and aggregate totals.
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

  // Mutable node map (seeded from IR, extended with dynamic fanOut children)
  // and pre-built adjacency maps for O(1) predecessor/successor lookups.
  const nodeMap = new Map<string, IRNode>();
  for (const n of ir.nodes) nodeMap.set(n.id, n);
  const successors = buildSuccessorsMap(ir.edges);
  const predecessors = buildPredecessorsMap(ir.edges);
  const promptOverrides = new Map<string, string>();
  const inFlight = new Map<string, Promise<void>>();

  const ctx: ExecutorContext = {
    ir,
    runState,
    nodeMap,
    successors,
    predecessors,
    promptOverrides,
    inFlight,
    scheduler,
    signal,
    audit,
    defaultRetries,
    retryBackoff,
    options,
    notify,
    getAdapter,
  };

  // Dispatch context for cond/loop helpers — binds the extracted functions to ctx.
  const loopDispatch: LoopDispatch = {
    runState,
    nodeMap,
    ir,
    scheduler,
    signal,
    promptOverrides,
    runNodeWrapper: (node) => runNodeWrapper(ctx, node),
    buildPrompt: (node) => buildPrompt(ctx, node),
    getAdapter,
    resolveAgentType,
    createNodeCtx,
    rehydrateFn,
    failNode: (nodeId, rt, message) => {
      failNode(ctx, nodeId, rt, message);
    },
    audit: ctx.audit,
    notify,
  };

  await runMainLoop(ctx, loopDispatch, update);
  await drainInFlight(inFlight, options.abortDrainTimeoutMs);
  update?.flush();

  const nodeEntries = Array.from(runState.nodes.entries());
  return {
    runId: runState.runId,
    nodes: nodeEntries.map(([id, rt]) => summarizeNode(id, rt)),
    totals: computeTotals(nodeEntries),
  };
}
