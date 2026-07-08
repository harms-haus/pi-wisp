// ═══════════════════════════════════════════════════════════════════════════
// Characterization tests for the builder → GraphIR serialization path.
//
// These pin the EXACT observable structure of `WorkflowBuilder.toIR()` output
// across every node kind, the derived `schemas`/`primitives` records, edges,
// conditions, and FnDescriptor shape. They intentionally import NOTHING from
// `serialize.ts` so they load + pass against the code TODAY, and must keep
// passing after the serialization helpers are extracted into serialize.ts
// (task: break up builder.ts). If the extraction silently drops a field,
// changes a copy, or alters `compact` semantics, these fail — proving the
// refactor is not behaviour-preserving.
//
// (Companion file: serialize-module-split.test.ts pins the new module
//  boundary itself and is RED until serialize.ts exists.)
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

import { wf } from "../../dsl/builder.js";
import type { GraphIR, IRNode } from "../../types.js";

// ─── top-level shape ──────────────────────────────────────────────

describe("toIR() characterization — top-level GraphIR shape", () => {
  it("exposes every GraphIR field", () => {
    const ir = wf("shape").toIR();
    for (const k of [
      "title",
      "slug",
      "options",
      "nodes",
      "edges",
      "conditions",
      "schemas",
      "primitives",
    ] as (keyof GraphIR)[]) {
      expect(ir).toHaveProperty(k);
    }
  });

  it("derives title from the name and slug via kebab-case", () => {
    const ir = wf("Fix Bugs!").toIR();
    expect(ir.title).toBe("Fix Bugs!");
    expect(ir.slug).toBe("fix-bugs");
  });

  it("honours an explicit options.title for BOTH title and slug", () => {
    const ir = wf("ignored", { title: "Custom Title" }).toIR();
    expect(ir.title).toBe("Custom Title");
    expect(ir.slug).toBe("custom-title");
  });

  it("captures options.maxConcurrency / defaultRetries verbatim", () => {
    const ir = wf("opts", { maxConcurrency: 7, defaultRetries: 4 }).toIR();
    expect(ir.options).toEqual({ maxConcurrency: 7, defaultRetries: 4 });
  });

  it("defaults both option knobs to undefined when omitted", () => {
    const ir = wf("bare").toIR();
    expect(ir.options).toEqual({ maxConcurrency: undefined, defaultRetries: undefined });
  });

  it("returns an independent structural copy on each call", () => {
    const builder = wf("independent");
    const first = builder.toIR();
    builder.node("late", { prompt: "added after" });
    const second = builder.toIR();
    expect(first.nodes).toHaveLength(0);
    expect(second.nodes).toHaveLength(1);
    expect(second.nodes[0]).not.toBe(first.nodes[0]);
  });
});

// ─── per-kind node serialization ──────────────────────────────────

describe("toIR() characterization — per-kind IRNode fields", () => {
  it("serializes a plain 'node' with exactly {id,kind,prompt,profileRef}", () => {
    const ir = wf("plain").node("a", { prompt: "Do X", profileRef: "dev" }).toIR();
    const a = ir.nodes.find((n) => n.id === "a")!;
    expect(a).toEqual({ id: "a", kind: "node", prompt: "Do X", profileRef: "dev" });
    // compact must strip undefined-valued keys — no leaks
    expect("agentType" in a).toBe(false);
    expect("promptFnRef" in a).toBe(false);
    expect("retries" in a).toBe(false);
  });

  it("serializes a 'node' carrying every base field verbatim", () => {
    const ir = wf("rich")
      .node("up", { prompt: "upstream" })
      .node("rich", {
        prompt: "rich",
        profileRef: "p",
        agentType: "codex",
        stage: "build",
        retries: 3,
        timeoutSec: 90,
        cwd: "/work",
        outputSchema: { type: "object" },
        dependsOn: ["up"],
      })
      .toIR();
    const rich = ir.nodes.find((n) => n.id === "rich")!;
    expect(rich).toMatchObject({
      id: "rich",
      kind: "node",
      prompt: "rich",
      profileRef: "p",
      agentType: "codex",
      stage: "build",
      retries: 3,
      timeoutSec: 90,
      cwd: "/work",
      outputSchema: { type: "object" },
      dependsOn: ["up"],
    });
    // dependsOn must be copied, not the same reference as the input array
    expect(rich.dependsOn).not.toBe(["up"]);
  });

  it("serializes a 'fanOut' node with from + iterate/each FnDescriptors", () => {
    const ir = wf("fo")
      .node("producer", { prompt: "list" })
      .fanOut("f", {
        from: "producer",
        iterate: () => [],
        each: () => ({ prompt: "fix" }),
      })
      .toIR();
    const f = ir.nodes.find((n) => n.id === "f")!;
    expect(f.kind).toBe("fanOut");
    if (f.kind !== "fanOut") throw new Error("expected fanOut");
    expect(f.from).toBe("producer");
    expect(f.iterateFnRef).toEqual(expect.objectContaining({ __fn: true, kind: "iterate" }));
    expect(typeof f.iterateFnRef.src).toBe("string");
    expect(f.iterateFnRef.src.length).toBeGreaterThan(0);
    expect(f.eachFnRef).toEqual(expect.objectContaining({ __fn: true, kind: "each" }));
    // no stray keys
    expect("whenFnRef" in f).toBe(false);
  });

  it("serializes a 'cond' node, omitting `else` when not provided", () => {
    const ir = wf("cd")
      .node("review", { prompt: "r" })
      .node("pass", { prompt: "ok" })
      .cond("c", { on: "review", when: () => true, then: "pass" })
      .toIR();
    const c = ir.nodes.find((n) => n.id === "c")!;
    expect(c.kind).toBe("cond");
    if (c.kind !== "cond") throw new Error("expected cond");
    expect(c.on).toBe("review");
    expect(c.then).toBe("pass");
    expect(c.whenFnRef).toEqual(expect.objectContaining({ __fn: true, kind: "cond" }));
    expect("else" in c).toBe(false);
  });

  it("serializes a 'cond' node WITH an `else` branch", () => {
    const ir = wf("cd2")
      .node("review", { prompt: "r" })
      .node("fix", { prompt: "fix" })
      .node("done", { prompt: "done" })
      .cond("c", { on: "review", when: () => false, then: "done", else: "fix" })
      .toIR();
    const c = ir.nodes.find((n) => n.id === "c")!;
    if (c.kind !== "cond") throw new Error("expected cond");
    expect(c.else).toBe("fix");
  });

  it("serializes a 'loop' node with body + until FnDescriptor + maxIterations", () => {
    const ir = wf("lp")
      .node("worker", { prompt: "w" })
      .loop("l", { body: "worker", until: () => true, maxIterations: 5 })
      .toIR();
    const l = ir.nodes.find((n) => n.id === "l")!;
    if (l.kind !== "loop") throw new Error("expected loop");
    expect(l.body).toBe("worker");
    expect(l.maxIterations).toBe(5);
    expect(l.untilFnRef).toEqual(expect.objectContaining({ __fn: true, kind: "until" }));
  });

  it("serializes a 'loop' node omitting maxIterations when unset", () => {
    const ir = wf("lp2")
      .node("worker", { prompt: "w" })
      .loop("l", { body: "worker", until: () => true })
      .toIR();
    const l = ir.nodes.find((n) => n.id === "l")!;
    expect("maxIterations" in l).toBe(false);
  });

  it("serializes a 'reduce' node with a copied `from` + profile + agentType", () => {
    const ir = wf("rd")
      .node("a", { prompt: "a" })
      .node("b", { prompt: "b" })
      .reduce("r", { from: ["a", "b"], profile: "synth", agentType: "codex" })
      .toIR();
    const r = ir.nodes.find((n) => n.id === "r")!;
    if (r.kind !== "reduce") throw new Error("expected reduce");
    expect(r.from).toEqual(["a", "b"]);
    expect(r.profileRef).toBe("synth");
    expect(r.agentType).toBe("codex");
    expect("mergeFnRef" in r).toBe(false);
  });

  it("serializes a 'reduce' node with a merge FnDescriptor when a merge fn is given", () => {
    const ir = wf("rd2")
      .node("x", { prompt: "x" })
      .reduce("r", { from: ["x"], merge: () => ({ ok: true }) })
      .toIR();
    const r = ir.nodes.find((n) => n.id === "r")!;
    if (r.kind !== "reduce") throw new Error("expected reduce");
    expect(r.mergeFnRef).toEqual(expect.objectContaining({ __fn: true, kind: "merge" }));
    expect("profileRef" in r).toBe(false);
  });

  it("serializes a 'parallel' node as just {id, kind:'parallel'}", () => {
    const ir = wf("par")
      .node("a", { prompt: "a" })
      .node("b", { prompt: "b" })
      .parallel("p", { nodes: ["a", "b"] })
      .toIR();
    const p = ir.nodes.find((n) => n.id === "p")!;
    expect(p).toEqual({ id: "p", kind: "parallel" });
  });

  it("serializes a 'sequence' node with an ordered, copied `steps` array", () => {
    const ir = wf("seq")
      .node("a", { prompt: "a" })
      .node("b", { prompt: "b" })
      .node("c", { prompt: "c" })
      .sequence("s", { steps: ["a", "b", "c"] })
      .toIR();
    const s = ir.nodes.find((n) => n.id === "s")!;
    expect(s).toEqual({ id: "s", kind: "sequence", steps: ["a", "b", "c"] });
  });
});

// ─── derived records: schemas / primitives ────────────────────────

describe("toIR() characterization — derived schemas & primitives", () => {
  it("collects outputSchema into `schemas`, keyed by node id", () => {
    const ir = wf("sch")
      .node("a", {
        prompt: "a",
        outputSchema: { type: "object", properties: { x: { type: "string" } } },
      })
      .node("b", { prompt: "b" })
      .toIR();
    expect(ir.schemas["a"]).toEqual({ type: "object", properties: { x: { type: "string" } } });
    expect(ir.schemas["b"]).toBeUndefined();
  });

  it("collects primitive metadata into `primitives` for inline grouping children", () => {
    const ir = wf("prim")
      .node("existing", { prompt: "e" })
      .parallel("p", { nodes: [{ prompt: "Inline A" }, "existing"] })
      .toIR();
    // The inline NodeSpec child is materialised with primitive provenance.
    const inlineChild = ir.nodes.find(
      (n) => n.kind === "node" && "prompt" in n && n.prompt === "Inline A",
    );
    expect(inlineChild).toBeDefined();
    expect(inlineChild!.primitive).toBeDefined();
    expect(ir.primitives[inlineChild!.id]).toEqual(inlineChild!.primitive);
  });
});

// ─── edges & conditions ───────────────────────────────────────────

describe("toIR() characterization — edges & conditions", () => {
  it("emits dep/fanOut/loop/cond:branch edges with the right kinds", () => {
    const ir = wf("edges")
      .node("review", { prompt: "r" })
      .node("pass", { prompt: "p" })
      .node("fix", { prompt: "f" })
      .fanOut("fan", { from: "review", iterate: () => [], each: () => ({ prompt: "x" }) })
      .loop("lp", { body: "review", until: () => true })
      .cond("c", { on: "review", when: () => true, then: "pass", else: "fix" })
      .toIR();
    const kinds = ir.edges.map((e) => `${e.from}->${e.to}:${e.kind}`).sort();
    // dep from review->? edges + fanOut + loop + cond:branch
    expect(kinds).toEqual(expect.arrayContaining(["review->fan:fanOut", "review->lp:loop"]));
    expect(kinds).toContain("c->pass:cond:branch");
    expect(kinds).toContain("c->fix:cond:branch");
    // edges are copies, not the internal live objects (plain objects)
    expect(ir.edges.every((e) => typeof e === "object")).toBe(true);
  });

  it("serializes each condition's predicate into an expr FnDescriptor", () => {
    const ir = wf("conds")
      .node("review", { prompt: "r" })
      .node("pass", { prompt: "p" })
      .cond("c", { on: "review", when: () => true, then: "pass" })
      .toIR();
    expect(ir.conditions).toHaveLength(1);
    const cond = ir.conditions[0]!;
    expect(cond).toBeDefined();
    expect(cond.id).toBe("c");
    expect(cond.on).toBe("review");
    expect(cond.expr).toEqual(expect.objectContaining({ __fn: true, kind: "cond" }));
    expect(typeof cond.expr.src).toBe("string");
  });
});

// ─── full graph snapshot (all kinds together) ─────────────────────

describe("toIR() characterization — full multi-kind graph", () => {
  it("produces a complete, well-formed GraphIR exercising every kind", () => {
    const builder = wf("Full Example", { maxConcurrency: 4, defaultRetries: 1 });
    builder
      .node("review", {
        prompt: "Review changes.",
        profileRef: "reviewer",
        outputSchema: { type: "object", properties: { bugs: { type: "array" } } },
      })
      .node("verify", { prompt: "Verify." })
      .fanOut("fix", {
        from: "review",
        iterate: () => [],
        each: () => ({ prompt: "Fix bug", profileRef: "fixer" }),
      })
      .loop("verify-loop", { body: "verify", until: () => true, maxIterations: 3 })
      .node("pass", { prompt: "Done" })
      .cond("gate", { on: "verify", when: () => true, then: "pass" })
      .reduce("merge", { from: ["fix", "verify"], profile: "synth" })
      .parallel("par", { nodes: [{ prompt: "Inline child" }, "review", "verify"] })
      .sequence("seq", { steps: ["review", "verify", "pass"] });

    const ir = builder.toIR();

    // title / slug / options
    expect(ir.title).toBe("Full Example");
    expect(ir.slug).toBe("full-example");
    expect(ir.options).toEqual({ maxConcurrency: 4, defaultRetries: 1 });

    // every declared id is present and correctly kinded
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    const expectKind = (id: string, kind: IRNode["kind"]) => {
      const n = byId.get(id);
      expect(n, `node ${id} should exist`).toBeDefined();
      expect(n!.kind).toBe(kind);
    };
    expectKind("review", "node");
    expectKind("verify", "node");
    expectKind("fix", "fanOut");
    expectKind("verify-loop", "loop");
    expectKind("gate", "cond");
    expectKind("merge", "reduce");
    expectKind("par", "parallel");
    expectKind("seq", "sequence");

    // FnDescriptor-bearing nodes all carry valid descriptors
    const fix = byId.get("fix")!;
    if (fix.kind !== "fanOut") throw new Error("expected fanOut");
    expect(fix.iterateFnRef.__fn).toBe(true);
    expect(fix.eachFnRef.__fn).toBe(true);

    // schemas collected from the node that declared one
    expect(Object.keys(ir.schemas).sort()).toEqual(["review"]);
    // primitives collected from the inline parallel child (materialised with
    // primitive provenance by materializeNode).
    expect(ir.primitives["par:node:0"]).toBeDefined();
  });
});
