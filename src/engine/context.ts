/**
 * Engine — Node execution context (NodeCtx).
 *
 * Backed by the in-memory {@link RunState}: provides output/fanOut/member/raw
 * access to prior completed nodes for rehydrated DSL functions at node-ready
 * time. The executor guarantees dependency nodes are completed before a fn
 * runs, so `ctx.output('review')` is always populated for a node that
 * `dependsOn: ['review']`.
 */

import type { IRNode, NodeCtx, NodeRuntime, RunState } from "../types.js";

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
 * The child ids a fanOut parent has expanded into (`<parent>-0`, `<parent>-1`, …),
 * in index order. Returns `[]` when the parent has not yet expanded (no
 * children present in the run state).
 */
function fanOutChildIds(runState: RunState, parentId: string): string[] {
  const ids: string[] = [];
  let index = 0;
  for (;;) {
    const childId = `${parentId}-${index}`;
    if (!runState.nodes.has(childId)) break;
    ids.push(childId);
    index++;
  }
  return ids;
}

/**
 * Resolve a reduce node's `from` list by expanding any fanOut-parent ids into
 * their dynamic child ids.
 *
 * A reduce authored as `.reduce(id, { from: ["fix"], profile })` where `"fix"`
 * is a {@link IRNodeKind fanOut} parent must wait for — and merge — that
 * fanOut's *children* (`fix-0`, `fix-1`, …), not the parent itself (whose own
 * output is empty and which is marked completed the instant it expands, before
 * its children run). Non-fanOut ids are passed through unchanged.
 *
 * When a fanOut parent has not yet expanded (no children discovered), the
 * parent id is kept so the caller's completion gate keeps treating it as
 * pending until expansion produces children.
 *
 * @param runState - Run state used to enumerate expanded children.
 * @param nodeMap  - Node map used to detect fanOut parents by kind.
 * @param from     - The reduce node's authored `from` list.
 * @returns The effective member-id list (fanOut parents expanded to children).
 */
export function resolveReduceFrom(
  runState: RunState,
  nodeMap: Map<string, IRNode>,
  from: readonly string[],
): string[] {
  const resolved: string[] = [];
  for (const id of from) {
    const node = nodeMap.get(id);
    if (node?.kind === "fanOut") {
      const childIds = fanOutChildIds(runState, id);
      if (childIds.length > 0) {
        resolved.push(...childIds);
      } else {
        // Not yet expanded: keep the parent so the gate keeps waiting.
        resolved.push(id);
      }
    } else {
      resolved.push(id);
    }
  }
  return resolved;
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
      throw new Error(
        `member: no member node found for index ${index}. ` +
          `Looked for a key ending in ":member:${index}".`,
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
