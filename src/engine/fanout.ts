/**
 * Lazy fanOut expansion (split from executor.ts).
 *
 * Extracted from the `expandFanOut` closure inside `executeDAG`. Expands a
 * fanOut node at ready-time: rehydrate+invoke its iterate fn against the run
 * state to produce an item array, then create one child `IRNode` per item via
 * the each fn (applying the resulting NodeSpec — prompt, outputSchema, etc.).
 * Children are named `<fanOutId>-<index>` and added to `ctx.nodeMap` +
 * `ctx.runState`.
 *
 * @module
 */

import type { ExecutorContext } from "./executor-types.js";
import type { FnDescriptor, IRNode, NodeSpec } from "../types.js";
import { rehydrateFn, rehydrateArity } from "../dsl/fn-serialize.js";
import { isCwdWithinRoot } from "../dsl/validate.js";
import { createNodeCtx } from "./context.js";

/**
 * Build a single fanOut child node for `item` via the `each` fn.
 *
 * Rehydrates+invokes the `each` fn, applies the returned {@link NodeSpec}, and
 * returns the constructed child {@link IRNode} (id `<fanOutId>-<index>`).
 * Returns `null` when the `each` fn throws or yields a non-object spec, or
 * when the resulting child `cwd` escapes the project root (guardrail — the
 * child is skipped rather than spawned in an unsafe directory). Never throws.
 */
function buildFanOutChild(
  parentId: string,
  eachFnRef: FnDescriptor,
  index: number,
  item: unknown,
): IRNode | null {
  let spec: Partial<NodeSpec> | null = null;
  try {
    const result: unknown = rehydrateArity(eachFnRef, ["item"], [item]);
    if (result !== null && result !== undefined && typeof result === "object") {
      spec = result;
    }
  } catch {
    spec = null;
  }
  if (!spec) return null;

  const childNode: IRNode = {
    id: `${parentId}-${index}`,
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
    primitive: { kind: "fanOut-child", meta: { parent: parentId, index } },
  };
  if (childNode.cwd !== undefined && !isCwdWithinRoot(childNode.cwd)) {
    console.warn(
      `[wisp] fanOut "${parentId}" child ${index}: cwd "${childNode.cwd}" escapes the project root; skipping child.`,
    );
    return null;
  }
  return childNode;
}

/**
 * Expand a fanOut node lazily at ready-time.
 *
 * No-op for non-fanOut nodes and when the producer node is not yet completed.
 * Idempotent: a child already present in `runState` is never re-initialized
 * (its runtime is preserved), though the child node is still registered in
 * `nodeMap`. Never throws — iterate/each fn failures are treated as producing
 * zero / skipped children.
 */
export function expandFanOut(ctx: ExecutorContext, node: IRNode): number {
  if (node.kind !== "fanOut") return 0;
  const producerRt = ctx.runState.nodes.get(node.from);
  if (!producerRt || producerRt.status !== "completed") return 0;

  const nodeCtx = createNodeCtx(ctx.runState, node.id);
  let items: unknown[];
  try {
    const result = rehydrateFn(node.iterateFnRef, nodeCtx);
    items = Array.isArray(result) ? result : [];
  } catch {
    // Iterate fn threw — treat the fanOut as producing zero children.
    items = [];
  }

  const createdChildIds: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const childNode = buildFanOutChild(node.id, node.eachFnRef, i, items[i]);
    if (!childNode) continue;
    ctx.nodeMap.set(childNode.id, childNode);
    createdChildIds.push(childNode.id);
    if (!ctx.runState.nodes.has(childNode.id)) {
      ctx.runState.nodes.set(childNode.id, {
        status: "pending",
        attempts: 0,
        toolCount: 0,
        filesEdited: [],
      });
    }
  }

  // Wire each child into the fanOut parent's downstream `dep` consumers (e.g. a
  // reduce that lists the parent in its `from`). Without this, the parent is
  // marked completed the instant it expands, so a consumer would be ready off
  // the parent (racing the children), the children would be edgeless "sinks",
  // and a failed child could not propagate skip to the consumer. Giving each
  // child a `dep` edge to every consumer makes dependency gating, skip
  // propagation, and DAG-sink selection all behave as if the consumer depended
  // on the children directly.
  if (createdChildIds.length > 0) {
    const consumers = ctx.ir.edges
      .filter((e) => e.from === node.id && e.kind === "dep")
      .map((e) => e.to);
    for (const consumer of consumers) {
      for (const childId of createdChildIds) {
        addAdjacency(ctx.successors, childId, consumer);
        addAdjacency(ctx.predecessors, consumer, childId);
      }
    }
  }

  return createdChildIds.length;
}

/** Idempotently record a directed adjacency (`from` → `to`) in a map. */
function addAdjacency(map: Map<string, string[]>, from: string, to: string): void {
  let list = map.get(from);
  if (!list) {
    list = [];
    map.set(from, list);
  }
  if (!list.includes(to)) list.push(to);
}
