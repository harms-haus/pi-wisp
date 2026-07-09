/**
 * RED-phase tests — Engine control flow: cond + loop (S27 / PLAN §27).
 *
 * Pins the expected contract for conditional branching and loop iteration
 * against the PUBLIC `executeDAG` API. Every test is RED with the current
 * executor because it treats cond/loop nodes as structural placeholders that
 * complete immediately (no condition evaluation, no iteration).
 *
 * The implementer will:
 *   1. Wire `src/engine/loop.ts` helpers into the executor's Phase 2
 *      (replacing the "structural placeholders" block at executor.ts:275-284).
 *   2. Implement `evaluateCond` / `executeLoop` in loop.ts.
 *   3. These tests then transition from RED → GREEN.
 *
 * ### Failure modes (current executor vs contract)
 *
 * | Test                            | Current executor                        | Contract (what we assert)            |
 * |----------------------------------|----------------------------------------|--------------------------------------|
 * | cond truthy → then              | both branches run (completed)           | else branch → skipped (cond-not-taken)|
 * | cond falsy → else               | both branches run (completed)           | then branch → skipped (cond-not-taken)|
 * | loop until true                 | body runs ONCE (loop placeholder)       | body runs N times with transcript-replay |
 * | loop maxIterations              | body runs ONCE (loop placeholder)       | body runs EXACTLY maxIterations times |
 * | reviewLoop gate drives iteration| worker+gate run ONCE (loop placeholder)  | worker+gate run 2× (gate verdict drives iteration)|
 */

import { describe, it, expect } from "vitest";

// ── Engine modules under test ──────────────────────────────────
import { executeDAG } from "../../engine/executor.js";

// ── Scheduler ──────────────────────────────────────────────────
import { createScheduler } from "../../engine/scheduler.js";

// ── Fake adapter ────────────────────────────────────────────────
import { createFakeAdapter } from "../helpers/fake-adapter.js";
import { makeFakeAudit } from "../helpers/executor-context.js";

// ── Fixtures ───────────────────────────────────────────────────
import { makeRunState, fn } from "../helpers/fixtures.js";

// ── Types ───────────────────────────────────────────────────────
import type { GraphIR, NormalizedEvent } from "../../types.js";
import type { AgentAdapter, NodeInvocationContext } from "../../adapters/types.js";

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

/** Await a promise with a timeout so tests fail fast instead of hanging. */
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

/**
 * Minimal output-schema for a gate node that produces `{ accepted: boolean }`.
 * Shared across cond and reviewLoop tests.
 */
const GATE_SCHEMA = {
  type: "object" as const,
  properties: { accepted: { type: "boolean" as const } },
  required: ["accepted"],
};

/**
 * Minimal output-schema for a worker/body node that produces
 * `{ done: boolean }`. Shared across loop tests.
 */
const DONE_SCHEMA = {
  type: "object" as const,
  properties: { done: { type: "boolean" as const } },
  required: ["done"],
};

// ══════════════════════════════════════════════════════════════════════
// Cond branching
// ══════════════════════════════════════════════════════════════════════

describe("cond branching - RED (expected to fail)", () => {
  const condThenIR: GraphIR = {
    title: "cond-then",
    slug: "cond-then",
    options: { defaultRetries: 0 },
    nodes: [
      {
        id: "gate",
        kind: "node",
        profileRef: "default",
        prompt: "Review the completed work",
        outputSchema: GATE_SCHEMA,
      },
      {
        id: "decide",
        kind: "cond",
        on: "gate",
        whenFnRef: fn('(ctx) => Boolean(ctx.output("gate").accepted)', "cond"),
        then: "approve" as string,
        else: "reject" as string,
      },
      { id: "approve", kind: "node", profileRef: "default", prompt: "Approve and finalize" },
      { id: "reject", kind: "node", profileRef: "default", prompt: "Report issues and reject" },
    ],
    edges: [
      { from: "gate", to: "decide", kind: "dep" },
      { from: "decide", to: "approve", kind: "cond:branch" },
      { from: "decide", to: "reject", kind: "cond:branch" },
    ],
    conditions: [],
    schemas: { gate: GATE_SCHEMA },
    primitives: {},
  };

  it("routes to 'then' when when(ctx) returns truthy — 'else' branch is SKIPPED with cond-not-taken", async () => {
    const runState = makeRunState(condThenIR);

    // Gate outputs { accepted: true } → whenFn returns true → route to "approve"
    const gateAdapter = createFakeAdapter({
      sessionId: "gate-accepted",
      finalText: JSON.stringify({ accepted: true }),
      durationMs: 5,
    });

    const thenAdapter = createFakeAdapter({
      sessionId: "approve-sess",
      finalText: "approved!",
      durationMs: 5,
    });

    const elseAdapter = createFakeAdapter({
      sessionId: "reject-sess",
      finalText: "rejected!",
      durationMs: 5,
    });

    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "gate") return gateAdapter;
      if (nodeId === "approve") return thenAdapter;
      if (nodeId === "reject") return elseAdapter;
      // Cond node (decide) currently uses the structural-placeholder path
      // and never calls getAdapter; provide a fallback for robustness.
      return createFakeAdapter({ sessionId: "fallback", durationMs: 5 });
    };

    await withTimeout(
      executeDAG({
        ir: condThenIR,
        runState,
        getAdapter: getAdapter,
        scheduler: createScheduler({ maxAgentConcurrency: 4 }),
      }),
    );

    // ── RED assertions (expected to fail with current executor) ──

    // The gate should complete (it ran normally)
    expect(runState.nodes.get("gate")?.status).toBe("completed");

    // The cond node should complete (it evaluated the condition)
    expect(runState.nodes.get("decide")?.status).toBe("completed");

    // The `then` branch runs → completed
    expect(runState.nodes.get("approve")?.status).toBe("completed");

    // The `else` branch is SKIPPED with reason "cond-not-taken"
    // CURRENT FAILURE: else branch also runs → status is "completed", not "skipped"
    expect(runState.nodes.get("reject")?.status).toBe("skipped");
    expect(runState.nodes.get("reject")?.error).toBe("cond-not-taken");
  });

  it("emits audit node.start/complete for the cond and node.skip for the untaken branch", async () => {
    const runState = makeRunState(condThenIR);
    const audit = makeFakeAudit();

    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "gate")
        return createFakeAdapter({
          sessionId: "gate-accepted",
          finalText: JSON.stringify({ accepted: true }),
          durationMs: 5,
        });
      if (nodeId === "approve")
        return createFakeAdapter({
          sessionId: "approve-sess",
          finalText: "approved!",
          durationMs: 5,
        });
      return createFakeAdapter({ sessionId: "fallback", durationMs: 5 });
    };

    await withTimeout(
      executeDAG({
        ir: condThenIR,
        runState,
        getAdapter,
        scheduler: createScheduler({ maxAgentConcurrency: 4 }),
        audit,
      }),
    );

    const startedIds = audit.nodeStart.mock.calls.map((c) => c[0]);
    const completedIds = audit.nodeComplete.mock.calls.map((c) => c[0]);
    // The cond node itself has a start + complete event.
    expect(startedIds).toContain("decide");
    expect(completedIds).toContain("decide");
    // The untaken 'else' branch is recorded as skipped (cond-not-taken).
    const skipCalls = audit.nodeSkip.mock.calls.map((c) => [c[0], c[1]]);
    expect(skipCalls).toContainEqual(["reject", "cond-not-taken"]);
  });

  // ── Inline NodeSpec branches (the common DSL form) ───────────────
  // Regression: inline then/else branches were stored on the cond node but
  // never materialized into graph nodes, so the chosen branch silently never
  // ran. Now they are expanded into dynamic `<condId>:then` / `<condId>:else`
  // nodes (mirroring fanOut child expansion).
  const condInlineIR: GraphIR = {
    title: "cond-inline",
    slug: "cond-inline",
    options: { defaultRetries: 0 },
    nodes: [
      {
        id: "gate",
        kind: "node",
        profileRef: "default",
        prompt: "Review",
        outputSchema: GATE_SCHEMA,
      },
      {
        id: "decide",
        kind: "cond",
        on: "gate",
        whenFnRef: fn('(ctx) => Boolean(ctx.output("gate").accepted)', "cond"),
        then: { prompt: "Escalate to oncall", profileRef: "default" },
        else: { prompt: "Handle normally", profileRef: "default" },
      },
    ],
    // NO cond:branch edges and NO approve/reject nodes — branches are inline.
    edges: [{ from: "gate", to: "decide", kind: "dep" }],
    conditions: [],
    schemas: {},
    primitives: {},
  };

  it("materializes an inline then-branch and runs it (else is skipped)", async () => {
    const runState = makeRunState(condInlineIR);
    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "gate")
        return createFakeAdapter({
          sessionId: "g",
          finalText: JSON.stringify({ accepted: true }),
          durationMs: 5,
        });
      if (nodeId === "decide:then")
        return createFakeAdapter({ sessionId: "t", finalText: "escalated!", durationMs: 5 });
      return createFakeAdapter({
        sessionId: "fallback",
        finalText: "should-not-run",
        durationMs: 5,
      });
    };

    await withTimeout(
      executeDAG({
        ir: condInlineIR,
        runState,
        getAdapter,
        scheduler: createScheduler({ maxAgentConcurrency: 4 }),
      }),
    );

    expect(runState.nodes.get("gate")?.status).toBe("completed");
    expect(runState.nodes.get("decide")?.status).toBe("completed");
    // The chosen then-branch was materialized and RAN.
    const thenRt = runState.nodes.get("decide:then");
    expect(thenRt?.status).toBe("completed");
    expect(thenRt?.finalText).toBe("escalated!");
    // The untaken else-branch was materialized and SKIPPED.
    const elseRt = runState.nodes.get("decide:else");
    expect(elseRt?.status).toBe("skipped");
    expect(elseRt?.error).toBe("cond-not-taken");
  });

  it("materializes an inline else-branch and runs it (then is skipped)", async () => {
    const runState = makeRunState(condInlineIR);
    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "gate")
        return createFakeAdapter({
          sessionId: "g",
          finalText: JSON.stringify({ accepted: false }),
          durationMs: 5,
        });
      if (nodeId === "decide:else")
        return createFakeAdapter({ sessionId: "e", finalText: "handled!", durationMs: 5 });
      return createFakeAdapter({
        sessionId: "fallback",
        finalText: "should-not-run",
        durationMs: 5,
      });
    };

    await withTimeout(
      executeDAG({
        ir: condInlineIR,
        runState,
        getAdapter,
        scheduler: createScheduler({ maxAgentConcurrency: 4 }),
      }),
    );

    const elseRt = runState.nodes.get("decide:else");
    expect(elseRt?.status).toBe("completed");
    expect(elseRt?.finalText).toBe("handled!");
    expect(runState.nodes.get("decide:then")?.status).toBe("skipped");
    expect(runState.nodes.get("decide:then")?.error).toBe("cond-not-taken");
  });

  it("routes to 'else' when when(ctx) returns falsy — 'then' branch is SKIPPED with cond-not-taken", async () => {
    const runState = makeRunState(condThenIR);

    // Gate outputs { accepted: false } → whenFn returns false → route to "reject"
    const gateAdapter = createFakeAdapter({
      sessionId: "gate-rejected",
      finalText: JSON.stringify({ accepted: false }),
      durationMs: 5,
    });

    const thenAdapter = createFakeAdapter({
      sessionId: "approve-sess",
      finalText: "approved!",
      durationMs: 5,
    });

    const elseAdapter = createFakeAdapter({
      sessionId: "reject-sess",
      finalText: "rejected!",
      durationMs: 5,
    });

    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "gate") return gateAdapter;
      if (nodeId === "approve") return thenAdapter;
      if (nodeId === "reject") return elseAdapter;
      return createFakeAdapter({ sessionId: "fallback", durationMs: 5 });
    };

    await withTimeout(
      executeDAG({
        ir: condThenIR,
        runState,
        getAdapter: getAdapter,
        scheduler: createScheduler({ maxAgentConcurrency: 4 }),
      }),
    );

    // ── RED assertions (expected to fail with current executor) ──

    // The gate and cond should complete
    expect(runState.nodes.get("gate")?.status).toBe("completed");
    expect(runState.nodes.get("decide")?.status).toBe("completed");

    // The `else` branch runs → completed
    expect(runState.nodes.get("reject")?.status).toBe("completed");

    // The `then` branch is SKIPPED with reason "cond-not-taken"
    // CURRENT FAILURE: then branch also runs → status is "completed", not "skipped"
    expect(runState.nodes.get("approve")?.status).toBe("skipped");
    expect(runState.nodes.get("approve")?.error).toBe("cond-not-taken");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Loop — basic iteration + transcript-replay
// ══════════════════════════════════════════════════════════════════════

describe("loop - RED (expected to fail)", () => {
  const loopIR: GraphIR = {
    title: "loop-test",
    slug: "loop-test",
    options: { defaultRetries: 0 },
    nodes: [
      {
        id: "iterate",
        kind: "loop",
        body: "worker",
        untilFnRef: fn('(ctx) => Boolean(ctx.output("worker").done)', "until"),
        maxIterations: 3,
      },
      {
        id: "worker",
        kind: "node",
        profileRef: "default",
        prompt: "Perform one iteration of work",
        outputSchema: DONE_SCHEMA,
      },
    ],
    edges: [{ from: "iterate", to: "worker", kind: "loop" }],
    conditions: [],
    schemas: { worker: DONE_SCHEMA },
    primitives: {},
  };

  it("runs the body until until(ctx) returns true — body executes N times with transcript-replay", async () => {
    const runState = makeRunState(loopIR);

    let workerCalls = 0;
    const prompts: string[] = [];

    const workerAdapter = createFakeAdapter({
      events: (ctx?: NodeInvocationContext): NormalizedEvent[] => {
        workerCalls++;
        prompts.push(ctx?.prompt ?? "");

        // First call: not done → continue; second call: done → stop
        const doneValue = workerCalls >= 2;

        return [
          { type: "session", id: `worker-${workerCalls}` },
          {
            type: "done",
            sessionId: `worker-${workerCalls}`,
            finalText: JSON.stringify({ done: doneValue }),
            durationMs: 5,
            toolCallCount: 0,
          },
        ];
      },
    });

    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "worker") return workerAdapter;
      return createFakeAdapter({ sessionId: "fallback", durationMs: 5 });
    };

    await withTimeout(
      executeDAG({
        ir: loopIR,
        runState,
        getAdapter: getAdapter,
        scheduler: createScheduler({ maxAgentConcurrency: 3 }),
      }),
    );

    // ── RED assertions (expected to fail with current executor) ──

    // Loop node should complete
    expect(runState.nodes.get("iterate")?.status).toBe("completed");

    // Worker should have run exactly 2 times:
    //   iteration 1: outputs { done: false } → until returns false → continue
    //   iteration 2: outputs { done: true } → until returns true → stop
    // CURRENT FAILURE: worker runs ONCE (loop is structural placeholder)
    expect(workerCalls).toBe(2);

    // Second+ iterations should use transcript-replay (D4):
    // the prompt should contain the prior session's transcript via
    // adapter.buildResumePrompt which prefixes with "Previously:\n\n"
    // CURRENT FAILURE: only one prompt exists → prompts[1] is undefined
    expect(prompts[1]).toBeDefined();
    expect(prompts[1]).toContain("Previously:");
    // STRENGTHEN: assert the transcript contains the PRIOR iteration's actual
    // finalText (iteration 1 output: { done: false }).
    expect(prompts[1]).toContain('{"done":false}');

    // Worker should be completed (last iteration succeeded)
    expect(runState.nodes.get("worker")?.status).toBe("completed");
  });

  it("enforces maxIterations — body runs exactly maxIterations times when until never accepts", async () => {
    // Override until to always return false (never accepts)
    const neverAcceptIR: GraphIR = {
      ...loopIR,
      nodes: loopIR.nodes.map((n) => {
        if (n.kind === "loop") {
          return {
            ...n,
            untilFnRef: fn("() => false", "until" as const),
            maxIterations: 3,
          };
        }
        return n;
      }),
    };

    const runState = makeRunState(neverAcceptIR);

    let workerCalls = 0;

    const workerAdapter = createFakeAdapter({
      events: (): NormalizedEvent[] => {
        workerCalls++;
        return [
          { type: "session", id: `worker-${workerCalls}` },
          {
            type: "done",
            sessionId: `worker-${workerCalls}`,
            finalText: JSON.stringify({ done: false }),
            durationMs: 5,
            toolCallCount: 0,
          },
        ];
      },
    });

    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "worker") return workerAdapter;
      return createFakeAdapter({ sessionId: "fallback", durationMs: 5 });
    };

    await withTimeout(
      executeDAG({
        ir: neverAcceptIR,
        runState,
        getAdapter: getAdapter,
        scheduler: createScheduler({ maxAgentConcurrency: 3 }),
      }),
    );

    // ── RED assertions (expected to fail with current executor) ──

    // Loop node should complete (no error — maxIterations is a hard cap)
    expect(runState.nodes.get("iterate")?.status).toBe("completed");

    // Worker should run EXACTLY maxIterations = 3 times, not fewer
    // CURRENT FAILURE: worker runs ONCE (loop is structural placeholder)
    expect(workerCalls).toBe(3);

    // Worker should be completed
    expect(runState.nodes.get("worker")?.status).toBe("completed");
  });
});

// ══════════════════════════════════════════════════════════════════════
// reviewLoop — gate verdict-driven iteration
// ══════════════════════════════════════════════════════════════════════

describe("reviewLoop gate - RED (expected to fail)", () => {
  /**
   * A reviewLoop graph matching the expandReviewLoop macro structure
   * (PLAN §4.3 / S12):
   *
   *   worker → gate → loop(until=acceptOn)
   *
   * The loop `body` references the worker. The gate depends on the worker.
   * The `until` function checks `ctx.output("gate").accepted` — the gate's
   * verdict drives iteration.
   */
  const reviewLoopIR: GraphIR = {
    title: "reviewLoop-test",
    slug: "reviewLoop-test",
    options: { defaultRetries: 0 },
    nodes: [
      {
        id: "worker",
        kind: "node",
        profileRef: "default",
        prompt: "Fix the code",
        outputSchema: {
          type: "object" as const,
          properties: { fix: { type: "string" as const } },
          required: ["fix"],
        },
      },
      {
        id: "gate",
        kind: "node",
        profileRef: "default",
        prompt: "Review the fix",
        dependsOn: ["worker"],
        outputSchema: GATE_SCHEMA,
      },
      {
        id: "review",
        kind: "loop",
        body: "worker",
        // acceptOn checks the gate's verdict: `ctx.output("gate").accepted`
        untilFnRef: fn('(ctx) => Boolean(ctx.output("gate").accepted)', "acceptOn"),
        maxIterations: 3,
      },
    ],
    edges: [
      { from: "worker", to: "gate", kind: "dep" },
      { from: "review", to: "worker", kind: "loop" },
    ],
    conditions: [],
    schemas: {
      worker: {
        type: "object" as const,
        properties: { fix: { type: "string" as const } },
        required: ["fix"],
      },
      gate: GATE_SCHEMA,
    },
    primitives: {},
  };

  it("gate node's accept/reject drives iteration via acceptOn", async () => {
    const runState = makeRunState(reviewLoopIR);

    // Track how many times each node runs so we can assert iteration count.
    // Worker produces output regardless; gate produces accepted=true/false.
    let iteration = 0;
    const workerPrompts: string[] = [];

    const workerAdapter = createFakeAdapter({
      events: (ctx?: NodeInvocationContext): NormalizedEvent[] => {
        iteration++;
        workerPrompts.push(ctx?.prompt ?? "");

        return [
          { type: "session", id: `worker-${iteration}` },
          {
            type: "done",
            sessionId: `worker-${iteration}`,
            finalText: JSON.stringify({ fix: `fixed issue in round ${iteration}` }),
            durationMs: 5,
            toolCallCount: 0,
          },
        ];
      },
    });

    // Gate reviews the worker output; accepts on 3rd+ iteration but let's
    // accept on iteration 2 (after 2 rounds of worker runs).
    // On the first iteration (iteration === 1): gate sees worker round 1 → rejected
    // On the second iteration (iteration === 2): gate sees worker round 2 → accepted
    let gateCalls = 0;
    const gatePrompts: string[] = [];

    const gateAdapter = createFakeAdapter({
      events: (ctx?: NodeInvocationContext): NormalizedEvent[] => {
        gateCalls++;
        gatePrompts.push(ctx?.prompt ?? "");

        // Accept after 2 rounds of worker runs
        const accepted = iteration >= 2;

        return [
          { type: "session", id: `gate-${gateCalls}` },
          {
            type: "done",
            sessionId: `gate-${gateCalls}`,
            finalText: JSON.stringify({ accepted }),
            durationMs: 5,
            toolCallCount: 0,
          },
        ];
      },
    });

    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "worker") return workerAdapter;
      if (nodeId === "gate") return gateAdapter;
      return createFakeAdapter({ sessionId: "fallback", durationMs: 5 });
    };

    await withTimeout(
      executeDAG({
        ir: reviewLoopIR,
        runState,
        getAdapter: getAdapter,
        scheduler: createScheduler({ maxAgentConcurrency: 4 }),
      }),
    );

    // ── RED assertions (expected to fail with current executor) ──

    // The loop node should complete
    expect(runState.nodes.get("review")?.status).toBe("completed");

    // Worker should have run 2 times (round 1: rejected, round 2: accepted)
    // CURRENT FAILURE: worker runs ONCE (loop is structural placeholder)
    expect(iteration).toBe(2);

    // Gate should have run 2 times (once per worker run)
    // CURRENT FAILURE: gate runs ONCE
    expect(gateCalls).toBe(2);

    // Second worker run should use transcript-replay (D4)
    // CURRENT FAILURE: only one worker prompt exists → workerPrompts[1] is undefined
    expect(workerPrompts[1]).toBeDefined();
    expect(workerPrompts[1]).toContain("Previously:");
    // STRENGTHEN: assert the transcript contains the PRIOR iteration's actual
    // worker output (round 1: fixed issue in round 1).
    expect(workerPrompts[1]).toContain("fixed issue in round 1");

    // All nodes completed
    expect(runState.nodes.get("worker")?.status).toBe("completed");
    expect(runState.nodes.get("gate")?.status).toBe("completed");
  });
});
