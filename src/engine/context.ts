/**
 * Engine — Node execution context (NodeCtx).
 *
 * Backed by the in-memory {@link RunState}: provides output/fanOut/member/raw
 * access to prior completed nodes for rehydrated DSL functions at node-ready
 * time. The executor guarantees dependency nodes are completed before a fn
 * runs, so `ctx.output('review')` is always populated for a node that
 * `dependsOn: ['review']`.
 */

import type { NodeCtx, NodeRuntime, RunState } from "../types.js";

/** Extract a node's output: parsed outputSchema result, else raw final text. */
function nodeOutput(rt: NodeRuntime): unknown {
  return rt.parsedOutput !== undefined ? rt.parsedOutput : rt.finalText;
}

/**
 * Collect a fanOut node's per-item child results via the `<parent>-<index>`
 * naming convention (e.g. `fix-0`, `fix-1`, ...). Returns an empty array when
 * no children are discovered — the fanOut may legitimately have produced zero
 * items, or may not yet have expanded.
 */
function collectFanOutChildren(runState: RunState, parentId: string): unknown[] {
  const results: unknown[] = [];
  let index = 0;
  for (;;) {
    const child = runState.nodes.get(`${parentId}-${index}`);
    if (!child) break;
    results.push(nodeOutput(child));
    index++;
  }
  return results;
}

/**
 * Create a NodeCtx backed by the given RunState and current node id.
 *
 * The returned context object is passed to all rehydrated DSL functions
 * (iterate, each, cond, merge, until, synthesise) at node-ready time.
 *
 * @param runState - The in-memory run state (must contain completed nodes).
 * @param nodeId   - The node whose context is being built (used for the
 *                   current attempt + error messages).
 * @returns A fully-wired NodeCtx.
 */
export function createNodeCtx(runState: RunState, nodeId: string): NodeCtx {
  const current = runState.nodes.get(nodeId);

  return {
    output(target: string): unknown {
      const rt = runState.nodes.get(target);
      if (!rt) {
        throw new Error(`output: node "${target}" was not found in the run state.`);
      }
      if (rt.status !== "completed") {
        throw new Error(`output: node "${target}" is not completed (status: ${rt.status}).`);
      }
      return nodeOutput(rt);
    },

    fanOut(target: string): unknown[] {
      const children = collectFanOutChildren(runState, target);
      if (children.length > 0) return children;
      // No children discovered by naming convention. A fanOut that exists but
      // has zero expanded children legitimately returns []; only throw when
      // the target is genuinely unknown (a typo'd reference) — independent of
      // run state size, so a typo'd target is never silently masked.
      if (!runState.nodes.has(target)) {
        throw new Error(`fanOut: node "${target}" was not found in the run state.`);
      }
      return children;
    },

    member(index: number): { output: unknown } {
      // The council macro names member nodes as "<councilId>:member:<index>"
      // (e.g. "council1:member:0"). Search all keys for the exact suffix
      // ":member:${index}" to handle any council id.
      const suffix = `:member:${index}`;
      for (const [key, rt] of runState.nodes) {
        if (key.endsWith(suffix)) {
          return { output: nodeOutput(rt) };
        }
      }
      // Fallback: try the old flat naming ("member-<index>") for backward
      // compatibility with simpler test fixtures.
      const legacyRt = runState.nodes.get(`member-${index}`);
      if (legacyRt) {
        return { output: nodeOutput(legacyRt) };
      }
      throw new Error(
        `member: member-${index} was not found in the run state. ` +
          `Looked for key ending in ":member:${index}" or "member-${index}".`,
      );
    },

    raw(target: string): { text: string; sessionId: string } {
      const rt = runState.nodes.get(target);
      if (!rt) {
        throw new Error(`raw: node "${target}" was not found in the run state.`);
      }
      return { text: rt.finalText ?? "", sessionId: rt.sessionId ?? "" };
    },

    run: {
      runId: runState.runId,
      title: runState.title,
      attempt: current?.attempts ?? 1,
      startedAt: runState.startedAt,
    },
  };
}
