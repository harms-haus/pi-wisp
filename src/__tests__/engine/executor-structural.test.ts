/**
 * Characterization tests — structural node kinds through executeDAG.
 *
 * These pin the orchestrator-level behavior for node kinds that are NOT
 * extracted into a dedicated module (parallel / sequence complete as
 * placeholders in the executeDAG main loop; reduce is dispatched but its
 * per-node logic moves to reduce-node.ts). They PASS against the current
 * monolithic executor and MUST continue to pass after the split into
 * executor-types / fanout / run-node / reduce-node — they are the
 * behavior-preserving safety net for the orchestrator wiring.
 *
 * Coverage: plain, parallel, sequence, reduce (pure-JS + agent-run).
 */

import { describe, it, expect } from "vitest";

import { executeDAG } from "../../engine/executor.js";
import { createScheduler } from "../../engine/scheduler.js";
import { createFakeAdapter } from "../helpers/fake-adapter.js";
import { makeRunState } from "../helpers/fixtures.js";

import type { AgentAdapter, NodeInvocationContext } from "../../adapters/types.js";
import type { GraphIR, NormalizedEvent } from "../../types.js";

function withTimeout<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => {
        reject(new Error(`Timeout after ${ms}ms`));
      }, ms),
    ),
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════

describe("executeDAG structural placeholders (behavior-preserving)", () => {
  it("a parallel node completes immediately as a placeholder and unblocks dependents", async () => {
    const ir: GraphIR = {
      title: "parallel",
      slug: "parallel",
      options: {},
      nodes: [
        { id: "par", kind: "parallel" },
        { id: "after", kind: "node", profileRef: "default", prompt: "after", dependsOn: ["par"] },
      ],
      edges: [{ from: "par", to: "after", kind: "dep" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = makeRunState(ir);
    const adapter = createFakeAdapter({ sessionId: "s", finalText: "ok", durationMs: 2 });

    await withTimeout(
      executeDAG({ ir, runState, getAdapter: () => adapter, scheduler: createScheduler() }),
    );

    expect(runState.nodes.get("par")?.status).toBe("completed");
    expect(runState.nodes.get("after")?.status).toBe("completed");
  });

  it("a sequence node completes immediately as a placeholder and unblocks dependents", async () => {
    const ir: GraphIR = {
      title: "sequence",
      slug: "sequence",
      options: {},
      nodes: [
        { id: "seq", kind: "sequence", steps: ["a", "b"] },
        { id: "after", kind: "node", profileRef: "default", prompt: "after", dependsOn: ["seq"] },
      ],
      edges: [{ from: "seq", to: "after", kind: "dep" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = makeRunState(ir);
    const adapter = createFakeAdapter({ sessionId: "s", finalText: "ok", durationMs: 2 });

    await withTimeout(
      executeDAG({ ir, runState, getAdapter: () => adapter, scheduler: createScheduler() }),
    );

    expect(runState.nodes.get("seq")?.status).toBe("completed");
    expect(runState.nodes.get("after")?.status).toBe("completed");
  });

  it("a reduce node with no profile pure-JS-merges completed members", async () => {
    const ir: GraphIR = {
      title: "reduce-pure",
      slug: "reduce-pure",
      options: {},
      nodes: [
        {
          id: "m1",
          kind: "node",
          profileRef: "default",
          prompt: "m1",
          outputSchema: { type: "object", properties: { a: { type: "number" } } },
        },
        {
          id: "m2",
          kind: "node",
          profileRef: "default",
          prompt: "m2",
          outputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
        },
        { id: "r", kind: "reduce", from: ["m1", "m2"] },
      ],
      edges: [
        { from: "m1", to: "r", kind: "dep" },
        { from: "m2", to: "r", kind: "dep" },
      ],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = makeRunState(ir);

    // Each member emits a distinct structured object so the merge has objects
    // to deep-merge.
    const getAdapter = (_t?: string, nodeId?: string): AgentAdapter => {
      const a = createFakeAdapter({});
      a.emitEvents = async (onEvent: (event: NormalizedEvent) => void): Promise<void> => {
        const sess = nodeId === "m1" ? "m1" : "m2";
        onEvent({ type: "session", id: sess });
        onEvent({
          type: "done",
          sessionId: sess,
          finalText: nodeId === "m1" ? '{"a": 1}' : '{"a": 2, "b": 3}',
          durationMs: 1,
          toolCallCount: 0,
        });
      };
      return a;
    };

    await withTimeout(executeDAG({ ir, runState, getAdapter, scheduler: createScheduler() }));

    expect(runState.nodes.get("m1")?.status).toBe("completed");
    expect(runState.nodes.get("m2")?.status).toBe("completed");
    expect(runState.nodes.get("r")?.status).toBe("completed");
    // Deep merge: last-writer-wins for `a`, b preserved.
    expect(runState.nodes.get("r")?.parsedOutput).toEqual({ a: 2, b: 3 });
  });

  it("a reduce node with a profile dispatches agent-run synthesis", async () => {
    const ir: GraphIR = {
      title: "reduce-agent",
      slug: "reduce-agent",
      options: {},
      nodes: [
        { id: "m1", kind: "node", profileRef: "default", prompt: "m1" },
        { id: "r", kind: "reduce", from: ["m1"], profileRef: "default", agentType: "pi" },
      ],
      edges: [{ from: "m1", to: "r", kind: "dep" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = makeRunState(ir);

    const getAdapter = (_t?: string, _nodeId?: string): AgentAdapter => {
      const a = createFakeAdapter({});
      a.emitEvents = async (
        onEvent: (event: NormalizedEvent) => void,
        ctx?: NodeInvocationContext,
      ): Promise<void> => {
        const isSynth = ctx?.nodeId === "synthesis";
        const sess = isSynth ? "synth-sess" : "m1-sess";
        onEvent({ type: "session", id: sess });
        onEvent({
          type: "done",
          sessionId: sess,
          finalText: isSynth ? '{"synthesized": true}' : '{"member": true}',
          durationMs: 1,
          toolCallCount: 0,
        });
      };
      return a;
    };

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter,
        scheduler: createScheduler(),
        profiles: { inlineProfiles: { default: { agentType: "pi" } } },
      }),
    );

    expect(runState.nodes.get("m1")?.status).toBe("completed");
    expect(runState.nodes.get("r")?.status).toBe("completed");
    expect(runState.nodes.get("r")?.parsedOutput).toEqual({ synthesized: true });
  });
});
