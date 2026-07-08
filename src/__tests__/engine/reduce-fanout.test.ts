/**
 * Regression: a `reduce` whose `from` lists a fanOut PARENT must wait for — and
 * synthesize over — the fanOut's dynamic children.
 *
 * Before the fix, the fanOut parent was marked `completed` the instant it
 * expanded (before its children ran), so the reduce raced the children and
 * synthesized over a single empty (`undefined`) member — the children's real
 * outputs never reached the synthesizer. These tests pin the fixed behavior.
 */

import { describe, it, expect } from "vitest";

import { executeDAG } from "../../engine/executor.js";
import { expandFanOut } from "../../engine/fanout.js";
import { createScheduler } from "../../engine/scheduler.js";
import { createFakeAdapter } from "../helpers/fake-adapter.js";
import { makeExecutorContext } from "../helpers/executor-context.js";
import { fn, makeRunState } from "../helpers/fixtures.js";
import type { AgentAdapter, NodeInvocationContext } from "../../adapters/types.js";
import type { GraphIR, IRNode, NormalizedEvent } from "../../types.js";

/** Build a graph: gen → fanOut(answer) → reduce(synth, from: ["answer"]). */
function buildIR(synthProfileRef = "default"): GraphIR {
  const nodes: IRNode[] = [
    {
      id: "gen",
      kind: "node",
      profileRef: "default",
      prompt: "generate",
      outputSchema: {
        type: "object",
        properties: { questions: { type: "array", items: { type: "string" } } },
        required: ["questions"],
      },
    },
    {
      id: "answer",
      kind: "fanOut",
      from: "gen",
      iterateFnRef: fn('(ctx) => ctx.output("gen").questions', "iterate"),
      eachFnRef: fn('(item) => ({ prompt: "Answer: " + item, profileRef: "default" })', "each"),
    },
    {
      id: "synth",
      kind: "reduce",
      from: ["answer"],
      profileRef: synthProfileRef,
      agentType: "pi",
    },
  ];
  return {
    title: "fanout-reduce",
    slug: "fanout-reduce",
    options: {},
    nodes,
    edges: [
      { from: "gen", to: "answer", kind: "fanOut" },
      { from: "answer", to: "synth", kind: "dep" },
    ],
    conditions: [],
    schemas: {},
    primitives: {},
  };
}

describe("reduce over a fanOut parent (dynamic children)", () => {
  it("waits for the children and synthesizes over their outputs (no race)", async () => {
    const ir = buildIR();
    const runState = makeRunState(ir);

    let synthPrompt = "";

    const getAdapter = (_t?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "gen") {
        return createFakeAdapter({
          events: () => [
            { type: "session", id: "g" },
            {
              type: "done",
              sessionId: "g",
              finalText: '{"questions":["q1","q2","q3"]}',
              durationMs: 1,
              toolCallCount: 0,
            },
          ],
        });
      }
      if (nodeId && nodeId.startsWith("answer-")) {
        // Slow children: if the reduce races, it will run while these sleep.
        return createFakeAdapter({
          delayMs: 25,
          events: (ctx) => [
            { type: "session", id: nodeId },
            {
              type: "done",
              sessionId: nodeId,
              finalText: `ANSWER(${ctx?.prompt ?? ""})`,
              durationMs: 25,
              toolCallCount: 0,
            },
          ],
        });
      }
      // synth: agent-run synthesis (profile resolves → adapter used).
      const adapter = createFakeAdapter({});
      adapter.emitEvents = async (
        onEvent: (e: NormalizedEvent) => void,
        ctx?: NodeInvocationContext,
      ) => {
        synthPrompt = ctx?.prompt ?? "";
        onEvent({ type: "session", id: "synth" });
        onEvent({
          type: "done",
          sessionId: "synth",
          finalText: '{"primer":"merged"}',
          durationMs: 1,
          toolCallCount: 0,
        });
      };
      return adapter;
    };

    await executeDAG({
      ir,
      runState,
      getAdapter,
      scheduler: createScheduler(),
      profiles: { inlineProfiles: { default: { agentType: "pi" } } },
    });

    // Children all ran and completed.
    for (const id of ["answer-0", "answer-1", "answer-2"]) {
      expect(runState.nodes.get(id)?.status).toBe("completed");
      expect(runState.nodes.get(id)?.finalText).toContain("ANSWER");
    }

    // The reduce completed with the agent's merged output.
    const synthRt = runState.nodes.get("synth")!;
    expect(synthRt.status).toBe("completed");
    expect(synthRt.parsedOutput).toEqual({ primer: "merged" });

    // No race: synth started AFTER every child finished.
    for (const id of ["answer-0", "answer-1", "answer-2"]) {
      const childEnd = runState.nodes.get(id)!.endedAt!;
      expect(synthRt.startedAt!).toBeGreaterThanOrEqual(childEnd);
    }

    // The children's outputs reached the synthesizer's merge prompt.
    expect(synthPrompt).toContain("ANSWER(Answer: q1)");
    expect(synthPrompt).toContain("ANSWER(Answer: q2)");
    expect(synthPrompt).toContain("ANSWER(Answer: q3)");
  });

  it("skips the reduce when a fanOut child fails", async () => {
    const ir = buildIR();
    const runState = makeRunState(ir);

    const getAdapter = (_t?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "gen") {
        return createFakeAdapter({
          events: () => [
            { type: "session", id: "g" },
            {
              type: "done",
              sessionId: "g",
              finalText: '{"questions":["q1","q2"]}',
              durationMs: 1,
              toolCallCount: 0,
            },
          ],
        });
      }
      if (nodeId === "answer-1") {
        // Non-retryable failure.
        return createFakeAdapter({
          mode: "fail-after-events",
          failAfterEvents: 0,
          errorMessage: "child exploded",
        });
      }
      return createFakeAdapter({
        events: () => [
          { type: "session", id: nodeId ?? "x" },
          {
            type: "done",
            sessionId: nodeId ?? "x",
            finalText: "ok",
            durationMs: 1,
            toolCallCount: 0,
          },
        ],
      });
    };

    await executeDAG({
      ir,
      runState,
      getAdapter,
      scheduler: createScheduler(),
      profiles: { inlineProfiles: { default: { agentType: "pi" } } },
    });

    expect(runState.nodes.get("answer-1")?.status).toBe("failed");
    // The reduce is skipped (not left dangling in `ready`).
    expect(runState.nodes.get("synth")?.status).toBe("skipped");
  });
});

describe("expandFanOut wires children into downstream consumers", () => {
  it("adds dep edges from each child to the parent's dep consumers", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "producer", kind: "node", profileRef: "default", prompt: "p" },
        {
          id: "fan",
          kind: "fanOut",
          from: "producer",
          iterateFnRef: fn('(ctx) => ctx.output("producer").items', "iterate"),
          eachFnRef: fn(
            '(item) => ({ prompt: "x" + String(item), profileRef: "default" })',
            "each",
          ),
        },
        { id: "consumer", kind: "reduce", from: ["fan"], profileRef: "default" },
      ],
      edges: [
        { from: "producer", to: "fan", kind: "fanOut" },
        { from: "fan", to: "consumer", kind: "dep" },
      ],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = makeExecutorContext({ ir, runState: makeRunState(ir) });
    // Producer completed with 3 items.
    ctx.runState.nodes.get("producer")!.status = "completed";
    ctx.runState.nodes.get("producer")!.parsedOutput = { items: ["a", "b", "c"] };

    expandFanOut(ctx, ctx.nodeMap.get("fan")!);

    // Children created.
    expect([...ctx.nodeMap.keys()]).toContain("fan-0");
    expect([...ctx.nodeMap.keys()]).toContain("fan-2");
    // Each child is now a predecessor of the consumer, and a successor edge
    // exists child → consumer (so the consumer is the sink, not the children).
    const consumerPreds = ctx.predecessors.get("consumer")!;
    expect(consumerPreds).toEqual(expect.arrayContaining(["fan-0", "fan-1", "fan-2"]));
    for (const child of ["fan-0", "fan-1", "fan-2"]) {
      expect(ctx.successors.get(child)).toEqual(["consumer"]);
    }
  });

  it("does not add edges when the parent has no dep consumers", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "producer", kind: "node", profileRef: "default", prompt: "p" },
        {
          id: "fan",
          kind: "fanOut",
          from: "producer",
          iterateFnRef: fn('(ctx) => ctx.output("producer").items', "iterate"),
          eachFnRef: fn('(item) => ({ prompt: "x" + String(item) })', "each"),
        },
      ],
      edges: [{ from: "producer", to: "fan", kind: "fanOut" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = makeExecutorContext({ ir, runState: makeRunState(ir) });
    ctx.runState.nodes.get("producer")!.status = "completed";
    ctx.runState.nodes.get("producer")!.parsedOutput = { items: ["a", "b"] };

    expandFanOut(ctx, ctx.nodeMap.get("fan")!);

    // Children have no successors (no consumer to wire).
    expect(ctx.successors.get("fan-0")).toBeUndefined();
  });
});
