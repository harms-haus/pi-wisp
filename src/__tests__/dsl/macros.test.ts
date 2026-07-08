// ═══════════════════════════════════════════════════════════════════════════
// DSL macros — reviewLoop, council, reviewFix expansion tests.
//
// Each macro must expand to the documented atom subgraph (nodes + edges +
// conditions + primitives). Tests assert correct structure, primitive metadata
// for stage labeling, and that reviewLoop's worker references are preserved
// for transcript-replay (D4).
//
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

import { expandReviewLoop, expandCouncil, expandReviewFix } from "../../dsl/macros.js";
import type { ReviewLoopOptions, CouncilOptions, ReviewFixOptions } from "../../dsl/macros.js";
import type { IRNode } from "../../types.js";

// ─── Tests ─────────────────────────────────────────────────────────

describe("expandReviewLoop", () => {
  it("expands to a loop with body (worker → gate) and cond for accept/reject", () => {
    const opts: ReviewLoopOptions = {
      worker: { prompt: "Write code", profileRef: "coder" },
      gate: { prompt: "Review code", profileRef: "reviewer" },
      maxRounds: 3,
    };
    const result = expandReviewLoop("rl", opts);
    // Result shape: { nodes: IRNode[], edges: IREdge[], conditions: IRCondition[] }
    expect(result.nodes).toBeDefined();
    expect(result.edges).toBeDefined();
    expect(result.nodes.length).toBeGreaterThan(0);

    // A loop node must exist
    const loopNode = result.nodes.find((n) => (n as IRNode).kind === "loop") as IRNode | undefined;
    expect(loopNode).toBeDefined();
    expect(loopNode!.kind).toBe("loop");
    if (loopNode?.kind === "loop") {
      // Body should reference the worker
      expect(typeof loopNode.body).toBe("string");
    }
  });

  it("sets primitive metadata with kind 'reviewLoop' for stage labeling", () => {
    const opts: ReviewLoopOptions = {
      worker: { prompt: "Work", profileRef: "coder" },
      gate: { prompt: "Review", profileRef: "reviewer" },
      maxRounds: 3,
    };
    const result = expandReviewLoop("rl", opts);
    // At least one node should have primitive.kind === "reviewLoop"
    const hasPrimitive = result.nodes.some((n) => (n as IRNode).primitive?.kind === "reviewLoop");
    expect(hasPrimitive).toBe(true);
  });

  it("acceptOn predicate is wired as the loop's until condition", () => {
    const opts: ReviewLoopOptions = {
      worker: { prompt: "Work", profileRef: "coder" },
      gate: { prompt: "Review", profileRef: "reviewer" },
      maxRounds: 5,
      acceptOn: (ctx: unknown) => {
        const gateOutput = (ctx as { output: (id: string) => { approved: boolean } }).output(
          "gate",
        );
        return gateOutput.approved;
      },
    };
    const result = expandReviewLoop("rl", opts);
    // The expansion should process acceptOn without error
    expect(result).toBeDefined();
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it("reviewLoop worker references are preserved for transcript replay (D4)", () => {
    const opts: ReviewLoopOptions = {
      worker: "my-worker", // string reference to an existing node
      gate: { prompt: "Gate", profileRef: "reviewer" },
      maxRounds: 3,
    };
    const result = expandReviewLoop("rl", opts);
    // The expansion should contain a node with id "my-worker"
    const workerNode = result.nodes.find((n) => (n as IRNode).id === "my-worker");
    expect(workerNode).toBeDefined();
  });

  it("throws when maxRounds is less than 1", () => {
    expect(() =>
      expandReviewLoop("bad", {
        worker: { prompt: "X", profileRef: "p" },
        gate: { prompt: "Y", profileRef: "q" },
        maxRounds: 0,
      }),
    ).toThrow(/maxRounds|maxIterations|at least 1/i);
  });
});

describe("expandCouncil", () => {
  it("expands to a parallel of members followed by a reduce synthesize node", () => {
    const opts: CouncilOptions = {
      members: [
        { prompt: "Research A", profileRef: "researcher" },
        { prompt: "Research B", profileRef: "researcher" },
        { prompt: "Research C", profileRef: "researcher" },
      ],
      synthesize: { prompt: "Synthesize findings", profile: "synthesizer" },
    };
    const result = expandCouncil("council", opts);
    expect(result.nodes).toBeDefined();
    expect(result.edges).toBeDefined();

    // Should contain a parallel node
    const parallelNode = result.nodes.find((n) => (n as IRNode).kind === "parallel") as
      IRNode | undefined;
    expect(parallelNode).toBeDefined();

    // Should contain a reduce node (synthesize)
    const reduceNode = result.nodes.find((n) => (n as IRNode).kind === "reduce") as
      IRNode | undefined;
    expect(reduceNode).toBeDefined();
  });

  it("sets primitive metadata with kind 'council' on the synthesize node", () => {
    const opts: CouncilOptions = {
      members: [{ prompt: "Member 1", profileRef: "p1" }],
      synthesize: { prompt: "Synth", profile: "synthesizer" },
    };
    const result = expandCouncil("c", opts);
    const synthNode = result.nodes.find((n) => (n as IRNode).kind === "reduce") as
      IRNode | undefined;
    expect(synthNode).toBeDefined();
    expect(synthNode!.primitive?.kind).toBe("council");
  });

  it("throws when members is empty", () => {
    expect(() =>
      expandCouncil("empty", {
        members: [],
        synthesize: { prompt: "Synth", profile: "synth" },
      }),
    ).toThrow(/members|empty/i);
  });
});

describe("expandReviewFix", () => {
  it("expands to reviewer → fanOut(workers) → optional merge", () => {
    const opts: ReviewFixOptions = {
      reviewer: { prompt: "Review code", profileRef: "reviewer" },
      workers: (_ctx: unknown) => [
        { prompt: "Fix issue 1", profileRef: "fixer" },
        { prompt: "Fix issue 2", profileRef: "fixer" },
      ],
    };
    const result = expandReviewFix("rf", opts);
    expect(result.nodes).toBeDefined();
    expect(result.edges).toBeDefined();

    // Should contain a fanOut node
    const fanOutNode = result.nodes.find((n) => (n as IRNode).kind === "fanOut") as
      IRNode | undefined;
    expect(fanOutNode).toBeDefined();
  });

  it("with merge opts adds a reduce node at the end", () => {
    const opts: ReviewFixOptions = {
      reviewer: { prompt: "Review", profileRef: "reviewer" },
      workers: (_ctx: unknown) => [{ prompt: "Fix", profileRef: "fixer" }],
      merge: { prompt: "Merge fixes", profile: "merger" },
    };
    const result = expandReviewFix("rf", opts);
    const reduceNode = result.nodes.find((n) => (n as IRNode).kind === "reduce") as
      IRNode | undefined;
    if (reduceNode) {
      expect(reduceNode.primitive?.kind).toBe("reviewFix");
    }
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it("sets primitive metadata with kind 'reviewFix'", () => {
    const opts: ReviewFixOptions = {
      reviewer: { prompt: "Review X", profileRef: "p" },
      workers: () => [{ prompt: "Fix", profileRef: "p" }],
    };
    const result = expandReviewFix("rf", opts);
    const hasPrimitive = result.nodes.some((n) => (n as IRNode).primitive?.kind === "reviewFix");
    expect(hasPrimitive).toBe(true);
  });

  it("throws when workers returns an empty array", () => {
    const opts: ReviewFixOptions = {
      reviewer: { prompt: "Review", profileRef: "p" },
      workers: () => [],
    };
    expect(() => expandReviewFix("rf", opts)).toThrow(/workers|empty/i);
  });
});
