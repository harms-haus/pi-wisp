// ═══════════════════════════════════════════════════════════════════════════
// Loop / cond evaluation helpers (S27 / PLAN §27).
//
// Called by the executor (executor.ts) from Phase 2a when it encounters a
// `cond` or `loop` node. The executor passes a {@link LoopDispatch} context
// containing closures over its internal state (runState, nodeMap, ir,
// scheduler, promptOverrides, etc.) — these are defined inside executeDAG().
//
// evaluateCond: synchronous — evaluates the whenFn, routes to the chosen
//   branch, marks the non-chosen branch as skipped ("cond-not-taken").
//
// executeLoop: async — runs the iteration subgraph (body + gate nodes),
//   checks the until condition each cycle, uses transcript-replay for
//   subsequent iterations, and respects maxIterations.
// ═══════════════════════════════════════════════════════════════════════════

import type { FnDescriptor, GraphIR, IRNode, NodeRuntime, NodeCtx, RunState } from "../types.js";
import type { AgentAdapter } from "../adapters/types.js";
import type { Scheduler } from "./scheduler.js";
import { formatRunsForResume } from "./transcript.js";
import type { SessionSnapshot } from "./transcript.js";

// ─── Dispatch context ─────────────────────────────────────────────

/**
 * The context the executor passes to {@link evaluateCond} and
 * {@link executeLoop}. Every field is a reference to a value owned by
 * `executeDAG()` — the functions read/mutate them in place.
 */
export interface LoopDispatch {
  runState: RunState;
  nodeMap: Map<string, IRNode>;
  ir: GraphIR;
  scheduler: Scheduler;
  signal?: AbortSignal;
  promptOverrides: Map<string, string>;

  /**
   * Resolve and run a single agent node through the adapter (spawn or fake).
   * Acquires scheduler slots, sets the node running, and returns when the
   * node has completed or failed.
   */
  runNodeWrapper: (node: IRNode) => Promise<void>;

  /** Build the final prompt for a node (respecting promptOverrides). */
  buildPrompt: (node: IRNode) => string;

  /** Look up the adapter for a node by type + id. */
  getAdapter: (type?: string, nodeId?: string) => AgentAdapter;

  /** Resolve the agent type for a node (default "pi"). */
  resolveAgentType: (node: IRNode) => string;

  /** Create a NodeCtx for the given node id. */
  createNodeCtx: (runState: RunState, nodeId: string) => NodeCtx;

  /**
   * Fail a node and propagate skip to its dependents.
   */
  failNode: (nodeId: string, rt: NodeRuntime, message: string) => void;

  /** Notify the TUI of a state change (debounced). */
  notify: () => void;

  /**
   * Rehydrate a serialized DSL function and call it with the given context.
   * Used by evaluateCond and executeLoop to invoke whenFn/untilFn.
   */
  rehydrateFn: (desc: FnDescriptor, nodeCtx: NodeCtx) => unknown;
}

// ─── Cond evaluation ──────────────────────────────────────────────

/**
 * Skip all branches of a cond node after the whenFn threw.
 * Marks the cond node as failed and both then/else as skipped.
 */
function skipBranches(
  ctx: LoopDispatch,
  node: IRNode & { kind: "cond" },
  rt: NodeRuntime,
  err: unknown,
): void {
  rt.error = err instanceof Error ? err.message : String(err);
  rt.status = "failed";
  rt.endedAt = Date.now();
  const branches: string[] = [];
  if (typeof node.then === "string") branches.push(node.then);
  if (typeof node.else === "string") branches.push(node.else);
  for (const b of branches) {
    const branchRt = ctx.runState.nodes.get(b);
    if (branchRt && branchRt.status === "pending") {
      branchRt.status = "skipped";
      branchRt.error = "cond-not-taken";
    }
  }
}

/**
 * Evaluate a cond node: invoke whenFn, route to chosen branch, skip the
 * non-chosen branch with reason "cond-not-taken".
 *
 * Called synchronously from Phase 2a for every ready cond node.
 *
 * @returns The id of the chosen child node, or `undefined` if no branch was
 *          taken (defensive — the cond always routes to exactly one branch).
 */
export function evaluateCond(node: IRNode, ctx: LoopDispatch): string | undefined {
  if (node.kind !== "cond") return undefined;
  const rt = ctx.runState.nodes.get(node.id);
  if (!rt) return undefined;

  rt.status = "running";
  if (rt.startedAt === undefined) rt.startedAt = Date.now();

  const nodeCtx = ctx.createNodeCtx(ctx.runState, node.id);
  let branchKey: unknown;
  try {
    branchKey = ctx.rehydrateFn(node.whenFnRef, nodeCtx);
  } catch (err) {
    // When fn threw — complete the cond and skip both branches.
    skipBranches(ctx, node, rt, err);
    return undefined;
  }

  const choseThen = Boolean(branchKey);
  const thenTarget = typeof node.then === "string" ? node.then : undefined;
  const elseTarget = typeof node.else === "string" ? node.else : undefined;

  // Skip the non-chosen branch.
  const skipTarget = choseThen ? elseTarget : thenTarget;
  if (skipTarget) {
    const skipRt = ctx.runState.nodes.get(skipTarget);
    if (skipRt && skipRt.status === "pending") {
      skipRt.status = "skipped";
      skipRt.error = "cond-not-taken";
    }
  }

  rt.status = "completed";
  rt.endedAt = Date.now();

  return choseThen ? thenTarget : elseTarget;
}

// ─── Loop execution ───────────────────────────────────────────────

/**
 * Collect all nodes in a loop's iteration subgraph.
 *
 * Starts from the body node and follows `dep` edges transitively to find
 * every node that is part of the loop iteration (body → gate → …). Returns
 * node ids in BFS order (body first, then its dependents).
 */
export function collectIterationNodes(bodyId: string, ir: GraphIR): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [bodyId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);
    // Nodes that depend on `id` via dep edges are part of the iteration.
    for (const edge of ir.edges) {
      if (edge.from === id && edge.kind === "dep" && !visited.has(edge.to)) {
        queue.push(edge.to);
      }
    }
  }
  return result;
}

/**
 * Execute a loop node: run the iteration subgraph, check the until
 * condition, and repeat with transcript-replay until acceptance or
 * maxIterations.
 *
 * Called from Phase 2a. The function claims iteration nodes synchronously
 * before any `await` so the main Phase 2b does not schedule them independently.
 */
/**
 * Reset all iteration subgraph nodes to `pending` so they can be re-run.
 */
function resetIterationNodes(iterationIds: string[], runState: RunState): void {
  for (const id of iterationIds) {
    const rt = runState.nodes.get(id);
    if (!rt) continue;
    if (rt.status === "completed" || rt.status === "running") {
      rt.status = "pending";
      rt.attempts = 0;
      rt.toolCount = 0;
      rt.filesEdited = [];
      rt.finalText = undefined;
      rt.sessionId = undefined;
      rt.parsedOutput = undefined;
      rt.error = undefined;
      rt.startedAt = undefined;
      rt.endedAt = undefined;
    }
  }
}

/**
 * Build the prior-iteration transcript by collecting finalText from
 * every iteration node that has a sessionId and finalText.
 * Must be called BEFORE resetIterationNodes wipes those fields.
 * Returns SessionSnapshot[] for formatting via formatRunsForResume.
 */
function buildPriorTranscript(iterationIds: string[], runState: RunState): SessionSnapshot[] {
  const sessions: SessionSnapshot[] = [];
  for (const id of iterationIds) {
    const priorRt = runState.nodes.get(id);
    if (priorRt?.sessionId && priorRt.finalText) {
      sessions.push({
        messages: [
          { role: "assistant" as const, content: priorRt.finalText },
        ] as unknown as SessionSnapshot["messages"],
        finalText: priorRt.finalText,
      });
    }
  }
  return sessions;
}

/**
 * Build a resume prompt for the body node using transcript-replay.
 * Formats prior iterations via formatRunsForResume (role-prefixed,
 * truncating formatter from transcript.ts).
 *
 * @param sessions - Prior iteration sessions (captured before reset).
 */
function buildResumePromptForBody(
  bodyId: string,
  bodyNode: IRNode,
  basePrompt: string,
  ctx: LoopDispatch,
  sessions: SessionSnapshot[],
): void {
  const transcript = formatRunsForResume(sessions);
  const adapter = ctx.getAdapter(ctx.resolveAgentType(bodyNode), bodyId);
  const resumePrompt = adapter.buildResumePrompt(transcript, basePrompt);
  ctx.promptOverrides.set(bodyId, resumePrompt);
}

/**
 * Run all nodes in the iteration subgraph in dependency order.
 * Returns `true` if all ran successfully, `false` if any failed.
 */
async function runIterationNodes(
  iterationIds: string[],
  loopRt: NodeRuntime,
  ctx: LoopDispatch,
): Promise<boolean> {
  for (const id of iterationIds) {
    const n = ctx.nodeMap.get(id);
    if (!n) continue;
    const rt = ctx.runState.nodes.get(id);
    if (!rt || rt.status !== "pending") continue;

    await ctx.runNodeWrapper(n);

    const rtAfter = ctx.runState.nodes.get(id);
    if (rtAfter?.status === "failed") {
      loopRt.error = rtAfter.error ?? `Iteration node "${id}" failed`;
      loopRt.status = "failed";
      loopRt.endedAt = Date.now();

      // Mark remaining unprocessed iteration nodes as skipped (M1).
      const failedIdx = iterationIds.indexOf(id);
      for (const remainingId of iterationIds.slice(failedIdx + 1)) {
        const remainingRt = ctx.runState.nodes.get(remainingId);
        if (remainingRt && remainingRt.status === "pending") {
          remainingRt.status = "skipped";
          remainingRt.error = "dep-failed";
        }
      }

      return false;
    }
  }
  return true;
}

/**
 * Evaluate the until condition of a loop.
 * Returns `true` if the loop should stop (accepted).
 */
function checkUntilCondition(loopNode: IRNode & { kind: "loop" }, ctx: LoopDispatch): boolean {
  const nodeCtx = ctx.createNodeCtx(ctx.runState, loopNode.id);
  try {
    const result = ctx.rehydrateFn(loopNode.untilFnRef, nodeCtx);
    return Boolean(result);
  } catch {
    return false;
  }
}

/**
 * Mark the loop node as completed and record timing.
 */
function completeLoop(loopRt: NodeRuntime): void {
  loopRt.status = "completed";
  if (loopRt.startedAt === undefined) loopRt.startedAt = Date.now();
  loopRt.endedAt = Date.now();
}

/**
 * Mark the loop node as failed.
 */
function failLoop(loopRt: NodeRuntime, message: string): void {
  loopRt.error = message;
  loopRt.status = "failed";
  loopRt.endedAt = Date.now();
}

export async function executeLoop(loopNode: IRNode, ctx: LoopDispatch): Promise<void> {
  if (loopNode.kind !== "loop") return;
  const loopRt = ctx.runState.nodes.get(loopNode.id);
  if (!loopRt) return;

  loopRt.status = "running";
  if (loopRt.startedAt === undefined) loopRt.startedAt = Date.now();

  const bodyId = loopNode.body;
  const bodyNode = ctx.nodeMap.get(bodyId);
  if (!bodyNode) {
    failLoop(loopRt, `Loop body node "${bodyId}" not found`);
    return;
  }

  const maxIterations = loopNode.maxIterations ?? 3;
  const iterationIds = collectIterationNodes(bodyId, ctx.ir);

  // Synchronously CLAIM every iteration node so Phase 2b skips them.
  for (const id of iterationIds) {
    const rt = ctx.runState.nodes.get(id);
    if (rt && rt.status === "ready") {
      rt.status = "running";
    }
  }

  const basePrompt = ctx.buildPrompt(bodyNode);
  let iteration = 0;

  for (;;) {
    iteration++;

    // Capture prior iteration sessions BEFORE resetting iteration nodes (C1).
    const priorSessions = iteration > 1 ? buildPriorTranscript(iterationIds, ctx.runState) : [];

    // Reset iteration nodes for a fresh run.
    resetIterationNodes(iterationIds, ctx.runState);

    // Build transcript-replay prompt after the first iteration.
    if (iteration > 1) {
      buildResumePromptForBody(bodyId, bodyNode, basePrompt, ctx, priorSessions);
    }

    // Run each iteration node in dependency order.
    const ok = await runIterationNodes(iterationIds, loopRt, ctx);
    if (!ok) return;

    // Check the until condition.
    if (checkUntilCondition(loopNode, ctx)) {
      completeLoop(loopRt);
      return;
    }

    // Not accepted: enforce maxIterations.
    if (iteration >= maxIterations) {
      completeLoop(loopRt);
      return;
    }
  }
}
