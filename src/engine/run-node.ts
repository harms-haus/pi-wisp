/**
 * Per-node execution lifecycle (split from executor.ts).
 *
 * Extracted from the closures inside `executeDAG`. Each function receives an
 * {@link ExecutorContext} as its first argument instead of closing over
 * `executeDAG` locals:
 *
 *   - {@link depsMet} — every predecessor + declared dependsOn completed
 *   - {@link buildPrompt} — override > promptFn > static prompt
 *   - {@link failNode} — fail + propagate skip + audit
 *   - {@link runNode} — full attempt lifecycle (retries, abort, schema
 *     validation, the idempotent slot-release invariant)
 *
 * @module
 */

import type { ExecutorContext, NodeOutcome } from "./executor-types.js";
import { resolveAgentType, determineOutcome, validateNodeOutput, sleep } from "./executor-types.js";
import type { IRNode, NodeRuntime, NormalizedEvent } from "../types.js";
import type { SchedulableNode, Scheduler } from "./scheduler.js";
import type { RunAgentResult } from "../spawn/spawner.js";
import { resolvePolicy, shouldRetry, backoffMs, propagateSkip, type SkipReason } from "./retry.js";
import { rehydrateFn } from "../dsl/fn-serialize.js";
import { resolveProfileSync } from "../profiles/resolve.js";
import { writeSession, type PersistedSession } from "../run/sessions.js";
import { createNodeCtx } from "./context.js";
import {
  invokeAdapter,
  finalTextFromEvents,
  sessionIdFromEvents,
  toolCountFromEvents,
  fileEditsFromEvents,
} from "./events.js";

// ─── Dependency readiness ─────────────────────────────────────────

/**
 * True when every predecessor of `nodeId` is `completed`.
 *
 * Checks both edge predecessors (from the reverse adjacency map) and the
 * node's declared `dependsOn` list. O(in-degree) per call.
 */
export function depsMet(ctx: ExecutorContext, nodeId: string): boolean {
  const predIds = ctx.predecessors.get(nodeId);
  if (predIds) {
    for (const pred of predIds) {
      const rt = ctx.runState.nodes.get(pred);
      if (!rt || rt.status !== "completed") return false;
    }
  }
  const node = ctx.nodeMap.get(nodeId);
  if (node?.dependsOn) {
    for (const dep of node.dependsOn) {
      const rt = ctx.runState.nodes.get(dep);
      if (!rt || rt.status !== "completed") return false;
    }
  }
  return true;
}

// ─── Prompt construction ──────────────────────────────────────────

/**
 * Build the final prompt for a node.
 *
 * Priority: a prompt override (used by loop transcript-replay) wins; otherwise a
 * rehydrated `promptFnRef` (string returned as-is, other values JSON-stringified,
 * undefined/null → ""); otherwise the static `prompt`. A thrown prompt fn falls
 * back to the static prompt. Non-`node` kinds return "".
 */
export function buildPrompt(ctx: ExecutorContext, node: IRNode): string {
  const override = ctx.promptOverrides.get(node.id);
  if (override !== undefined) return override;
  if (node.kind !== "node") return "";
  if (node.promptFnRef) {
    try {
      const nodeCtx = createNodeCtx(ctx.runState, node.id);
      const result = rehydrateFn(node.promptFnRef, nodeCtx);
      if (typeof result === "string") return result;
      if (result === undefined || result === null) return "";
      return JSON.stringify(result);
    } catch {
      return node.prompt ?? "";
    }
  }
  return node.prompt ?? "";
}

// ─── Failure + skip propagation ───────────────────────────────────

/**
 * Fail a node and propagate skip to its transitive dependents.
 *
 * Sets the node's runtime to `failed` with the given message, then propagates
 * `reason` (default `"dep-failed"`) to all transitive dependents so they become
 * skipped — no fail-fast; independent branches continue. Emits audit events
 * when an audit logger is present.
 */
export function failNode(
  ctx: ExecutorContext,
  nodeId: string,
  rt: NodeRuntime,
  message: string,
  reason: SkipReason = "dep-failed",
): void {
  rt.error = message;
  rt.status = "failed";
  rt.endedAt = Date.now();
  const audit = ctx.audit;
  if (audit) {
    audit.nodeFail(nodeId, message);
    propagateSkip(nodeId, ctx.runState, reason, ctx.successors, (skippedId, skipReason) => {
      audit.nodeSkip(skippedId, skipReason);
    });
  } else {
    propagateSkip(nodeId, ctx.runState, reason, ctx.successors);
  }
  ctx.notify();
}

/**
 * Skip a node and propagate skip to its transitive dependents.
 *
 * Like {@link failNode} but marks `nodeId` itself as `skipped` (it never ran)
 * rather than `failed`. Used when a node cannot run because an upstream member
 * it depends on indirectly (e.g. a fanOut child feeding a reduce) failed or was
 * skipped — mirroring the `skipped` status a direct dep edge would produce via
 * {@link propagateSkip}. Completed dependents are left untouched.
 */
export function skipNode(
  ctx: ExecutorContext,
  nodeId: string,
  rt: NodeRuntime,
  message: string,
  reason: SkipReason = "dep-failed",
): void {
  rt.error = message;
  rt.status = "skipped";
  rt.endedAt = Date.now();
  const audit = ctx.audit;
  const queue: string[] = [...(ctx.successors.get(nodeId) ?? [])];
  const visited = new Set<string>([nodeId]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const srt = ctx.runState.nodes.get(current);
    if (srt) {
      if (srt.status === "completed") continue;
      srt.status = "skipped";
      srt.error = reason;
      if (audit) audit.nodeSkip(current, reason);
    }
    queue.push(...(ctx.successors.get(current) ?? []));
  }
  if (audit) audit.nodeSkip(nodeId, reason);
  ctx.notify();
}

// ─── Slot handle ──────────────────────────────────────────────────

/**
 * Idempotent handle to a held scheduler slot.
 *
 * `release()` decrements the slot's pools exactly once, regardless of how many
 * times it is called. This lets {@link runNode} release unconditionally from a
 * `finally` block on every exit without tracking whether the slot was already
 * released inline. After the slot is released mid-attempt (before a retry
 * backoff) and re-acquired, a fresh handle guards the new hold.
 */
interface SlotHandle {
  release(): void;
}

/** Wrap a slot the caller already holds in an idempotent {@link SlotHandle}. */
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

// ─── runNode helpers ──────────────────────────────────────────────

/**
 * Inject a synthetic `done` event when the adapter stream lacks one (e.g. real
 * pi output, which emits `message_complete` but no `done`). Telemetry is
 * reconciled from this event later.
 */
function synthesizeDoneIfMissing(events: NormalizedEvent[], rt: NodeRuntime): void {
  if (events.some((e) => e.type === "done")) return;
  events.push({
    type: "done",
    sessionId: rt.sessionId ?? sessionIdFromEvents(events) ?? "",
    finalText: finalTextFromEvents(events),
    durationMs: 0,
    toolCallCount: toolCountFromEvents(events),
  });
}

/**
 * A non-zero subprocess exit code overrides a successful event stream as a
 * non-retryable failure (the process crashed even though the parsed events
 * looked benign).
 */
function applyExitCodeOverride(
  outcome: NodeOutcome,
  runResult: RunAgentResult | undefined,
): NodeOutcome {
  if (
    outcome.succeeded &&
    runResult !== undefined &&
    runResult.exitCode !== null &&
    runResult.exitCode !== 0
  ) {
    return {
      succeeded: false,
      errorMessage: `process exited ${runResult.exitCode}${runResult.stderr ? `: ${runResult.stderr.slice(0, 500)}` : ""}`,
      retryable: false,
    };
  }
  return outcome;
}

/** Reconcile telemetry fields from the (authoritative) `done` event. */
function reconcileTelemetryFromEvents(rt: NodeRuntime, events: NormalizedEvent[]): void {
  for (const e of events) {
    if (e.type === "done") {
      rt.finalText = e.finalText;
      if (e.sessionId) rt.sessionId = e.sessionId;
      if (e.costUsd !== undefined) rt.costUsd = e.costUsd;
      rt.toolCount = e.toolCallCount;
      break;
    }
  }
}

/** Resolve the post-hoc output schema for a node (`ir.schemas` wins over `node.outputSchema`). */
function resolveOutputSchema(ctx: ExecutorContext, node: IRNode): unknown {
  const schemaEntry = ctx.ir.schemas[node.id];
  if (schemaEntry !== undefined) return schemaEntry;
  return node.outputSchema !== undefined && node.outputSchema !== true
    ? node.outputSchema
    : undefined;
}

/** Mark a node completed and emit the audit event. */
function completeNode(ctx: ExecutorContext, node: IRNode, rt: NodeRuntime): void {
  rt.status = "completed";
  rt.endedAt = Date.now();
  ctx.audit?.nodeComplete(node.id, {
    sessionId: rt.sessionId,
    durationMs: rt.endedAt - (rt.startedAt ?? rt.endedAt),
    toolCount: rt.toolCount,
  });
  ctx.notify();
}

/** Outcome of a single attempt's post-run decision. */
type AttemptResolution = "retry" | "done";

/**
 * Re-acquire scheduler slots for a retry after backoff.
 *
 * Returns `true` when the re-acquire succeeded (caller re-arms its slot handle
 * and continues the retry loop); `false` when the run is terminal (acquire
 * failed under abort, or retries exhausted) — in which case the node is failed.
 */
async function acquireForRetry(
  ctx: ExecutorContext,
  node: IRNode,
  rt: NodeRuntime,
  schedulable: SchedulableNode,
  attempt: number,
  retryable: boolean,
): Promise<boolean> {
  const policy = resolvePolicy(node, ctx.defaultRetries, ctx.retryBackoff);
  if (!retryable || !shouldRetry(policy, attempt - 1)) {
    failNode(ctx, node.id, rt, rt.error ?? "Unknown error");
    return false;
  }
  ctx.audit?.nodeRetry(node.id, attempt, rt.error);
  await sleep(backoffMs(policy, attempt));
  if (!(await ctx.scheduler.acquire(schedulable, ctx.signal))) {
    failNode(ctx, node.id, rt, rt.error ?? "Unknown error");
    return false;
  }
  return true;
}

/** Resolve a successful outcome: complete (optionally schema-validated) or retry/fail. */
async function handleSuccess(
  ctx: ExecutorContext,
  node: IRNode,
  rt: NodeRuntime,
  schedulable: SchedulableNode,
  attempt: number,
): Promise<AttemptResolution> {
  const schemaRaw = resolveOutputSchema(ctx, node);
  if (schemaRaw === undefined) {
    completeNode(ctx, node, rt);
    return "done";
  }
  const validation = validateNodeOutput(rt.finalText, schemaRaw);
  if (validation.ok) {
    rt.parsedOutput = validation.parsed;
    completeNode(ctx, node, rt);
    return "done";
  }
  // Schema failure → retryable (fresh session), else fail.
  rt.error = validation.error;
  return (await acquireForRetry(ctx, node, rt, schedulable, attempt, true)) ? "retry" : "done";
}

/** Resolve an error outcome: retry (when retryable + budget remains) or fail. */
async function handleError(
  ctx: ExecutorContext,
  node: IRNode,
  rt: NodeRuntime,
  schedulable: SchedulableNode,
  attempt: number,
  outcome: NodeOutcome,
): Promise<AttemptResolution> {
  rt.error = outcome.errorMessage ?? "Unknown error";
  return (await acquireForRetry(ctx, node, rt, schedulable, attempt, outcome.retryable))
    ? "retry"
    : "done";
}

// ─── runNode ──────────────────────────────────────────────────────

/**
 * Run a single node to a terminal state (`completed` | `failed`), handling
 * retries (fresh session each retry per D4). The scheduler slot is already held
 * on entry for the first attempt; retries release, back off, and re-acquire.
 * Never rejects — all errors are captured into node state.
 *
 * The slot-release invariant holds on every exit path (completion, throw, abort,
 * retry exhaustion): an idempotent {@link SlotHandle} is released
 * unconditionally in the `finally` block, and re-armed after each retry
 * re-acquire.
 */
export async function runNode(
  ctx: ExecutorContext,
  node: IRNode,
  schedulable: SchedulableNode,
): Promise<void> {
  const rt = ctx.runState.nodes.get(node.id);
  if (!rt) return;
  let slot = slotHandle(ctx.scheduler, schedulable);

  try {
    for (;;) {
      // Aborted before/at the start of an attempt → fail (finally releases slot).
      if (ctx.signal?.aborted) {
        failNode(ctx, node.id, rt, "aborted");
        return;
      }

      rt.attempts += 1;
      const attempt = rt.attempts;
      const prompt = buildPrompt(ctx, node);
      const agentType = resolveAgentType(node);
      const adapter = ctx.getAdapter(agentType, node.id);

      const events: NormalizedEvent[] = [];
      const onEvent = (event: NormalizedEvent | null): void => {
        if (event === null) return;
        events.push(event);
        if (event.type === "session") rt.sessionId = event.id;
        else if (event.type === "tool_call") ctx.audit?.nodeTool(node.id, event.name);
        ctx.notify();
      };

      let runResult: RunAgentResult | undefined;
      try {
        runResult = await invokeAdapter(adapter, {
          prompt,
          nodeId: node.id,
          attempt,
          cwd: node.cwd,
          signal: ctx.signal,
          onEvent,
          onUpdate: ctx.notify,
          agentType,
        });
      } catch (err) {
        // Spawn / process error → non-retryable failure (finally releases slot).
        failNode(ctx, node.id, rt, err instanceof Error ? err.message : String(err));
        return;
      }

      // Abort after the run completes but before outcome evaluation → fail.
      if (ctx.signal?.aborted) {
        failNode(ctx, node.id, rt, "aborted");
        return;
      }

      // Release the held slot so other nodes may run during validation / retry.
      slot.release();

      synthesizeDoneIfMissing(events, rt);
      const outcome = applyExitCodeOverride(determineOutcome(events), runResult);
      reconcileTelemetryFromEvents(rt, events);
      if (rt.filesEdited.length === 0) rt.filesEdited = fileEditsFromEvents(events);

      if (outcome.succeeded) {
        if ((await handleSuccess(ctx, node, rt, schedulable, attempt)) === "retry") {
          slot = slotHandle(ctx.scheduler, schedulable);
          continue;
        }
        persistNodeSession(ctx, node, rt, events);
        return;
      }
      if ((await handleError(ctx, node, rt, schedulable, attempt, outcome)) === "retry") {
        slot = slotHandle(ctx.scheduler, schedulable);
        continue;
      }
      persistNodeSession(ctx, node, rt, events);
      return;
    }
  } finally {
    slot.release();
  }
}

/**
 * Persist a node's final attempt as a session file under `<runDir>/sessions/`.
 *
 * Writes the full event transcript (messages), final text, telemetry, and any
 * error so the run directory contains every agent session — used for
 * inspection and to re-enrich `finalText` on resume. Skipped silently when
 * there is no run dir (tests) or no sessionId (e.g. the adapter never emitted
 * a `session` event). Never throws: a failed write is warned, not fatal.
 */
function persistNodeSession(
  ctx: ExecutorContext,
  node: IRNode,
  rt: NodeRuntime,
  events: NormalizedEvent[],
): void {
  const runDir = ctx.options.runDir;
  if (runDir === undefined || rt.sessionId === undefined) return;
  const agentType = resolveAgentType(node);
  const profileRef = node.kind === "node" ? node.profileRef : undefined;
  const resolved = profileRef
    ? resolveProfileSync(profileRef, ctx.options.profiles ?? {})
    : undefined;
  const durationMs =
    rt.startedAt !== undefined && rt.endedAt !== undefined ? rt.endedAt - rt.startedAt : 0;
  const session: PersistedSession = {
    sessionId: rt.sessionId,
    nodeId: node.id,
    agentType,
    profile: profileRef,
    provider: resolved?.profile.provider,
    model: resolved?.profile.model,
    messages: events,
    finalText: rt.finalText,
    toolCallCount: rt.toolCount,
    durationMs,
    costUsd: rt.costUsd,
    error: rt.error,
  };
  try {
    writeSession(runDir, session);
  } catch (err) {
    console.warn(`[wisp] failed to persist session for node "${node.id}"`, err);
  }
}
