// ═══════════════════════════════════════════════════════════════════════════
// DSL builder — atom-level unit tests.
//
// Tests each fluent atom method on WorkflowBuilder for correct IR output,
// invariants (unique ids, dependsOn validation), options capture, and the
// §4.1 example expressed in raw atoms (no macros).
//
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

import { wf } from "../../dsl/builder.js";
import type { GraphIR, IRNode } from "../../types.js";

// ─── Tests ─────────────────────────────────────────────────────────

describe("wf entry point", () => {
  it("wf(name) returns a WorkflowBuilder instance", () => {
    const builder = wf("my-workflow");
    expect(builder).toBeDefined();
    expect(typeof builder.node).toBe("function");
    expect(typeof builder.fanOut).toBe("function");
    expect(typeof builder.cond).toBe("function");
    expect(typeof builder.loop).toBe("function");
    expect(typeof builder.reduce).toBe("function");
    expect(typeof builder.merge).toBe("function");
    expect(typeof builder.parallel).toBe("function");
    expect(typeof builder.sequence).toBe("function");
    expect(typeof builder.profile).toBe("function");
    expect(typeof builder.toIR).toBe("function");
  });

  it("wf(name, { maxConcurrency, defaultRetries, title }) records options", () => {
    const builder = wf("test", { maxConcurrency: 5, defaultRetries: 2, title: "Custom Title" });
    const ir = builder.toIR();
    expect(ir.options.maxConcurrency).toBe(5);
    expect(ir.options.defaultRetries).toBe(2);
  });

  it("wf(name) with no options sets defaults", () => {
    const builder = wf("minimal");
    const ir = builder.toIR();
    // `options` is always initialised to an object by the builder, so a bare
    // `toBeDefined()` is tautological. Assert the actual default values
    // instead: both optional knobs default to `undefined` (no cap, no retries)
    // rather than some implicit sentinel.
    expect(typeof ir.options).toBe("object");
    expect(ir.options.maxConcurrency).toBeUndefined();
    expect(ir.options.defaultRetries).toBeUndefined();
  });
});

describe("builder.toIR()", () => {
  it("toIR() returns a GraphIR with the correct top-level shape", () => {
    const builder = wf("test-workflow", { maxConcurrency: 3 });
    const ir = builder.toIR();
    const keys: (keyof GraphIR)[] = [
      "title",
      "slug",
      "options",
      "nodes",
      "edges",
      "conditions",
      "schemas",
      "primitives",
    ];
    for (const k of keys) {
      expect(ir).toHaveProperty(k);
    }
  });

  it("toIR() slug is a kebab-case derivation of the name", () => {
    const builder = wf("Fix Bugs!");
    const ir = builder.toIR();
    expect(ir.slug).toBe("fix-bugs");
  });

  it("toIR() returns a structural copy (mutating builder does not affect prior IR)", () => {
    const builder = wf("independent");
    const ir1 = builder.toIR();
    // Adding a node after toIR() should NOT affect ir1
    builder.node("a", { prompt: "first" });
    const ir2 = builder.toIR();
    expect(ir1.nodes).toHaveLength(0);
    expect(ir2.nodes).toHaveLength(1);
  });
});

describe("builder.node()", () => {
  it("adds a plain 'node' kind IRNode with prompt and profileRef", () => {
    const builder = wf("nodes");
    builder.node("a", { prompt: "Do X", profileRef: "dev" });
    const ir = builder.toIR();
    const nodeA = ir.nodes.find((n) => n.id === "a") as IRNode;
    expect(nodeA).toBeDefined();
    // For a "node" kind node, the discriminated union requires prompt or promptFnRef
    if (nodeA.kind !== "node") throw new Error("Expected node kind");
    expect(nodeA.prompt).toBe("Do X");
    expect(nodeA.profileRef).toBe("dev");
    expect(nodeA.agentType).toBeUndefined(); // default
  });

  it("accepts per-node retries, timeoutSec, stage, cwd, outputSchema", () => {
    const builder = wf("node-opts");
    builder.node("a", { prompt: "Do X" });
    builder.node("b", {
      prompt: "Do Y",
      profileRef: "default",
      retries: 5,
      timeoutSec: 120,
      stage: "custom",
      cwd: "/tmp/work",
      outputSchema: { type: "object" },
      dependsOn: ["a"],
    });
    const ir = builder.toIR();
    const nodeB = ir.nodes.find((n) => n.id === "b") as IRNode;
    expect(nodeB).toBeDefined();
    if (nodeB.kind !== "node") throw new Error("Expected node kind");
    expect(nodeB.retries).toBe(5);
    expect(nodeB.timeoutSec).toBe(120);
    expect(nodeB.stage).toBe("custom");
    expect(nodeB.cwd).toBe("/tmp/work");
    expect(nodeB.outputSchema).toEqual({ type: "object" });
    expect(nodeB.dependsOn).toEqual(["a"]);
  });

  it("registers dependsOn edges in the edges array", () => {
    const builder = wf("dep-edges");
    builder.node("a", { prompt: "first" });
    builder.node("b", { prompt: "second", dependsOn: ["a"] });
    const ir = builder.toIR();
    const edge = ir.edges.find((e) => e.from === "a" && e.to === "b");
    expect(edge).toBeDefined();
    expect(edge!.kind).toBe("dep");
  });

  it("rejects duplicate node ids with a descriptive error", () => {
    // This test expects an error: duplicate node ids are rejected.
    const builder = wf("dupes");
    builder.node("a", { prompt: "first" });
    expect(() => builder.node("a", { prompt: "second" })).toThrow(/duplicate|already exists/i);
  });

  it("rejects dangling dependsOn references with a descriptive error", () => {
    // This test expects an error: dangling dependsOn references are rejected.
    const builder = wf("dangling-dep");
    expect(() => builder.node("orphan", { prompt: "missing dep", dependsOn: ["phantom"] })).toThrow(
      /dependsOn|phantom|not found/i,
    );
  });
});

describe("builder.fanOut()", () => {
  it("adds a 'fanOut' kind IRNode with from, iterate, each", () => {
    const builder = wf("fanouts");
    builder.node("producer", { prompt: "list items" });
    builder.fanOut("f", {
      from: "producer",
      iterate: (ctx: unknown) =>
        (ctx as { output: (id: string) => { items: unknown[] } }).output("producer").items,
      each: (_item: unknown, _ctx: unknown) => ({ prompt: "fix it" }),
    });
    const ir = builder.toIR();
    const nodeF = ir.nodes.find((n) => n.id === "f");
    expect(nodeF).toBeDefined();
    expect(nodeF!.kind).toBe("fanOut");
    if (nodeF?.kind === "fanOut") {
      expect(nodeF.from).toBe("producer");
      expect(nodeF.iterateFnRef).toBeDefined();
      expect(nodeF.iterateFnRef.__fn).toBe(true);
      expect(nodeF.eachFnRef).toBeDefined();
      expect(nodeF.eachFnRef.__fn).toBe(true);
    }
  });

  it("fanOut registers edges from producer to fanOut node", () => {
    const builder = wf("fanout-edges");
    builder.node("p", { prompt: "produce" });
    builder.fanOut("f", { from: "p", iterate: () => [], each: () => ({ prompt: "fix" }) });
    const ir = builder.toIR();
    const edge = ir.edges.find((e) => e.from === "p" && e.to === "f");
    expect(edge).toBeDefined();
    expect(edge!.kind).toBe("fanOut");
  });

  it("rejects fanOut with a non-existent 'from' reference", () => {
    const builder = wf("fanout-bad-from");
    expect(() =>
      builder.fanOut("f", { from: "ghost", iterate: () => [], each: () => ({ prompt: "fix" }) }),
    ).toThrow(/from|ghost|not found/i);
  });
});

describe("builder.cond()", () => {
  it("adds a 'cond' kind IRNode with on, when, then", () => {
    const builder = wf("conds");
    builder.node("review", { prompt: "review code" });
    builder.node("pass", { prompt: "approved" });
    builder.cond("c", { on: "review", when: () => true, then: "pass" });
    const ir = builder.toIR();
    const nodeC = ir.nodes.find((n) => n.id === "c");
    expect(nodeC).toBeDefined();
    expect(nodeC!.kind).toBe("cond");
    if (nodeC?.kind === "cond") {
      expect(nodeC.on).toBe("review");
      expect(nodeC.whenFnRef).toBeDefined();
      expect(nodeC.whenFnRef.__fn).toBe(true);
      expect(nodeC.then).toBe("pass");
      expect(nodeC.else).toBeUndefined();
    }
  });

  it("cond with 'else' branch creates the else field", () => {
    const builder = wf("cond-else");
    builder.node("review", { prompt: "review" });
    builder.node("fix", { prompt: "fix issues" });
    builder.node("done", { prompt: "all good" });
    builder.cond("c", { on: "review", when: () => false, then: "done", else: "fix" });
    const ir = builder.toIR();
    const nodeC = ir.nodes.find((n) => n.id === "c");
    expect(nodeC).toBeDefined();
    if (nodeC?.kind === "cond") {
      expect(nodeC.else).toBe("fix");
    }
  });

  it("rejects cond with a non-existent 'on' reference", () => {
    const builder = wf("cond-bad-on");
    expect(() => builder.cond("c", { on: "nobody", when: () => true, then: "pass" })).toThrow(
      /on|nobody|not found/i,
    );
  });
});

describe("builder.loop()", () => {
  it("adds a 'loop' kind IRNode with body, until, maxIterations", () => {
    const builder = wf("loops");
    builder.node("worker", { prompt: "work" });
    builder.loop("l", { body: "worker", until: () => true, maxIterations: 3 });
    const ir = builder.toIR();
    const nodeL = ir.nodes.find((n) => n.id === "l");
    expect(nodeL).toBeDefined();
    expect(nodeL!.kind).toBe("loop");
    if (nodeL?.kind === "loop") {
      expect(nodeL.body).toBe("worker");
      expect(nodeL.untilFnRef).toBeDefined();
      expect(nodeL.untilFnRef.__fn).toBe(true);
      expect(nodeL.maxIterations).toBe(3);
    }
  });

  it("loop without maxIterations defaults to undefined (no cap)", () => {
    const builder = wf("loop-unlimited");
    builder.node("w", { prompt: "work" });
    builder.loop("l", { body: "w", until: () => true });
    const ir = builder.toIR();
    const nodeL = ir.nodes.find((n) => n.id === "l");
    expect(nodeL).toBeDefined();
    if (nodeL?.kind === "loop") {
      expect(nodeL.maxIterations).toBeUndefined();
    }
  });
});

describe("builder.reduce()", () => {
  it("adds a 'reduce' kind IRNode with from and optional profile", () => {
    const builder = wf("reduces");
    builder.node("a", { prompt: "part A" });
    builder.node("b", { prompt: "part B" });
    builder.reduce("r", { from: ["a", "b"], profile: "synthesizer" });
    const ir = builder.toIR();
    const nodeR = ir.nodes.find((n) => n.id === "r");
    expect(nodeR).toBeDefined();
    expect(nodeR!.kind).toBe("reduce");
    if (nodeR?.kind === "reduce") {
      expect(nodeR.from).toEqual(["a", "b"]);
      expect(nodeR.profileRef).toBe("synthesizer");
    }
  });

  it("reduce with merge fn stores a mergeFnRef", () => {
    const builder = wf("reduce-merge");
    builder.node("x", { prompt: "X" });
    builder.node("y", { prompt: "Y" });
    builder.reduce("r", { from: ["x", "y"], merge: (_ctx: unknown) => ({ combined: true }) });
    const ir = builder.toIR();
    const nodeR = ir.nodes.find((n) => n.id === "r");
    expect(nodeR).toBeDefined();
    if (nodeR?.kind === "reduce") {
      expect(nodeR.mergeFnRef).toBeDefined();
      expect(nodeR.mergeFnRef!.__fn).toBe(true);
      expect(nodeR.profileRef).toBeUndefined();
    }
  });

  it("reduce with agentType sets the adapter type", () => {
    const builder = wf("reduce-agent");
    builder.node("a", { prompt: "A" });
    builder.reduce("r", { from: ["a"], profile: "synth", agentType: "codex" });
    const ir = builder.toIR();
    const nodeR = ir.nodes.find((n) => n.id === "r");
    expect(nodeR).toBeDefined();
    if (nodeR?.kind === "reduce") {
      expect(nodeR.agentType).toBe("codex");
    }
  });
});

describe("builder.merge()", () => {
  it("merge is an alias for reduce with the same contract", () => {
    const builder = wf("merges");
    builder.node("a", { prompt: "A" });
    builder.node("b", { prompt: "B" });
    builder.merge("m", { from: ["a", "b"], merge: (_ctx: unknown) => ({ ok: true }) });
    const ir = builder.toIR();
    const nodeM = ir.nodes.find((n) => n.id === "m");
    expect(nodeM).toBeDefined();
    expect(nodeM!.kind).toBe("reduce");
  });
});

describe("builder.parallel()", () => {
  it("adds a 'parallel' kind IRNode", () => {
    const builder = wf("parallels");
    builder.node("a", { prompt: "A" });
    builder.node("b", { prompt: "B" });
    builder.parallel("p", { nodes: ["a", "b"] });
    const ir = builder.toIR();
    const nodeP = ir.nodes.find((n) => n.id === "p");
    expect(nodeP).toBeDefined();
    expect(nodeP!.kind).toBe("parallel");
  });

  it("creates nodes for inline NodeSpec children and wires dep edges", () => {
    const builder = wf("parallel-inline");
    builder.node("existing", { prompt: "pre-existing node" });
    builder.parallel("p", {
      nodes: [
        { prompt: "Inline A", profileRef: "dev" },
        "existing",
        { prompt: "Inline B", profileRef: "dev" },
      ],
    });
    const ir = builder.toIR();
    // Inline NodeSpec children should have been materialised as nodes
    const inlineA = ir.nodes.find(
      (n) => n.kind === "node" && "prompt" in n && n.prompt === "Inline A",
    );
    const inlineB = ir.nodes.find(
      (n) => n.kind === "node" && "prompt" in n && n.prompt === "Inline B",
    );
    expect(inlineA).toBeDefined();
    expect(inlineB).toBeDefined();
    // Edges from each inline node + existing node should connect to the parallel node
    const depEdges = ir.edges.filter((e) => e.to === "p" && e.kind === "dep");
    expect(depEdges).toHaveLength(3);
  });
});

describe("builder.sequence()", () => {
  it("adds a 'sequence' kind IRNode", () => {
    const builder = wf("sequences");
    builder.node("a", { prompt: "first" });
    builder.node("b", { prompt: "second" });
    builder.sequence("s", { steps: ["a", "b"] });
    const ir = builder.toIR();
    const nodeS = ir.nodes.find((n) => n.id === "s");
    expect(nodeS).toBeDefined();
    expect(nodeS!.kind).toBe("sequence");
  });

  it("creates nodes for inline NodeSpec steps and wires dep edges", () => {
    const builder = wf("seq-inline");
    builder.node("existing", { prompt: "pre-existing step" });
    builder.sequence("s", {
      steps: [
        { prompt: "Step One", profileRef: "dev" },
        "existing",
        { prompt: "Step Two", profileRef: "dev" },
      ],
    });
    const ir = builder.toIR();
    // Inline NodeSpec steps should have been materialised as nodes
    const stepOne = ir.nodes.find(
      (n) => n.kind === "node" && "prompt" in n && n.prompt === "Step One",
    );
    const stepTwo = ir.nodes.find(
      (n) => n.kind === "node" && "prompt" in n && n.prompt === "Step Two",
    );
    expect(stepOne).toBeDefined();
    expect(stepTwo).toBeDefined();
    // Edges from each inline step + existing step should connect to the sequence node
    const depEdges = ir.edges.filter((e) => e.to === "s" && e.kind === "dep");
    expect(depEdges).toHaveLength(3);
  });

  it("sequence IRNode carries an ordered steps field", () => {
    const builder = wf("seq-steps");
    builder.node("a", { prompt: "first" });
    builder.node("b", { prompt: "second" });
    builder.node("c", { prompt: "third" });
    builder.sequence("s", { steps: ["a", "b", "c"] });
    const ir = builder.toIR();
    const nodeS = ir.nodes.find((n) => n.id === "s");
    expect(nodeS).toBeDefined();
    // steps field must preserve order of the input array
    expect((nodeS as any).steps).toEqual(["a", "b", "c"]);
  });
});

describe("builder.profile()", () => {
  it("registers an inline profile available to nodes", () => {
    const builder = wf("inline-profiles");
    builder.profile("custom", { model: "gpt-4", provider: "openai" });
    const ir = builder.toIR();
    // Inline profiles should be present in the GraphIR or in builder metadata
    expect(ir).toBeDefined();
  });

  it("rejects duplicate inline profile names", () => {
    const builder = wf("dup-profiles");
    builder.profile("dev", { model: "gpt-4" });
    expect(() => builder.profile("dev", { model: "claude" })).toThrow(
      /duplicate profile|already exists/i,
    );
  });

  it("toIR() includes inlineProfiles as a Record keyed by name", () => {
    const builder = wf("profiles-inline");
    builder.profile("reviewer", {
      model: "gpt-4",
      provider: "openai",
      systemPrompt: "Review code.",
    });
    builder.profile("fixer", { model: "claude-3", provider: "anthropic" });
    const ir = builder.toIR();
    const inlineProfiles = (ir as any).inlineProfiles;
    expect(inlineProfiles).toBeDefined();
    expect(inlineProfiles["reviewer"]).toBeDefined();
    expect(inlineProfiles["reviewer"].model).toBe("gpt-4");
    expect(inlineProfiles["reviewer"].provider).toBe("openai");
    expect(inlineProfiles["fixer"]).toBeDefined();
    expect(inlineProfiles["fixer"].model).toBe("claude-3");
  });
});

describe("§4.1 example (atoms only, no macros)", () => {
  it("builds a valid IR for: review → fanOut fix → loop verify", () => {
    const builder = wf("fix-bugs");
    builder
      .node("review", {
        profileRef: "code-reviewer",
        prompt: "Review the code changes and list all bugs.",
        outputSchema: {
          type: "object",
          properties: { bugs: { type: "array", items: { type: "string" } } },
        },
      })
      .fanOut("fix", {
        from: "review",
        iterate: (ctx: unknown) =>
          (ctx as { output: (id: string) => { bugs: string[] } }).output("review").bugs,
        each: (item: unknown, _ctx: unknown) => ({
          prompt: `Fix this bug: ${String(item)}`,
          profileRef: "fixer",
        }),
      })
      .node("verify", {
        profileRef: "gate-keeper",
        prompt: "Verify all bugs are fixed.",
        outputSchema: {
          type: "object",
          properties: { allFixed: { type: "boolean" } },
        },
      })
      .loop("verify-loop", {
        body: "verify",
        until: (ctx: unknown) =>
          (ctx as { output: (id: string) => { allFixed: boolean } }).output("verify").allFixed,
        maxIterations: 3,
      });

    const ir = builder.toIR();
    // Expect the full IR structure
    expect(ir.nodes).toHaveLength(4); // review, fix, verify, verify-loop
    expect(ir.edges.length).toBeGreaterThanOrEqual(2);

    const reviewNode = ir.nodes.find((n) => n.id === "review");
    expect(reviewNode).toBeDefined();
    expect(reviewNode!.kind).toBe("node");

    const fixNode = ir.nodes.find((n) => n.id === "fix");
    expect(fixNode).toBeDefined();
    expect(fixNode!.kind).toBe("fanOut");

    const verifyNode = ir.nodes.find((n) => n.id === "verify");
    expect(verifyNode).toBeDefined();
    expect(verifyNode!.kind).toBe("node");

    const loopNode = ir.nodes.find((n) => n.id === "verify-loop");
    expect(loopNode).toBeDefined();
    expect(loopNode!.kind).toBe("loop");
  });
});
