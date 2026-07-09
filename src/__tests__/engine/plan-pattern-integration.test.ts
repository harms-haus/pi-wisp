// Integration stress-test of the worktree-plan task pattern:
//   Task = reviewLoop(impl) → reviewLoop(tests) → verify(node), chained across
//   tasks via dependsOn, with gate-driven iteration (reject then approve).
// Validates that the combination of fixes (loop dependsOn gating + body-not-
// leaking + gate-driven acceptOn) works end-to-end as the plan will use them.

import { describe, it, expect } from "vitest";
import { wf } from "../../dsl/builder.js";
import { executeDAG } from "../../engine/executor.js";
import { createScheduler } from "../../engine/scheduler.js";
import { createFakeAdapter } from "../helpers/fake-adapter.js";
import { makeRunState } from "../helpers/fixtures.js";
import type { AgentAdapter, NormalizedEvent } from "../../adapters/types.js";

const APPROVED = {
  type: "object",
  properties: { approved: { type: "boolean" } },
  required: ["approved"],
};
const done = (id: string): NormalizedEvent[] => [
  { type: "session", id },
  {
    type: "done",
    sessionId: id,
    finalText: JSON.stringify({ approved: true }),
    durationMs: 0,
    toolCallCount: 0,
  },
];

describe("plan-pattern integration: chained reviewLoop tasks", () => {
  it("task B's impl runs only after task A's verify; gates drive iteration; no body leak", async () => {
    const log: string[] = [];
    let aImplWorkerCalls = 0;
    let aVerifyDone = false;

    // Task A: impl (gate rejects once, then approves) → tests → verify.
    // Task B: impl (dependsOn A-verify) → verify.
    const ir = wf("plan-pattern", { defaultRetries: 0 })
      .reviewLoop("A-impl", {
        worker: { prompt: "impl A", profileRef: "w" },
        gate: { prompt: "review A", profileRef: "g", outputSchema: APPROVED },
        maxRounds: 3,
        acceptOn: (ctx) =>
          Boolean(
            (ctx as { output: (id: string) => { approved?: boolean } }).output("A-impl:gate")
              .approved,
          ),
      })
      .reviewLoop("A-tests", {
        dependsOn: ["A-impl"],
        worker: { prompt: "test A", profileRef: "w" },
        gate: { prompt: "review tests A", profileRef: "g", outputSchema: APPROVED },
        maxRounds: 1,
        acceptOn: (ctx) =>
          Boolean(
            (ctx as { output: (id: string) => { approved?: boolean } }).output("A-tests:gate")
              .approved,
          ),
      })
      .node("A-verify", { dependsOn: ["A-tests"], prompt: "verify A", profileRef: "v" })
      .reviewLoop("B-impl", {
        dependsOn: ["A-verify"],
        worker: { prompt: "impl B", profileRef: "w" },
        gate: { prompt: "review B", profileRef: "g", outputSchema: APPROVED },
        maxRounds: 1,
        acceptOn: (ctx) =>
          Boolean(
            (ctx as { output: (id: string) => { approved?: boolean } }).output("B-impl:gate")
              .approved,
          ),
      })
      .node("B-verify", { dependsOn: ["B-impl"], prompt: "verify B", profileRef: "v" })
      .toIR();

    const runState = makeRunState(ir);
    const getAdapter = (_t?: string, n?: string): AgentAdapter => {
      // A-impl worker: count calls; runs only via the loop (no Phase-2b leak).
      if (n === "A-impl:worker")
        return createFakeAdapter({
          events: () => {
            aImplWorkerCalls++;
            log.push(`A-impl:worker#${aImplWorkerCalls}`);
            return done("aw");
          },
        });
      // A-impl gate: reject on round 1, approve on round 2 → drives iteration.
      if (n === "A-impl:gate")
        return createFakeAdapter({
          events: () => {
            const approved = aImplWorkerCalls >= 2;
            log.push(`A-impl:gate(approved=${approved})`);
            return [
              { type: "session", id: "ag" },
              {
                type: "done",
                sessionId: "ag",
                finalText: JSON.stringify({ approved }),
                durationMs: 0,
                toolCallCount: 0,
              },
            ];
          },
        });
      if (n === "A-verify")
        return createFakeAdapter({
          events: () => {
            aVerifyDone = true;
            log.push("A-verify");
            return done("av");
          },
        });
      // B-impl worker must run ONLY after A-verify completed (gated cross-task).
      if (n === "B-impl:worker")
        return createFakeAdapter({
          events: () => {
            log.push(`B-impl:worker(sawAVerify=${aVerifyDone})`);
            return done("bw");
          },
        });
      if (n === "B-verify")
        return createFakeAdapter({
          events: () => {
            log.push("B-verify");
            return done("bv");
          },
        });
      // All other gates/workers (A-tests:*) approve immediately.
      return createFakeAdapter({ events: () => done(n ?? "x") });
    };

    await executeDAG({
      ir,
      runState,
      getAdapter,
      scheduler: createScheduler({ maxAgentConcurrency: 4 }),
    });

    // 1. Gate-driven iteration: A-impl worker ran twice (reject then approve).
    expect(aImplWorkerCalls).toBe(2);
    // 2. Cross-task gating: B-impl worker ran AFTER A-verify completed.
    expect(aVerifyDone).toBe(true);
    expect(log.join(" ")).toContain("B-impl:worker(sawAVerify=true)");
    // 3. Ordering: A-verify precedes B-impl worker in the log.
    const aVerifyIdx = log.findIndex((e) => e === "A-verify");
    const bImplWorkerIdx = log.findIndex((e) => e.startsWith("B-impl:worker"));
    expect(aVerifyIdx).toBeGreaterThanOrEqual(0);
    expect(bImplWorkerIdx).toBeGreaterThanOrEqual(0);
    expect(aVerifyIdx).toBeLessThan(bImplWorkerIdx);
    // 4. Everything completed.
    for (const id of ["A-impl", "A-tests", "A-verify", "B-impl", "B-verify"]) {
      expect(runState.nodes.get(id)?.status).toBe("completed");
    }
  });
});
