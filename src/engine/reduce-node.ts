/**
 * Reduce / synthesis node execution (split from executor.ts).
 *
 * Extracted from the `executeReduceNode` closure inside `executeDAG`. Executes
 * a reduce node: gathers member outputs and synthesizes them via either an
 * agent-run synthesis (when a profile is present) or a pure-JS merge. Receives
 * an {@link ExecutorContext}.
 *
 * @module
 */

import type { ExecutorContext } from "./executor-types.js";
import { DEFAULT_AGENT_TYPE } from "../constants.js";
import type { AgentAdapter } from "../adapters/types.js";
import type { IRNode, NodeRuntime } from "../types.js";
import { resolveProfileSync } from "../profiles/resolve.js";
import { rehydrateFn } from "../dsl/fn-serialize.js";
import { createNodeCtx, resolveReduceFrom } from "./context.js";
import { executeSynthesis } from "./synthesize.js";
import { failNode } from "./run-node.js";

/** The reduce variant of an {@link IRNode}. */
type ReduceIRNode = Extract<IRNode, { kind: "reduce" }>;

/**
 * Execute a reduce node: gather member outputs and synthesize them.
 *
 * Three paths (in priority order):
 *   1. `merge` fn + no profile → pure-JS custom merge: rehydrate the fn and use
 *      its return value; the fn gathers members via `ctx.output()`/`ctx.fanOut()`.
 *   2. Profile present → agent-run synthesis: resolve the profile, get the
 *      adapter, and dispatch to {@link executeSynthesis} (which builds a merge
 *      prompt referencing every member and parses the agent's JSON output).
 *   3. Neither → built-in pure-JS deep-merge of member outputs.
 *
 * For council nodes (`primitive.kind === "council"`), the instruction prompt
 * from the council's synthesize spec (`primitive.meta.prompt`) is plumbed to
 * the synthesis so the merge prompt includes the custom instruction.
 *
 * SAFETY: every throw is captured into node state (failed + skip propagation)
 * rather than propagating through the reduce promise, which would leave the
 * node stuck in `running` and reject `executeDAG`. Never rejects.
 */
export async function executeReduceNode(ctx: ExecutorContext, node: IRNode): Promise<void> {
  if (node.kind !== "reduce") return;
  const rt = ctx.runState.nodes.get(node.id);
  if (!rt) return;

  const nodeCtx = createNodeCtx(ctx.runState, node.id);

  // Resolve the adapter (agent-run synthesis) when a profile is present.
  const adapter = resolveReduceAdapter(ctx, node, rt);
  if (adapter === "failed") return;

  // Path 1: pure-JS custom merge fn (no adapter). Rehydrate + invoke; the fn
  // gathers members itself via ctx.output(id) / ctx.fanOut(parentId). This is
  // the documented `.reduce({ from, merge })` / `.merge(...)` behavior.
  if (!adapter && node.mergeFnRef) {
    runMergeFn(ctx, node, rt, nodeCtx);
    return;
  }

  // Paths 2 & 3: agent-run synthesis (adapter) or built-in deep-merge.
  await runSynthesis(ctx, node, rt, nodeCtx, adapter);
}

/** Resolve the adapter for agent-run synthesis, or "failed" on a throw. */
function resolveReduceAdapter(
  ctx: ExecutorContext,
  node: ReduceIRNode,
  rt: NodeRuntime,
): AgentAdapter | undefined | "failed" {
  if (!node.profileRef) return undefined;
  try {
    const resolved = resolveProfileSync(node.profileRef, ctx.options.profiles ?? {});
    return resolved ? ctx.getAdapter(node.agentType ?? DEFAULT_AGENT_TYPE, node.id) : undefined;
  } catch (err) {
    failNode(ctx, node.id, rt, err instanceof Error ? err.message : String(err));
    return "failed";
  }
}

/** Path 1: rehydrate + invoke the pure-JS `merge` fn and store its result. */
function runMergeFn(
  ctx: ExecutorContext,
  node: ReduceIRNode,
  rt: NodeRuntime,
  nodeCtx: ReturnType<typeof createNodeCtx>,
): void {
  if (!node.mergeFnRef) return;
  let merged: unknown;
  try {
    merged = rehydrateFn(node.mergeFnRef, nodeCtx);
  } catch (err) {
    failNode(ctx, node.id, rt, err instanceof Error ? err.message : String(err));
    return;
  }
  completeReduce(rt, merged);
  ctx.notify();
}

/** Paths 2 & 3: agent-run synthesis (adapter) or built-in deep-merge. */
async function runSynthesis(
  ctx: ExecutorContext,
  node: ReduceIRNode,
  rt: NodeRuntime,
  nodeCtx: ReturnType<typeof createNodeCtx>,
  adapter: AgentAdapter | undefined,
): Promise<void> {
  let result: Awaited<ReturnType<typeof executeSynthesis>>;
  try {
    result = await executeSynthesis({
      ctx: nodeCtx,
      // Expand fanOut-parent ids to their children so the synthesis gathers the
      // children's outputs (the parent's own output is empty). The completion
      // gate in scheduleReduceNode guarantees these members are completed.
      from: resolveReduceFrom(ctx.runState, ctx.nodeMap, node.from),
      adapter,
      signal: ctx.signal,
      agentType: node.agentType,
      instructionPrompt: readInstructionPrompt(node),
    });
  } catch (err) {
    // Adapter-level throw (buildInvocation / runAgent spawn / emitEvents) →
    // captured into node state.
    failNode(ctx, node.id, rt, err instanceof Error ? err.message : String(err));
    return;
  }

  if (result.error) {
    failNode(ctx, node.id, rt, result.error.message);
    return;
  }
  completeReduce(rt, result.output);
  ctx.notify();
}

/** Extract a council's custom synthesize instruction prompt, if any. */
function readInstructionPrompt(node: ReduceIRNode): string | undefined {
  const meta = node.primitive?.meta;
  const prompt = meta && typeof meta === "object" ? meta["prompt"] : undefined;
  return typeof prompt === "string" ? prompt : undefined;
}

/** Set a reduce node's output and mark it completed. */
function completeReduce(rt: NodeRuntime, output: unknown): void {
  rt.finalText = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  rt.parsedOutput = output;
  rt.status = "completed";
  rt.endedAt = Date.now();
}
