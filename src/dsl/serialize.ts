// ═══════════════════════════════════════════════════════════════════════════
// DSL node serialization — builder nodes → IR nodes.
//
// Extracted from builder.ts: converts the builder-internal {@link BuilderNode}
// shapes (which hold *live* function references via {@link LiveFn}) into the
// serializable {@link IRNode} shapes (whose function references become
// transportable {@link FnDescriptor}s via `serializeFn`).
//
// builder.ts's `WorkflowBuilderImpl.toIR()` delegates each node through
// `serializeNode`; `pickBaseFields` is shared with the builder's `node()`
// method for extracting the common spec fields when constructing a node.
// ═══════════════════════════════════════════════════════════════════════════

import type { IRNode, IRNodeBase, NodeSpec } from "../types.js";
import { compact } from "../utils.js";
import { serializeFn } from "./fn-serialize.js";
import type { BuilderNode } from "./ir.js";

// ─── shared spec/base-field extraction ────────────────────────────

/** Fields shared by every builder node, copied verbatim from a NodeSpec/base. */
export interface NodeBaseFields {
  stage?: string;
  retries?: number;
  timeoutSec?: number;
  cwd?: string;
  outputSchema?: unknown;
  dependsOn?: string[];
}

/** Extract the common base fields from a NodeSpec-like object. */
export function pickBaseFields(spec: NodeSpec): NodeBaseFields {
  const out: NodeBaseFields = {};
  if (spec.stage !== undefined) out.stage = spec.stage;
  if (spec.retries !== undefined) out.retries = spec.retries;
  if (spec.timeoutSec !== undefined) out.timeoutSec = spec.timeoutSec;
  if (spec.cwd !== undefined) out.cwd = spec.cwd;
  if (spec.outputSchema !== undefined) out.outputSchema = spec.outputSchema;
  if (spec.dependsOn !== undefined) out.dependsOn = [...spec.dependsOn];
  return out;
}

/** Build the common {@link IRNodeBase} fields (minus `kind`) from a builder node. */
export function extractNodeBase(bn: BuilderNode): Omit<IRNodeBase, "kind"> {
  return {
    id: bn.id,
    ...compact({
      dependsOn: bn.dependsOn ? [...bn.dependsOn] : undefined,
      stage: bn.stage,
      retries: bn.retries,
      timeoutSec: bn.timeoutSec,
      cwd: bn.cwd,
      outputSchema: bn.outputSchema,
      primitive: bn.primitive ? { ...bn.primitive } : undefined,
    }),
  };
}

// ─── per-kind serialization ───────────────────────────────────────

/** Serialize a plain-node builder node into an IRNode. */
function serializePlainNode(
  bn: Extract<BuilderNode, { kind: "node" }>,
  base: Omit<IRNodeBase, "kind">,
): IRNode {
  return {
    ...base,
    kind: "node",
    ...compact({
      agentType: bn.agentType,
      profileRef: bn.profileRef,
      prompt: bn.prompt,
      promptFnRef: bn.promptFn ? serializeFn(bn.promptFn.fn, bn.promptFn.kind) : undefined,
    }),
  };
}

/** Serialize a fanOut builder node into an IRNode. */
function serializeFanOutNode(
  bn: Extract<BuilderNode, { kind: "fanOut" }>,
  base: Omit<IRNodeBase, "kind">,
): IRNode {
  return {
    ...base,
    kind: "fanOut",
    from: bn.from,
    iterateFnRef: serializeFn(bn.iterate.fn, bn.iterate.kind),
    eachFnRef: serializeFn(bn.each.fn, bn.each.kind),
  };
}

/** Serialize a cond builder node into an IRNode. */
function serializeCondNode(
  bn: Extract<BuilderNode, { kind: "cond" }>,
  base: Omit<IRNodeBase, "kind">,
): IRNode {
  return {
    ...base,
    kind: "cond",
    on: bn.on,
    whenFnRef: serializeFn(bn.when.fn, bn.when.kind),
    then: bn.then,
    ...compact({ else: bn.else }),
  };
}

/** Serialize a loop builder node into an IRNode. */
function serializeLoopNode(
  bn: Extract<BuilderNode, { kind: "loop" }>,
  base: Omit<IRNodeBase, "kind">,
): IRNode {
  return {
    ...base,
    kind: "loop",
    body: bn.body,
    untilFnRef: serializeFn(bn.until.fn, bn.until.kind),
    ...compact({ maxIterations: bn.maxIterations }),
  };
}

/** Serialize a reduce builder node into an IRNode. */
function serializeReduceNode(
  bn: Extract<BuilderNode, { kind: "reduce" }>,
  base: Omit<IRNodeBase, "kind">,
): IRNode {
  return {
    ...base,
    kind: "reduce",
    from: [...bn.from],
    ...compact({
      mergeFnRef: bn.merge ? serializeFn(bn.merge.fn, bn.merge.kind) : undefined,
      profileRef: bn.profileRef,
      agentType: bn.agentType,
    }),
  };
}

/** Serialize a single builder node (with live fns) into an IRNode (with FnDescriptors). */
export function serializeNode(bn: BuilderNode): IRNode {
  const base = extractNodeBase(bn);
  switch (bn.kind) {
    case "node":
      return serializePlainNode(bn, base);
    case "fanOut":
      return serializeFanOutNode(bn, base);
    case "cond":
      return serializeCondNode(bn, base);
    case "loop":
      return serializeLoopNode(bn, base);
    case "reduce":
      return serializeReduceNode(bn, base);
    case "parallel":
      return { ...base, kind: "parallel" };
    case "sequence":
      return { ...base, kind: "sequence", steps: [...bn.steps] };
  }
}
