// Regression tests for two wisp gating bugs:
//   1. loop/reviewLoop must gate on `dependsOn` (loop edges are non-gating).
//   2. .sequence() must run steps IN ORDER (was concurrent — no step→step edges).
// These exercise the real DSL → IR → executeDAG path.

import { describe, it, expect } from "vitest";
import { wf } from "../../dsl/builder.js";
import { executeDAG } from "../../engine/executor.js";
import { createScheduler } from "../../engine/scheduler.js";
import { createFakeAdapter } from "../helpers/fake-adapter.js";
import { makeRunState } from "../helpers/fixtures.js";
import type { AgentAdapter, NormalizedEvent } from "../../adapters/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GATE_SCHEMA = {
  type: "object",
  properties: { accepted: { type: "boolean" } },
  required: ["accepted"],
};

describe("loop / reviewLoop dependsOn gating (regression)", () => {
  it("reviewLoop with dependsOn waits for the upstream node before running the worker", async () => {
    let upstreamDone = false;
    let workerSawUpstreamDone: boolean | null = null;
    const ir = wf("rl-gate", { defaultRetries: 0 })
      .node("up", { prompt: "up", profileRef: "default" })
      .reviewLoop("rl", {
        dependsOn: ["up"],
        worker: { prompt: "work", profileRef: "default" },
        gate: { prompt: "gate", profileRef: "default", outputSchema: GATE_SCHEMA },
        maxRounds: 1,
        acceptOn: (ctx) =>
          Boolean(
            (ctx as { output: (id: string) => { accepted?: boolean } }).output("rl:gate").accepted,
          ),
      })
      .toIR();
    const runState = makeRunState(ir);
    const getAdapter = (_t?: string, n?: string): AgentAdapter => {
      if (n === "up")
        return createFakeAdapter({
          events: async () => {
            await sleep(60);
            upstreamDone = true;
            return [
              { type: "session", id: "up" },
              {
                type: "done",
                sessionId: "up",
                finalText: "up-done",
                durationMs: 0,
                toolCallCount: 0,
              },
            ];
          },
        });
      if (n === "rl:worker")
        return createFakeAdapter({
          events: () => {
            workerSawUpstreamDone = upstreamDone;
            return [
              { type: "session", id: "w" },
              {
                type: "done",
                sessionId: "w",
                finalText: "worked",
                durationMs: 0,
                toolCallCount: 0,
              },
            ];
          },
        });
      if (n === "rl:gate")
        return createFakeAdapter({
          events: () => [
            { type: "session", id: "g" },
            {
              type: "done",
              sessionId: "g",
              finalText: JSON.stringify({ accepted: true }),
              durationMs: 0,
              toolCallCount: 0,
            },
          ],
        });
      return createFakeAdapter();
    };
    await executeDAG({
      ir,
      runState,
      getAdapter,
      scheduler: createScheduler({ maxAgentConcurrency: 4 }),
    });
    expect(workerSawUpstreamDone).toBe(true); // gated: worker ran only after upstream completed
    expect(runState.nodes.get("rl")?.status).toBe("completed");
  });

  it("reviewLoop with dependsOn is SKIPPED (not run) when the dependency fails", async () => {
    const ir = wf("rl-skip", { defaultRetries: 0 })
      .node("up", { prompt: "up", profileRef: "default" })
      .reviewLoop("rl", {
        dependsOn: ["up"],
        worker: { prompt: "work", profileRef: "default" },
        gate: { prompt: "gate", profileRef: "default", outputSchema: GATE_SCHEMA },
        maxRounds: 1,
      })
      .toIR();
    const runState = makeRunState(ir);
    let workerRan = false;
    const getAdapter = (_t?: string, n?: string): AgentAdapter => {
      if (n === "up")
        return createFakeAdapter({ mode: "retryable-error", errorMessage: "up failed" });
      if (n === "rl:worker") return createFakeAdapter({ events: () => ((workerRan = true), []) });
      return createFakeAdapter();
    };
    await executeDAG({
      ir,
      runState,
      getAdapter,
      scheduler: createScheduler({ maxAgentConcurrency: 4 }),
    });
    expect(runState.nodes.get("up")?.status).toBe("failed");
    expect(workerRan).toBe(false);
    // The loop node must be skipped (dep-failed), not left pending/running.
    expect(runState.nodes.get("rl")?.status).toBe("skipped");
  });

  it("plain .loop() with dependsOn waits for the upstream node", async () => {
    let upstreamDone = false;
    let workerSawUpstreamDone: boolean | null = null;
    const ir = wf("loop-gate", { defaultRetries: 0 })
      .node("up", { prompt: "up", profileRef: "default" })
      .node("worker", { prompt: "work", profileRef: "default" })
      .loop("L", { body: "worker", until: () => true, maxIterations: 1, dependsOn: ["up"] })
      .toIR();
    const runState = makeRunState(ir);
    const getAdapter = (_t?: string, n?: string): AgentAdapter => {
      if (n === "up")
        return createFakeAdapter({
          events: async () => {
            await sleep(60);
            upstreamDone = true;
            return [
              { type: "session", id: "up" },
              {
                type: "done",
                sessionId: "up",
                finalText: "up-done",
                durationMs: 0,
                toolCallCount: 0,
              },
            ];
          },
        });
      if (n === "worker")
        return createFakeAdapter({
          events: () => {
            workerSawUpstreamDone = upstreamDone;
            return [
              { type: "session", id: "w" },
              {
                type: "done",
                sessionId: "w",
                finalText: "worked",
                durationMs: 0,
                toolCallCount: 0,
              },
            ];
          },
        });
      return createFakeAdapter();
    };
    await executeDAG({
      ir,
      runState,
      getAdapter,
      scheduler: createScheduler({ maxAgentConcurrency: 4 }),
    });
    expect(workerSawUpstreamDone).toBe(true);
    expect(runState.nodes.get("L")?.status).toBe("completed");
  });
});

describe(".sequence() runs steps in order (regression)", () => {
  it("steps execute sequentially in the declared order, not concurrently", async () => {
    const order: string[] = [];
    const ir = wf("seq-order", { defaultRetries: 0 })
      .sequence("s", {
        steps: [
          { prompt: "a", profileRef: "default" },
          { prompt: "b", profileRef: "default" },
          { prompt: "c", profileRef: "default" },
        ],
      })
      .toIR();
    const runState = makeRunState(ir);
    const events = (id: string): NormalizedEvent[] => [
      { type: "session", id },
      { type: "done", sessionId: id, finalText: id, durationMs: 0, toolCallCount: 0 },
    ];
    const getAdapter = (_t?: string, n?: string): AgentAdapter => {
      if (!n) return createFakeAdapter();
      // Step b is made slow; if steps were concurrent, c could finish before b.
      if (n === "s:step:0") return createFakeAdapter({ events: () => (order.push(n), events(n)) });
      if (n === "s:step:1")
        return createFakeAdapter({
          events: async () => {
            await sleep(40);
            order.push(n);
            return events(n);
          },
        });
      if (n === "s:step:2") return createFakeAdapter({ events: () => (order.push(n), events(n)) });
      return createFakeAdapter();
    };
    await executeDAG({
      ir,
      runState,
      getAdapter,
      scheduler: createScheduler({ maxAgentConcurrency: 4 }),
    });
    expect(order).toEqual(["s:step:0", "s:step:1", "s:step:2"]);
    expect(runState.nodes.get("s")?.status).toBe("completed");
  });
});
