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
import type { IRNode } from "../types.js";
import { resolveProfileSync } from "../profiles/resolve.js";
import { createNodeCtx } from "./context.js";
import { executeSynthesis } from "./synthesize.js";
import { failNode } from "./run-node.js";

/**
 * Execute a reduce node: gather member outputs and synthesize them.
 *
 * Two paths:
 *   1. Profile present → agent-run synthesis: resolve the profile, get the
 *      adapter, and dispatch to {@link executeSynthesis} (which builds a merge
 *      prompt referencing every member and parses the agent's JSON output).
 *   2. No profile → pure-JS merge (deep-merge member outputs).
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

  // Custom instruction prompt from primitive metadata (council synthesize spec).
  const instructionPrompt =
    node.primitive?.meta && typeof node.primitive.meta === "object"
      ? node.primitive.meta["prompt"]
      : undefined;

  let result: Awaited<ReturnType<typeof executeSynthesis>>;
  try {
    let adapter: AgentAdapter | undefined;
    if (node.profileRef) {
      const resolved = resolveProfileSync(node.profileRef, ctx.options.profiles ?? {});
      if (resolved) {
        const agentType = node.agentType ?? DEFAULT_AGENT_TYPE;
        adapter = ctx.getAdapter(agentType, node.id);
      }
    }

    result = await executeSynthesis({
      ctx: nodeCtx,
      from: node.from,
      adapter,
      signal: ctx.signal,
      agentType: node.agentType,
      instructionPrompt: typeof instructionPrompt === "string" ? instructionPrompt : undefined,
    });
  } catch (err) {
    // Adapter-level throw (buildInvocation / runAgent spawn / emitEvents, or
    // resolveProfileSync / getAdapter throw) → captured into node state.
    failNode(ctx, node.id, rt, err instanceof Error ? err.message : String(err));
    return;
  }

  if (result.error) {
    failNode(ctx, node.id, rt, result.error.message);
    return;
  }

  // Success: set the node's output.
  const output = result.output;
  rt.finalText = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  rt.parsedOutput = output;
  rt.status = "completed";
  rt.endedAt = Date.now();
  ctx.notify();
}
