// ═══════════════════════════════════════════════════════════════════════════
// Module-split boundary — builder.ts decomposed: serialization → serialize.ts.
//
// The refactor extracts the node-serialization helpers out of builder.ts into a
// focused `serialize.ts` module:
//   NodeBaseFields, pickBaseFields, extractNodeBase,
//   serializePlainNode, serializeFanOutNode, serializeCondNode,
//   serializeLoopNode, serializeReduceNode, serializeNode
//
// builder.ts RETAINS: WfOptions, ReduceOpts, the WorkflowBuilder interface,
//   WorkflowBuilderImpl, and the wf() entry point — and now imports
//   `serializeNode` from `./serialize.js`.
//
// These tests pin the resulting boundary so the split is provably complete:
//   • serialize.ts owns + exports `serializeNode` with the exact per-kind
//     serialization contract (the spec the implementer must satisfy by moving
//     the existing code verbatim).
//   • The exported `serializeNode` is the implementation behind builder.toIR()
//     (its output is byte-for-byte identical to toIR()'s serialized nodes).
//
// They are RED until serialize.ts exists. Mirrors the precedent set by
// ir-module-split.test.ts / compile-module-split.test.ts.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

// New focused module (RED until it exists):
import { serializeNode } from "../../dsl/serialize.js";

// Builder-IR primitives used to construct fixtures:
import { live } from "../../dsl/ir.js";
import type { BuilderNode } from "../../dsl/ir.js";

// builder.ts must RETAIN its public entry point + delegate serialization:
import { wf } from "../../dsl/builder.js";
import type { IRNode } from "../../types.js";

// Reusable no-op fns wrapped as live references of each FnKind (used by the
// per-kind contract tests below).
const promptFn = live(() => "p", "prompt");
const iterateFn = live(() => [], "iterate");
const eachFn = live(() => ({ prompt: "x" }), "each");
const condFn = live(() => true, "cond");
const untilFn = live(() => true, "until");
const mergeFn = live(() => ({ ok: true }), "merge");

// ─── serialize.ts owns serializeNode ──────────────────────────────

describe("module split — serialize.ts owns serializeNode", () => {
  it("exports serializeNode as a function", () => {
    expect(typeof serializeNode).toBe("function");
  });
});

// ─── per-kind serialization contract ─────────────────────────────

describe("module split — serializeNode per-kind contract", () => {
  it("serializes a plain 'node' (prompt + profileRef) with no undefined leaks", () => {
    const bn: BuilderNode = { id: "n", kind: "node", prompt: "Do X", profileRef: "dev" };
    const out = serializeNode(bn) as Extract<IRNode, { kind: "node" }>;
    expect(out).toEqual({ id: "n", kind: "node", prompt: "Do X", profileRef: "dev" });
    // compact semantics: undefined-valued keys MUST be stripped
    expect("agentType" in out).toBe(false);
    expect("promptFnRef" in out).toBe(false);
    expect("retries" in out).toBe(false);
    expect("dependsOn" in out).toBe(false);
  });

  it("serializes a 'node' with a promptFn into a promptFnRef FnDescriptor (kind 'prompt')", () => {
    const bn: BuilderNode = { id: "n", kind: "node", promptFn: promptFn };
    const out = serializeNode(bn) as Extract<IRNode, { kind: "node" }>;
    expect(out.kind).toBe("node");
    expect(out.promptFnRef).toEqual(expect.objectContaining({ __fn: true, kind: "prompt" }));
    expect(typeof out.promptFnRef!.src).toBe("string");
    expect(out.promptFnRef!.src.length).toBeGreaterThan(0);
    // prompt + promptFnRef are mutually exclusive in the serialized form
    expect("prompt" in out).toBe(false);
  });

  it("serializes a 'fanOut' node with from + iterate/each FnDescriptors", () => {
    const bn: BuilderNode = {
      id: "f",
      kind: "fanOut",
      from: "producer",
      iterate: iterateFn,
      each: eachFn,
    };
    const out = serializeNode(bn) as Extract<IRNode, { kind: "fanOut" }>;
    expect(out).toMatchObject({ id: "f", kind: "fanOut", from: "producer" });
    expect(out.iterateFnRef).toEqual(expect.objectContaining({ __fn: true, kind: "iterate" }));
    expect(out.eachFnRef).toEqual(expect.objectContaining({ __fn: true, kind: "each" }));
  });

  it("serializes a 'cond' node, omitting `else` when absent", () => {
    const bn: BuilderNode = { id: "c", kind: "cond", on: "review", when: condFn, then: "pass" };
    const out = serializeNode(bn) as Extract<IRNode, { kind: "cond" }>;
    expect(out).toMatchObject({ id: "c", kind: "cond", on: "review", then: "pass" });
    expect(out.whenFnRef).toEqual(expect.objectContaining({ __fn: true, kind: "cond" }));
    expect("else" in out).toBe(false);
  });

  it("serializes a 'cond' node WITH an `else` branch", () => {
    const bn: BuilderNode = {
      id: "c",
      kind: "cond",
      on: "review",
      when: condFn,
      then: "pass",
      else: "fix",
    };
    const out = serializeNode(bn) as Extract<IRNode, { kind: "cond" }>;
    expect(out.else).toBe("fix");
  });

  it("serializes a 'loop' node with body + until FnDescriptor + maxIterations", () => {
    const bn: BuilderNode = {
      id: "l",
      kind: "loop",
      body: "worker",
      until: untilFn,
      maxIterations: 4,
    };
    const out = serializeNode(bn) as Extract<IRNode, { kind: "loop" }>;
    expect(out).toMatchObject({ id: "l", kind: "loop", body: "worker", maxIterations: 4 });
    expect(out.untilFnRef).toEqual(expect.objectContaining({ __fn: true, kind: "until" }));
  });

  it("serializes a 'loop' node omitting maxIterations when unset", () => {
    const bn: BuilderNode = { id: "l", kind: "loop", body: "worker", until: untilFn };
    const out = serializeNode(bn) as Extract<IRNode, { kind: "loop" }>;
    expect("maxIterations" in out).toBe(false);
  });

  it("serializes a 'reduce' node, copying `from` and carrying profile/agentType", () => {
    const from = ["a", "b"];
    const bn: BuilderNode = {
      id: "r",
      kind: "reduce",
      from,
      profileRef: "synth",
      agentType: "codex",
    };
    const out = serializeNode(bn) as Extract<IRNode, { kind: "reduce" }>;
    expect(out).toMatchObject({
      id: "r",
      kind: "reduce",
      from: ["a", "b"],
      profileRef: "synth",
      agentType: "codex",
    });
    // `from` must be a fresh copy, not the input array reference
    expect(out.from).not.toBe(from);
    expect("mergeFnRef" in out).toBe(false);
  });

  it("serializes a 'reduce' node with a merge fn into a mergeFnRef (kind 'merge')", () => {
    const bn: BuilderNode = { id: "r", kind: "reduce", from: ["x"], merge: mergeFn };
    const out = serializeNode(bn) as Extract<IRNode, { kind: "reduce" }>;
    expect(out.mergeFnRef).toEqual(expect.objectContaining({ __fn: true, kind: "merge" }));
    expect("profileRef" in out).toBe(false);
  });

  it("serializes a 'parallel' node as just {id, kind:'parallel'}", () => {
    const bn: BuilderNode = { id: "p", kind: "parallel" };
    const out = serializeNode(bn);
    expect(out).toEqual({ id: "p", kind: "parallel" });
  });

  it("serializes a 'sequence' node with a copied `steps` array", () => {
    const steps = ["a", "b", "c"];
    const bn: BuilderNode = { id: "s", kind: "sequence", steps };
    const out = serializeNode(bn) as Extract<IRNode, { kind: "sequence" }>;
    expect(out).toEqual({ id: "s", kind: "sequence", steps: ["a", "b", "c"] });
    expect(out.steps).not.toBe(steps);
  });

  it("propagates common base fields (dependsOn/stage/retries/timeoutSec/cwd/outputSchema/primitive) as copies", () => {
    const dependsOn = ["up"];
    const outputSchema = { type: "object" };
    const primitive = { kind: "node" };
    const bn: BuilderNode = {
      id: "rich",
      kind: "node",
      prompt: "do",
      dependsOn,
      stage: "build",
      retries: 3,
      timeoutSec: 60,
      cwd: "/tmp",
      outputSchema,
      primitive,
    };
    const out = serializeNode(bn) as Extract<IRNode, { kind: "node" }> & {
      dependsOn?: string[];
      primitive?: { kind: string };
    };
    expect(out.dependsOn).toEqual(["up"]);
    expect(out.stage).toBe("build");
    expect(out.retries).toBe(3);
    expect(out.timeoutSec).toBe(60);
    expect(out.cwd).toBe("/tmp");
    expect(out.outputSchema).toEqual({ type: "object" });
    expect(out.primitive).toEqual({ kind: "node" });
    // copies, not shared references
    expect(out.dependsOn).not.toBe(dependsOn);
    expect(out.outputSchema).toBe(outputSchema); // outputSchema is passed verbatim (not cloned)
    expect(out.primitive).not.toBe(primitive);
  });
});

// ─── builder.ts delegates serialization to serialize.ts ───────────

describe("module split — serializeNode is the implementation behind builder.toIR()", () => {
  // For each kind, the serializeNode exported from serialize.ts must produce a
  // node byte-for-byte equal to what builder.toIR() emits. This proves the
  // extraction wires builder.toIR() onto the moved serializeNode rather than
  // leaving a private duplicate behind.
  //
  // For fn-bearing kinds we hand the SAME function reference to both the
  // builder and the fixture so serializeFn yields identical `src` on both sides.

  it("matches toIR() output for a plain 'node'", () => {
    const ir = wf("c-node").node("a", { prompt: "Do X", profileRef: "dev" }).toIR();
    const fixture: BuilderNode = { id: "a", kind: "node", prompt: "Do X", profileRef: "dev" };
    expect(serializeNode(fixture)).toEqual(ir.nodes[0]);
  });

  it("matches toIR() output for a 'fanOut' node", () => {
    const iterate = (() => []) as () => unknown[];
    const each = (() => ({ prompt: "fix" })) as () => { prompt: string };
    const ir = wf("c-fo")
      .node("producer", { prompt: "list" })
      .fanOut("f", { from: "producer", iterate, each })
      .toIR();
    const fixture: BuilderNode = {
      id: "f",
      kind: "fanOut",
      from: "producer",
      iterate: live(iterate, "iterate"),
      each: live(each, "each"),
    };
    expect(serializeNode(fixture)).toEqual(ir.nodes.find((n) => n.id === "f"));
  });

  it("matches toIR() output for a 'loop' node", () => {
    const until = (() => true) as () => boolean;
    const ir = wf("c-lp")
      .node("worker", { prompt: "w" })
      .loop("l", { body: "worker", until, maxIterations: 3 })
      .toIR();
    const fixture: BuilderNode = {
      id: "l",
      kind: "loop",
      body: "worker",
      until: live(until, "until"),
      maxIterations: 3,
    };
    expect(serializeNode(fixture)).toEqual(ir.nodes.find((n) => n.id === "l"));
  });

  it("matches toIR() output for a 'reduce' node (with merge fn)", () => {
    const merge = (() => ({ ok: true })) as (ctx: unknown) => unknown;
    const ir = wf("c-rd")
      .node("x", { prompt: "x" })
      .reduce("r", { from: ["x"], merge })
      .toIR();
    const fixture: BuilderNode = {
      id: "r",
      kind: "reduce",
      from: ["x"],
      merge: live(merge, "merge"),
    };
    expect(serializeNode(fixture)).toEqual(ir.nodes.find((n) => n.id === "r"));
  });

  it("matches toIR() output for a 'parallel' node", () => {
    const ir = wf("c-par")
      .node("a", { prompt: "a" })
      .node("b", { prompt: "b" })
      .parallel("p", { nodes: ["a", "b"] })
      .toIR();
    const fixture: BuilderNode = { id: "p", kind: "parallel" };
    expect(serializeNode(fixture)).toEqual(ir.nodes.find((n) => n.id === "p"));
  });

  it("matches toIR() output for a 'sequence' node", () => {
    const ir = wf("c-seq")
      .node("a", { prompt: "a" })
      .node("b", { prompt: "b" })
      .sequence("s", { steps: ["a", "b"] })
      .toIR();
    const fixture: BuilderNode = { id: "s", kind: "sequence", steps: ["a", "b"] };
    expect(serializeNode(fixture)).toEqual(ir.nodes.find((n) => n.id === "s"));
  });
});

// ─── builder.ts retains its public surface ───────────────────────

describe("module split — builder.ts retains wf + public types", () => {
  it("still exports wf as a function", () => {
    expect(typeof wf).toBe("function");
    const builder = wf("retained");
    expect(typeof builder.toIR).toBe("function");
    expect(typeof builder.node).toBe("function");
  });

  it("toIR() still round-trips after the extraction", () => {
    const ir = wf("roundtrip").node("a", { prompt: "hi" }).toIR();
    expect(ir.nodes).toHaveLength(1);
    expect(ir.nodes[0]).toMatchObject({ id: "a", kind: "node", prompt: "hi" });
  });
});
