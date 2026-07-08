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
import type { IRNode, NodeSpec } from "../types.js";
import { rehydrateFn, rehydrateArity } from "../dsl/fn-serialize.js";
import { createNodeCtx } from "./context.js";

/**
 * Expand a fanOut node lazily at ready-time.
 *
 * No-op for non-fanOut nodes and when the producer node is not yet completed.
 * Idempotent: a child already present in `runState` is never re-initialized
 * (its runtime is preserved), though the child node is still registered in
 * `nodeMap`. Never throws — iterate/each fn failures are treated as producing
 * zero / skipped children.
 */
export function expandFanOut(ctx: ExecutorContext, node: IRNode): void {
  if (node.kind !== "fanOut") return;
  const producerRt = ctx.runState.nodes.get(node.from);
  if (!producerRt || producerRt.status !== "completed") return;

  const nodeCtx = createNodeCtx(ctx.runState, node.id);
  let items: unknown[];
  try {
    const result = rehydrateFn(node.iterateFnRef, nodeCtx);
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
    ctx.nodeMap.set(childId, childNode);
    if (!ctx.runState.nodes.has(childId)) {
      ctx.runState.nodes.set(childId, {
        status: "pending",
        attempts: 0,
        toolCount: 0,
        filesEdited: [],
      });
    }
  }
}
