import { describe, it, expect } from "vitest";

import type { NodeCtx, NodeRuntime, RunState } from "../../types.js";
import { createNodeCtx } from "../../engine/context.js";

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Build a fake RunState with the given completed nodes.
 *
 * Each entry in `completedNodes` is `[nodeId, NodeRuntime]`.
 */
function buildFakeRunState(
  runId: string,
  title: string,
  completedNodes: Array<[string, Partial<NodeRuntime>]>,
): RunState {
  const nodes = new Map<string, NodeRuntime>();

  for (const [id, partial] of completedNodes) {
    const defaults: NodeRuntime = {
      status: "completed",
      sessionId: undefined,
      startedAt: 1000,
      endedAt: 2000,
      attempts: 1,
      toolCount: 0,
      filesEdited: [],
      costUsd: undefined,
      finalText: undefined,
      parsedOutput: undefined,
      error: undefined,
    };
    nodes.set(id, { ...defaults, ...partial, status: partial.status ?? "completed" });
  }

  return {
    runId,
    title,
    slug: title.toLowerCase().replace(/\s+/g, "-"),
    startedAt: 1000,
    status: "running" as const,
    nodes,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("createNodeCtx", () => {
  it("returns an object with all NodeCtx methods (output, fanOut, member, raw, run)", () => {
    // Arrange: a minimal run state with one completed node.
    const runState = buildFakeRunState("run-1", "Test Run", [
      ["a", { status: "completed", finalText: "hello" }],
    ]);

    // Act: create a NodeCtx for the querying node "current".
    const ctx: NodeCtx = createNodeCtx(runState, "current");

    // Assert: the returned context has the expected shape.
    expect(ctx).toBeDefined();
    expect(typeof ctx.output).toBe("function");
    expect(typeof ctx.fanOut).toBe("function");
    expect(typeof ctx.member).toBe("function");
    expect(typeof ctx.raw).toBe("function");
    expect(ctx.run).toBeDefined();
    expect(typeof ctx.run.runId).toBe("string");
    expect(typeof ctx.run.title).toBe("string");
    expect(typeof ctx.run.attempt).toBe("number");
    expect(typeof ctx.run.startedAt).toBe("number");
  });

  it("output returns the parsedOutput of a completed node (outputSchema path)", () => {
    // Arrange: node "review" has outputSchema results.
    const runState = buildFakeRunState("run-1", "Review Task", [
      [
        "review",
        {
          status: "completed",
          parsedOutput: { score: 8, verdict: "good" },
        },
      ],
    ]);

    // Act
    const ctx: NodeCtx = createNodeCtx(runState, "current");
    const result = ctx.output("review");

    // Assert
    expect(result).toEqual({ score: 8, verdict: "good" });
  });

  it("output falls back to finalText when the node has no parsedOutput", () => {
    // Arrange: node "fixer" completed with finalText but no parsedOutput.
    const runState = buildFakeRunState("run-1", "Fix Task", [
      [
        "fixer",
        {
          status: "completed",
          finalText: "Fixed the bug by updating the import path.",
        },
      ],
    ]);

    // Act
    const ctx: NodeCtx = createNodeCtx(runState, "current");
    const result = ctx.output("fixer");

    // Assert
    expect(result).toBe("Fixed the bug by updating the import path.");
  });

  it("output returns finalText when node has neither parsedOutput nor outputSchema", () => {
    // Arrange: node "writer" has only finalText.
    const runState = buildFakeRunState("run-1", "Write Task", [
      [
        "writer",
        {
          status: "completed",
          finalText: "Generated code output.",
        },
      ],
    ]);

    // Act
    const ctx: NodeCtx = createNodeCtx(runState, "current");
    const result = ctx.output("writer");

    // Assert
    expect(result).toBe("Generated code output.");
  });

  it("fanOut returns the array of a fanOut node's per-item child results", () => {
    // Arrange: a fanOut node "fix-fanout" has produced child nodes "fix-0", "fix-1", "fix-2".
    // The parent node itself must be present in the run state so fanOut knows it
    // exists (a fanOut that exists but has 0 convention-named children returns []).
    const runState = buildFakeRunState("run-1", "FanOut Task", [
      ["fix-fanout", { status: "completed", finalText: "expanded fanOut" }],
      [
        "fix-0",
        {
          status: "completed",
          parsedOutput: { file: "a.ts", patch: "..." },
        },
      ],
      [
        "fix-1",
        {
          status: "completed",
          parsedOutput: { file: "b.ts", patch: "..." },
        },
      ],
      [
        "fix-2",
        {
          status: "completed",
          parsedOutput: { file: "c.ts", patch: "..." },
        },
      ],
    ]);
    // Convention: the fanOut node's children are named `<parent>-<index>`.
    // Production logic will discover children via edge or naming convention.
    // For now we just assert the contract — specific naming convention is TBD.

    // Act
    const ctx: NodeCtx = createNodeCtx(runState, "fix-fanout");
    const results = ctx.fanOut("fix-fanout");

    // Assert
    expect(Array.isArray(results)).toBe(true);
    // Exact content depends on how fanOut discovers child nodes —
    // the test just validates the contract shape.
  });

  it("member(i).output returns the output of the i-th member", () => {
    // Arrange: a council node "council" has members "council-synth:member:0", "council-synth:member:1".
    const runState = buildFakeRunState("run-1", "Council Task", [
      [
        "council-synth:member:0",
        {
          status: "completed",
          parsedOutput: { opinion: "approve" },
        },
      ],
      [
        "council-synth:member:1",
        {
          status: "completed",
          parsedOutput: { opinion: "changes" },
        },
      ],
    ]);

    // Act
    const ctx: NodeCtx = createNodeCtx(runState, "council-synth");
    const result = ctx.member(0);

    // Assert
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    // The .output property should hold the parsed output
    expect(result).toHaveProperty("output");
  });

  it("run returns { runId, title, attempt, startedAt } from the run state", () => {
    // Arrange
    const runState = buildFakeRunState("run-42", "My Workflow", []);

    // Act
    const ctx: NodeCtx = createNodeCtx(runState, "current");

    // Assert
    expect(ctx.run.runId).toBe("run-42");
    expect(ctx.run.title).toBe("My Workflow");
    expect(ctx.run.attempt).toBe(1); // default attempt for current node
    expect(ctx.run.startedAt).toBe(1000);
  });

  it("raw returns { text, sessionId } for a completed node", () => {
    // Arrange
    const runState = buildFakeRunState("run-1", "Raw Test", [
      [
        "coder",
        {
          status: "completed",
          sessionId: "sess-abc123",
          finalText: "Raw output text.",
        },
      ],
    ]);

    // Act
    const ctx: NodeCtx = createNodeCtx(runState, "current");
    const raw = ctx.raw("coder");

    // Assert
    expect(raw).toBeDefined();
    expect(typeof raw.text).toBe("string");
    expect(typeof raw.sessionId).toBe("string");
    expect(raw.text).toBe("Raw output text.");
    expect(raw.sessionId).toBe("sess-abc123");
  });

  it("output on a not-completed node throws a structured error", () => {
    // Arrange: node "pending-node" is pending, not completed.
    const runState = buildFakeRunState("run-1", "Error Test", [
      [
        "pending-node",
        {
          status: "pending",
          finalText: undefined,
          parsedOutput: undefined,
        },
      ],
    ]);

    // Act & Assert
    const ctx: NodeCtx = createNodeCtx(runState, "current");
    expect(() => ctx.output("pending-node")).toThrow();
    // The error message should clearly indicate the node isn't completed.
    expect(() => ctx.output("pending-node")).toThrow(/pending-node/i);
    expect(() => ctx.output("pending-node")).toThrow(/not completed/i);
  });

  it("output on a non-existent node throws a descriptive error", () => {
    // Arrange: run state has no node "nonexistent".
    const runState = buildFakeRunState("run-1", "Missing Node", []);

    // Act & Assert
    const ctx: NodeCtx = createNodeCtx(runState, "current");
    expect(() => ctx.output("nonexistent")).toThrow();
    expect(() => ctx.output("nonexistent")).toThrow(/nonexistent/i);
    expect(() => ctx.output("nonexistent")).toThrow(/found|exist|not found/i);
  });

  it("fanOut on a non-existent node throws a descriptive error", () => {
    // Arrange: run state is empty.
    const runState = buildFakeRunState("run-1", "Missing FanOut", []);

    // Act & Assert
    const ctx: NodeCtx = createNodeCtx(runState, "current");
    expect(() => ctx.fanOut("missing-fanout")).toThrow();
    expect(() => ctx.fanOut("missing-fanout")).toThrow(/missing-fanout/i);
  });

  /**
   * (a) RED test: fanOut on an UNKNOWN target in a NON-EMPTY run state must THROW.
   *
   * The current production guard only throws when the node is missing AND the
   * entire state is empty (`runState.nodes.size === 0`).  This test asserts that
   * an unknown target throws even when other nodes exist.  It currently FAILS
   * (returns empty array) — the guard is too narrow and the implementation will
   * be fixed to always throw for genuinely unknown targets.
   */
  it("fanOut on an unknown target in a non-empty run state throws", () => {
    // Arrange: run state has a completed node but the target is unknown.
    const runState = buildFakeRunState("run-1", "NonEmpty", [
      ["existing", { status: "completed", finalText: "hello" }],
    ]);

    // Act & Assert
    const ctx: NodeCtx = createNodeCtx(runState, "current");
    expect(() => ctx.fanOut("unknown-target")).toThrow();
    expect(() => ctx.fanOut("unknown-target")).toThrow(/unknown-target/i);
  });
});
