/**
 * RED-phase tests — fanout.ts (expandFanOut).
 *
 * Pins the lazy fanOut-expansion behavior currently inlined as a closure
 * inside `executeDAG` (`expandFanOut(node)`). The green team will extract it
 * to `src/engine/fanout.ts` as `expandFanOut(ctx, node)` receiving an
 * {@link ExecutorContext}.
 *
 * Behaviors pinned (mirror the inline closure exactly):
 *   - no-op for non-fanOut nodes
 *   - no-op when the producer node is not yet completed
 *   - rehydrate iterate fn → items; one child IRNode per item via each fn
 *   - children named `<fanOutId>-<index>` added to nodeMap AND runState (pending)
 *   - child spec fields (prompt, outputSchema, dependsOn, agentType, profileRef
 *     default "default", stage, retries, timeoutSec, cwd, primitive meta) carried
 *   - iterate returning a non-array → zero children
 *   - iterate fn throwing → zero children (treated as [])
 *   - each fn returning null / non-object → that child skipped (continue)
 *   - a child already present in runState is NOT re-initialized (idempotent)
 *
 * RED today because `src/engine/fanout.ts` does not exist.
 */

import { describe, it, expect, vi } from "vitest";

import { expandFanOut } from "../../engine/fanout.js";

import type { FnDescriptor, GraphIR, IRNode } from "../../types.js";
import { makeExecutorContext, type MakeCtxOptions } from "../helpers/executor-context.js";
import { makeRunState, fn } from "../helpers/fixtures.js";

/** A fanOut child IRNode narrowed to its node variant (children are always kind "node"). */
type NodeChild = Extract<IRNode, { kind: "node" }>;

/** Narrow a map-lookup child to the node variant for node-specific field access. */
function asNodeChild(node: IRNode | undefined): NodeChild {
  return node as NodeChild;
}

// ── IR builders ──────────────────────────────────────────────────────

function fanOutIR(
  producerId: string,
  fanOutId: string,
  iterateFnRef: FnDescriptor,
  eachFnRef: FnDescriptor,
): GraphIR {
  return {
    title: "fanout",
    slug: "fanout",
    options: {},
    nodes: [
      { id: producerId, kind: "node", profileRef: "default", prompt: "produce" },
      {
        id: fanOutId,
        kind: "fanOut",
        from: producerId,
        iterateFnRef,
        eachFnRef,
      },
    ],
    edges: [{ from: producerId, to: fanOutId, kind: "fanOut" }],
    conditions: [],
    schemas: {},
    primitives: {},
  };
}

function ctxFor(ir: GraphIR, opts: Partial<MakeCtxOptions> = {}) {
  return makeExecutorContext({ ir, runState: makeRunState(ir), ...opts });
}

/** Mark a node completed in the run state with a parsed output object. */
function complete(runState: ReturnType<typeof makeRunState>, id: string, output: unknown): void {
  const rt = runState.nodes.get(id);
  if (!rt) throw new Error(`node ${id} missing`);
  rt.status = "completed";
  rt.parsedOutput = output;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("expandFanOut", () => {
  it("is a no-op for a non-fanOut node kind", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [{ id: "plain", kind: "node", profileRef: "default", prompt: "p" }],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    const before = new Map(ctx.nodeMap);
    const node = ctx.nodeMap.get("plain")!;

    expandFanOut(ctx, node);

    expect(ctx.nodeMap).toEqual(before);
    // No child nodes were created.
    expect(ctx.runState.nodes.size).toBe(1);
  });

  it("is a no-op when the producer node is not completed", () => {
    const ir = fanOutIR(
      "producer",
      "expand",
      fn('(ctx) => ctx.output("producer").items', "iterate"),
      fn('(item) => ({ prompt: "Fix " + String(item) })', "each"),
    );
    const ctx = ctxFor(ir);
    // producer is still pending → expansion must not run.
    expect(ctx.runState.nodes.get("producer")?.status).toBe("pending");

    expandFanOut(ctx, ctx.nodeMap.get("expand")!);

    expect(ctx.nodeMap.has("expand-0")).toBe(false);
    expect(ctx.runState.nodes.has("expand-0")).toBe(false);
  });

  it("creates one child per item, named <fanOutId>-<index>, in nodeMap and runState", () => {
    const ir = fanOutIR(
      "producer",
      "expand",
      fn('(ctx) => ctx.output("producer").items', "iterate"),
      fn('(item) => ({ prompt: "Fix " + String(item) })', "each"),
    );
    const ctx = ctxFor(ir);
    complete(ctx.runState, "producer", { items: ["fix-a", "fix-b", "fix-c"] });

    expandFanOut(ctx, ctx.nodeMap.get("expand")!);

    for (const i of [0, 1, 2]) {
      const childId = `expand-${i}`;
      // nodeMap has a child node of kind "node"
      const child = ctx.nodeMap.get(childId);
      expect(child).toBeDefined();
      expect(child?.kind).toBe("node");
      expect(asNodeChild(child).prompt).toBe(`Fix fix-${["a", "b", "c"][i]}`);
      // runState has a pending runtime entry
      const rt = ctx.runState.nodes.get(childId);
      expect(rt?.status).toBe("pending");
      expect(rt?.attempts).toBe(0);
    }
  });

  it("records the fanOut parent + index in the child primitive metadata", () => {
    const ir = fanOutIR(
      "producer",
      "expand",
      fn('(ctx) => ctx.output("producer").items', "iterate"),
      fn("(item) => ({ prompt: String(item) })", "each"),
    );
    const ctx = ctxFor(ir);
    complete(ctx.runState, "producer", { items: ["x", "y"] });

    expandFanOut(ctx, ctx.nodeMap.get("expand")!);

    expect(ctx.nodeMap.get("expand-0")?.primitive).toEqual({
      kind: "fanOut-child",
      meta: { parent: "expand", index: 0 },
    });
    expect(ctx.nodeMap.get("expand-1")?.primitive).toEqual({
      kind: "fanOut-child",
      meta: { parent: "expand", index: 1 },
    });
  });

  it("carries the each-fn NodeSpec fields onto the child (agentType, profileRef, outputSchema, dependsOn, stage, retries, timeoutSec, cwd)", () => {
    const ir = fanOutIR(
      "producer",
      "expand",
      fn('(ctx) => ctx.output("producer").items', "iterate"),
      fn(
        '(item) => ({ agentType: "codex", profileRef: "p1", prompt: "x", outputSchema: { type: "string" }, dependsOn: ["expand"], stage: "fix", retries: 7, timeoutSec: 30, cwd: "/home/user/project" })',
        "each",
      ),
    );
    const ctx = ctxFor(ir);
    complete(ctx.runState, "producer", { items: ["only"] });

    expandFanOut(ctx, ctx.nodeMap.get("expand")!);

    const child = asNodeChild(ctx.nodeMap.get("expand-0"));
    expect(child.agentType).toBe("codex");
    expect(child.profileRef).toBe("p1");
    expect(child.prompt).toBe("x");
    expect(child.outputSchema).toEqual({ type: "string" });
    expect(child.dependsOn).toEqual(["expand"]);
    expect(child.stage).toBe("fix");
    expect(child.retries).toBe(7);
    expect(child.timeoutSec).toBe(30);
    expect(child.cwd).toBe("/home/user/project");
  });

  it("defaults profileRef to 'default' when the each fn omits it", () => {
    const ir = fanOutIR(
      "producer",
      "expand",
      fn('(ctx) => ctx.output("producer").items', "iterate"),
      fn('(item) => ({ prompt: "x" })', "each"),
    );
    const ctx = ctxFor(ir);
    complete(ctx.runState, "producer", { items: ["a"] });

    expandFanOut(ctx, ctx.nodeMap.get("expand")!);

    expect(asNodeChild(ctx.nodeMap.get("expand-0")).profileRef).toBe("default");
  });

  it("creates zero children when iterate returns a non-array", () => {
    const ir = fanOutIR(
      "producer",
      "expand",
      fn('(ctx) => ({ not: "an array" })', "iterate"),
      fn('(item) => ({ prompt: "x" })', "each"),
    );
    const ctx = ctxFor(ir);
    complete(ctx.runState, "producer", { items: ["a"] });

    expandFanOut(ctx, ctx.nodeMap.get("expand")!);

    expect(ctx.nodeMap.has("expand-0")).toBe(false);
    expect(ctx.runState.nodes.has("expand-0")).toBe(false);
  });

  it("creates zero children when the iterate fn throws", () => {
    const ir = fanOutIR(
      "producer",
      "expand",
      fn('(ctx) => { throw new Error("iterate boom") }', "iterate"),
      fn('(item) => ({ prompt: "x" })', "each"),
    );
    const ctx = ctxFor(ir);
    complete(ctx.runState, "producer", { items: ["a"] });

    // Must not throw out of expandFanOut.
    expect(() => {
      expandFanOut(ctx, ctx.nodeMap.get("expand")!);
    }).not.toThrow();

    expect(ctx.nodeMap.has("expand-0")).toBe(false);
  });

  it("skips items whose each fn returns null or a non-object (continue)", () => {
    const ir = fanOutIR(
      "producer",
      "expand",
      fn('(ctx) => ctx.output("producer").items', "iterate"),
      // index 1 returns null → that child must be skipped, others created.
      fn('(item) => item === "b" ? null : ({ prompt: String(item) })', "each"),
    );
    const ctx = ctxFor(ir);
    complete(ctx.runState, "producer", { items: ["a", "b", "c"] });

    expandFanOut(ctx, ctx.nodeMap.get("expand")!);

    // "b" produced no child; "a" and "c" did. Note children are named by their
    // POSITION index in the items array, not compacted.
    expect(ctx.nodeMap.has("expand-0")).toBe(true);
    expect(ctx.nodeMap.has("expand-1")).toBe(false);
    expect(ctx.nodeMap.has("expand-2")).toBe(true);
  });

  it("does not re-initialize a child already present in runState (idempotent)", () => {
    const ir = fanOutIR(
      "producer",
      "expand",
      fn('(ctx) => ctx.output("producer").items', "iterate"),
      fn('(item) => ({ prompt: "x" })', "each"),
    );
    const runState = makeRunState(ir);
    complete(runState, "producer", { items: ["a"] });
    // Pre-seed expand-0 as already-completed with prior output.
    runState.nodes.set("expand-0", {
      status: "completed",
      attempts: 5,
      toolCount: 2,
      filesEdited: ["old.ts"],
      finalText: "prior",
    });
    const ctx = makeExecutorContext({ ir, runState });

    expandFanOut(ctx, ctx.nodeMap.get("expand")!);

    const rt = ctx.runState.nodes.get("expand-0");
    // The pre-existing runtime must be preserved (NOT reset to pending).
    expect(rt?.status).toBe("completed");
    expect(rt?.attempts).toBe(5);
    expect(rt?.finalText).toBe("prior");
    // But the child node IS still registered in nodeMap.
    expect(ctx.nodeMap.get("expand-0")?.kind).toBe("node");
  });

  it("produces an empty expansion (no children) for a zero-item iterate result", () => {
    const ir = fanOutIR(
      "producer",
      "expand",
      fn('(ctx) => ctx.output("producer").items', "iterate"),
      fn('(item) => ({ prompt: "x" })', "each"),
    );
    const ctx = ctxFor(ir);
    complete(ctx.runState, "producer", { items: [] });

    expandFanOut(ctx, ctx.nodeMap.get("expand")!);

    expect(ctx.nodeMap.has("expand-0")).toBe(false);
  });

  it("does not create duplicate runState entries when called twice (idempotent re-run)", () => {
    const ir = fanOutIR(
      "producer",
      "expand",
      fn('(ctx) => ctx.output("producer").items', "iterate"),
      fn('(item) => ({ prompt: "x" })', "each"),
    );
    const ctx = ctxFor(ir);
    complete(ctx.runState, "producer", { items: ["a"] });

    expandFanOut(ctx, ctx.nodeMap.get("expand")!);
    // Running again (as executeDAG's loop never does, but the helper must be
    // safe) must not reset the child runtime to pending.
    expandFanOut(ctx, ctx.nodeMap.get("expand")!);

    const rt = ctx.runState.nodes.get("expand-0");
    expect(rt?.status).toBe("pending");
    expect(rt?.attempts).toBe(0);
    expect(ctx.runState.nodes.size).toBe(3); // producer + expand + expand-0
  });

  it("skips a child whose cwd escapes the project root, but keeps a safe sibling", () => {
    const ir = fanOutIR(
      "producer",
      "expand",
      fn('(ctx) => ctx.output("producer").items', "iterate"),
      // index 0 → escaping cwd (/etc); index 1 → safe cwd (undefined → skipped guard).
      fn('(item) => item === "bad" ? ({ prompt: "x", cwd: "/etc" }) : ({ prompt: "y" })', "each"),
    );
    const ctx = ctxFor(ir);
    complete(ctx.runState, "producer", { items: ["bad", "good"] });

    // Suppress the expected console.warn so the test output stays clean.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expandFanOut(ctx, ctx.nodeMap.get("expand")!);

    // The escaping child (index 0) was skipped.
    expect(ctx.nodeMap.has("expand-0")).toBe(false);
    expect(ctx.runState.nodes.has("expand-0")).toBe(false);
    // The safe sibling (index 1) was still expanded.
    expect(ctx.nodeMap.has("expand-1")).toBe(true);
    expect(asNodeChild(ctx.nodeMap.get("expand-1")).prompt).toBe("y");
    expect(ctx.runState.nodes.get("expand-1")?.status).toBe("pending");

    warnSpy.mockRestore();
  });
});
