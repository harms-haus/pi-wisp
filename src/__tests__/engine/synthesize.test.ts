/**
 * ═══════════════════════════════════════════════════════════════════════════
 * S30 — Synthesis (reduce/merge node).
 *
 * Tests for `executeSynthesis`. Covers:
 *
 *   1. Council synthesis: member outputs accessed via `ctx.output(from[i])`
 *      (the `from` array holds fully-qualified node ids), merged via
 *      recursive deep-merge or agent-run.
 *
 *   2. General merge: same mechanism — all members use `ctx.output(from[i])`.
 *
 *   3. Agent-run synthesis: with a FakeAgentAdapter, builds a merge prompt
 *      referencing member outputs, dispatches to the adapter, and returns
 *      the agent's output as the synthesized result.
 *
 *   4. Error handling: missing/incomplete members produce a structured
 *      runtime error (not a thrown exception).
 *
 *   5. Recursive deep-merge: nested keys from multiple members are unioned
 *      (not overwritten wholesale by the last member).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { executeSynthesis, type SynthesisOptions } from "../../engine/synthesize.js";
import { createNodeCtx } from "../../engine/context.js";
import type { NodeRuntime, RunState } from "../../types.js";
import { createFakeAdapter } from "../helpers/fake-adapter.js";

// ══════════════════════════════════════════════════════════════════════
// Fixture helpers
// ══════════════════════════════════════════════════════════════════════

/**
 * Build a fake RunState with given completed nodes for synthesis tests.
 */
function buildRunState(
  runId: string,
  title: string,
  completedNodes: Array<[string, Partial<NodeRuntime>]>,
): RunState {
  const nodes = new Map<string, NodeRuntime>();
  for (const [id, partial] of completedNodes) {
    nodes.set(id, {
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
      ...partial,
    });
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

// ══════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════

describe("executeSynthesis (S30)", () => {
  /**
   * (a) Pure-JS council merge: deep-merges member outputs accessed via
   * `ctx.output(from[i])` (fully-qualified node ids). No adapter is provided,
   * so the merge is done in-process.
   */
  it("council synthesis with pure-JS deep-merge", async () => {
    // Arrange: two member nodes with structured outputs
    const runState = buildRunState("run-synth", "Synthesize Test", [
      ["member-0", { parsedOutput: { opinion: "approve", score: 9 }, finalText: "Member 0 final" }],
      ["member-1", { parsedOutput: { opinion: "changes", score: 7 }, finalText: "Member 1 final" }],
    ]);
    const ctx = createNodeCtx(runState, "synth");

    const options: SynthesisOptions = {
      ctx,
      from: ["member-0", "member-1"],
    };

    const result = await executeSynthesis(options);

    expect(result.error).toBeUndefined();
    expect(result.output).toBeDefined();

    // The synthesized output should be a merged result (e.g., an object
    // containing both member opinions or a consolidated summary).
    const output = result.output as Record<string, unknown>;
    expect(typeof output).toBe("object");
  });

  /**
   * (b) General pure-JS merge: accessed via ctx.output(from[i]).
   */
  it("general merge via ctx.output", async () => {
    const runState = buildRunState("run-js-merge", "JS Merge", [
      ["a", { finalText: "Output from member A" }],
      ["b", { finalText: "Output from member B" }],
    ]);
    const ctx = createNodeCtx(runState, "merge-node");

    const options: SynthesisOptions = {
      ctx,
      from: ["a", "b"],
    };

    const result = await executeSynthesis(options);

    expect(result.error).toBeUndefined();
    expect(result.output).toBeDefined();

    // A pure-JS merge returns the merged object directly
    const output = result.output as Record<string, unknown>;
    expect(typeof output).toBe("object");
  });

  /**
   * (c) Council synthesis with three members: deep-merges multiple
   * parsedOutput objects into one consolidated result.
   */
  it("council reduces over parallel members (three members)", async () => {
    // Arrange: three council members
    const runState = buildRunState("run-council", "Council Test", [
      [
        "member-0",
        {
          parsedOutput: { recommendation: "approve", reasoning: "meets all criteria" },
          finalText: "Member 0 analysis",
        },
      ],
      [
        "member-1",
        {
          parsedOutput: { recommendation: "changes", reasoning: "needs minor fixes" },
          finalText: "Member 1 analysis",
        },
      ],
      [
        "member-2",
        {
          parsedOutput: { recommendation: "approve", reasoning: "looks good" },
          finalText: "Member 2 analysis",
        },
      ],
    ]);
    const ctx = createNodeCtx(runState, "council-synth");

    const options: SynthesisOptions = {
      ctx,
      from: ["member-0", "member-1", "member-2"],
    };

    const result = await executeSynthesis(options);

    expect(result.error).toBeUndefined();
    expect(result.output).toBeDefined();

    // The council synthesis merges all three member recommendations
    // into a single consolidated recommendation
    const output = result.output as { recommendation?: string };
    expect(output.recommendation).toBeDefined();
  });

  /**
   * (d) Error handling: when a referenced member node is not completed,
   * executeSynthesis returns an error result (not a thrown exception).
   */
  it("returns an error result when a member node is not completed", async () => {
    // Arrange: one member completed, one member still pending
    const runState = buildRunState("run-err", "Error Case", [
      ["member-0", { status: "completed", parsedOutput: { x: 1 } }],
      // member-1 is NOT in the run state at all
    ]);
    const ctx = createNodeCtx(runState, "synth");

    const options: SynthesisOptions = {
      ctx,
      from: ["member-0", "member-1"],
    };

    const result = await executeSynthesis(options);

    expect(result.output).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.error!.kind).toBe("runtime");
    // Error message should mention the missing member
    expect(result.error!.message).toMatch(/member-1/i);
  });

  /**
   * (e) Deep-merge: nested keys from multiple members are unioned.
   *
   * Asserts that the recursive deep-merge (not shallow Object.assign) preserves
   * nested sub-keys from earlier members when later members only set a subset.
   */
  it("deep-merges nested objects (not shallow assign)", async () => {
    const runState = buildRunState("run-deep", "Deep Merge Test", [
      [
        "member-0",
        {
          parsedOutput: {
            nested: { a: 1, b: 2 },
            top: "from-0",
          },
        },
      ],
      [
        "member-1",
        {
          parsedOutput: {
            nested: { b: 3, c: 4 },
            top: "from-1",
          },
        },
      ],
    ]);
    const ctx = createNodeCtx(runState, "synth");

    const result = await executeSynthesis({
      ctx,
      from: ["member-0", "member-1"],
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toBeDefined();
    const output = result.output as Record<string, unknown>;
    // Deep-merge: nested key union, not replacement
    const nested = output.nested as Record<string, unknown>;
    expect(nested.a).toBe(1); // from member-0, survives deep-merge
    expect(nested.b).toBe(3); // last-writer-wins → member-1
    expect(nested.c).toBe(4); // from member-1
    // Top-level key: last-writer-wins
    expect(output.top).toBe("from-1");
  });

  /**
   * (f) Agent-run synthesis: with a FakeAgentAdapter, the merge prompt
   * includes member outputs and the agent's result becomes the output.
   */
  it("agent-run synthesis includes member outputs in prompt and returns agent result", async () => {
    const runState = buildRunState("run-agent-synth", "Agent Synthesis", [
      ["member-0", { parsedOutput: { x: 10 } }],
      ["member-1", { parsedOutput: { y: 20 } }],
    ]);
    const ctx = createNodeCtx(runState, "synth");

    const adapter = createFakeAdapter({
      finalText: JSON.stringify({ merged: true, x: 10, y: 20 }),
      sessionId: "synth-session",
    });

    const result = await executeSynthesis({
      ctx,
      from: ["member-0", "member-1"],
      adapter,
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ merged: true, x: 10, y: 20 });

    // Verify the merge prompt includes the member outputs.
    expect(adapter.invocations.length).toBeGreaterThanOrEqual(1);
    const prompt = adapter.invocations[0]!.prompt;
    expect(prompt).toContain("--- Member 0 ---");
    expect(prompt).toContain("--- Member 1 ---");
    expect(prompt).toContain('"x": 10');
    expect(prompt).toContain('"y": 20');
  });

  /**
   * (g) Agent-run synthesis: when the adapter returns raw non-JSON text,
   * the output is the raw string.
   */
  it("agent-run synthesis returns raw text when agent output is not valid JSON", async () => {
    const runState = buildRunState("run-agent-raw", "Agent Raw", [
      ["member-0", { parsedOutput: { msg: "hello" } }],
    ]);
    const ctx = createNodeCtx(runState, "synth");

    const adapter = createFakeAdapter({
      finalText: "This is a plain text summary",
      sessionId: "synth-raw-session",
    });

    const result = await executeSynthesis({
      ctx,
      from: ["member-0"],
      adapter,
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toBe("This is a plain text summary");
  });

  /**
   * (h) Agent-run synthesis: empty output from adapter returns an error.
   */
  it("agent-run synthesis returns error when adapter produces no output", async () => {
    const runState = buildRunState("run-agent-empty", "Agent Empty", [
      ["member-0", { parsedOutput: { msg: "hello" } }],
    ]);
    const ctx = createNodeCtx(runState, "synth");

    const adapter = createFakeAdapter({
      finalText: "",
      sessionId: "synth-empty-session",
    });

    const result = await executeSynthesis({
      ctx,
      from: ["member-0"],
      adapter,
    });

    expect(result.output).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.error!.kind).toBe("runtime");
    expect(result.error!.message).toMatch(/no output text/i);
  });

  /**
   * (i) Prototype pollution guard: __proto__ / constructor / prototype keys
   * from JSON-parsed member output must NOT be merged into Object.prototype.
   *
   * Without the guard in deepMergeInto, `JSON.parse('{"__proto__":...}')`
   * creates `__proto__` as an own enumerable property, and the recursive
   * merge would recurse into Object.prototype via `target[key]` (which
   * resolves to the prototype's getter), polluting it globally.
   */
  it("prevents prototype pollution via __proto__ in member output", async () => {
    // Create a member output where __proto__ is an own enumerable key
    // (as it would be after JSON.parse from an untrusted source).
    const poisoned = JSON.parse('{"__proto__":{"polluted":true}}');
    const runState = buildRunState("run-proto", "Proto Guard", [
      ["member-0", { parsedOutput: poisoned }],
    ]);
    const ctx = createNodeCtx(runState, "synth");

    const result = await executeSynthesis({
      ctx,
      from: ["member-0"],
    });

    // (1) Object.prototype must NOT have been polluted.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // (2) The __proto__ key must NOT have leaked into the merged result.
    expect(result.error).toBeUndefined();
    expect(result.output).toBeDefined();
    const output = result.output as Record<string, unknown>;
    expect(Object.keys(output)).not.toContain("__proto__");
    expect(Object.keys(output)).not.toContain("constructor");
    expect(Object.keys(output)).not.toContain("prototype");
  });
});
