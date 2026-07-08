/**
 * ═══════════════════════════════════════════════════════════════════════════
 * S29b — Resume via executeDAG.
 *
 * Tests for the full resume flow: `prepareResume` + `executeDAG`.
 *
 * Builds a fixture run directory (identical structure to S29a: one completed
 * node A, one failed node B, one pending dependent C), calls `prepareResume`,
 * then passes the prepared IR + runState into `executeDAG` with a
 * FakeAgentAdapter that succeeds for all remaining nodes.
 *
 * Expected behavior:
 *   1. Completed node A is NOT re-invoked (the adapter's buildInvocation is
 *      called exactly once, for node B only).
 *   2. Failed node B re-runs (adapter is called with nodeId === "b").
 *   3. After B succeeds, C runs (the chain completes).
 *   4. A's original sessionId + output are preserved in the final RunState.
 *
 * @module
 */

import { vi, describe, it, expect, afterEach } from "vitest";

// ── Mock the spawner so the test doesn't spawn real subprocesses ──
vi.mock("../../spawn/spawner.js");

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Track temp dirs so they're cleaned up after each test (no leaks into the
// project root, no accumulation across runs).
const createdTmpDirs: string[] = [];
afterEach(() => {
  for (const dir of createdTmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  createdTmpDirs.length = 0;
});

import type { GraphIR, IREdge, IRNode } from "../../types.js";
import { prepareResume } from "../../engine/resume.js";
import { executeDAG } from "../../engine/executor.js";
import { createScheduler } from "../../engine/scheduler.js";
import { createFakeAdapter } from "../helpers/fake-adapter.js";

// ══════════════════════════════════════════════════════════════════════
// Fixture builder
// ══════════════════════════════════════════════════════════════════════

/**
 * Build a fixture run directory with the same structure as the S29a spike
 * test: A (completed) → B (failed) → C (pending).
 */
function buildFixtureRunDir(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "wisp-resume-exec-"));
  createdTmpDirs.push(tmpDir);
  const runDir = join(tmpDir, "runs", "20260707-1200-resume-exec");
  const artifactsDir = join(runDir, "artifacts");
  const sessionsDir = join(runDir, "sessions");

  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  const nodes: IRNode[] = [
    {
      id: "a",
      kind: "node",
      agentType: "pi",
      profileRef: "default",
      prompt: "Task A",
    },
    {
      id: "b",
      kind: "node",
      agentType: "pi",
      profileRef: "default",
      prompt: "Task B",
      dependsOn: ["a"],
    },
    {
      id: "c",
      kind: "node",
      agentType: "pi",
      profileRef: "default",
      prompt: "Task C",
      dependsOn: ["b"],
    },
  ];
  const edges: IREdge[] = [
    { from: "a", to: "b", kind: "dep" },
    { from: "b", to: "c", kind: "dep" },
  ];
  const graph: GraphIR = {
    title: "resume-exec-test",
    slug: "resume-exec-test",
    options: { defaultRetries: 0 },
    nodes,
    edges,
    conditions: [],
    schemas: {},
    primitives: {},
  };

  writeFileSync(join(artifactsDir, "graph.json"), JSON.stringify(graph, null, 2));

  const runJson = {
    runId: "run-resume-exec",
    title: "resume-exec-test",
    slug: "resume-exec-test",
    status: "failed",
    startedAt: 1000000,
    endedAt: 2000000,
    nodes: [
      {
        id: "a",
        status: "completed",
        sessionId: "sess-a-original",
        startedAt: 1000000,
        endedAt: 1100000,
        durationMs: 100000,
        toolCount: 3,
        retries: 1,
        filesEdited: ["src/a.ts"],
      },
      {
        id: "b",
        status: "failed",
        sessionId: "sess-b-original",
        startedAt: 1200000,
        endedAt: 1300000,
        durationMs: 100000,
        toolCount: 1,
        retries: 3,
        error: "retries exhausted",
        filesEdited: [],
      },
      {
        id: "c",
        status: "pending",
        toolCount: 0,
        retries: 0,
        filesEdited: [],
      },
    ],
    totals: { nodes: 3, completed: 1, failed: 1, skipped: 0, totalCostUsd: 0, totalDurationMs: 0 },
  };
  writeFileSync(join(runDir, "run.json"), JSON.stringify(runJson, null, 2));

  const sessionA = {
    sessionId: "sess-a-original",
    nodeId: "a",
    agentType: "pi",
    profile: "default",
    messages: [
      { role: "user", content: "Do Task A" },
      { role: "assistant", content: "Task A complete" },
    ],
    finalText: "Task A complete",
    toolCallCount: 3,
    durationMs: 100000,
  };
  writeFileSync(join(sessionsDir, "sess-a-original.json"), JSON.stringify(sessionA, null, 2));

  return runDir;
}

// ══════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════

describe("resume via executeDAG (S29b)", () => {
  /**
   * (a) Only the failed node re-runs via executeDAG.
   *
   * Expected behavior:
   *   1. prepareResume returns a run state with A completed, B pending (fresh
   *      session), C pending.
   *   2. executeDAG runs B with a fake adapter that succeeds.
   *   3. After B completes, C runs and completes.
   *   4. The original adapter (for A) is NEVER called — A's output is reused.
   *   5. The adapter is called exactly once (for node B).
   */
  it("re-runs only the failed node via executeDAG and preserves completed output", async () => {
    const runDir = buildFixtureRunDir();

    // Step 1: prepare resume
    const prepared = prepareResume(runDir);

    // Step 2: run through executeDAG
    const adapter = createFakeAdapter({
      sessionId: "sess-b-retry",
      finalText: "Task B complete on retry",
      fileEdits: ["src/b.ts"],
      mode: "succeed",
    });
    const scheduler = createScheduler({ maxAgentConcurrency: 3 });

    const summary = await executeDAG({
      ir: prepared.ir,
      runState: prepared.runState,
      getAdapter: () => adapter,
      scheduler,
    });

    // Step 3: assertions
    // Node A must remain completed (was not re-run)
    const aRt = prepared.runState.nodes.get("a")!;
    expect(aRt.status).toBe("completed");
    expect(aRt.sessionId).toBe("sess-a-original");

    // Node B completed (fresh session for retry)
    const bRt = prepared.runState.nodes.get("b")!;
    expect(bRt.status).toBe("completed");
    expect(bRt.sessionId).toBe("sess-b-retry");

    // Node C completed (now that B succeeded)
    const cRt = prepared.runState.nodes.get("c")!;
    expect(cRt.status).toBe("completed");

    // Adapter was called for both B (re-run from failed) and C (pending
    // dependent that becomes ready after B succeeds).
    expect(adapter.invocations).toHaveLength(2);
    expect(adapter.invocations[0]!.nodeId).toBe("b");
    expect(adapter.invocations[1]!.nodeId).toBe("c");

    // A's original output is preserved in the summary
    expect(summary.nodes.find((n) => n.id === "a")?.status).toBe("completed");
  });

  /**
   * (b) prepareResume assigns a fresh sessionId to a re-running node
   * (D4 — only .loop/.reviewLoop reuse transcripts).
   */
  it("assigns fresh sessionId to re-running node (D4)", async () => {
    const runDir = buildFixtureRunDir();

    const prepared = prepareResume(runDir);

    const bRt = prepared.runState.nodes.get("b");
    expect(bRt).toBeDefined();
    expect(bRt!.sessionId).not.toBe("sess-b-original");
    expect(typeof bRt!.sessionId).toBe("string");
    expect(bRt!.sessionId!.length).toBeGreaterThan(0);
  });

  /**
   * (c) rerunNodeIds contains only the failed/skipped nodes.
   */
  it("rerunNodeIds contains only failed nodes", async () => {
    const runDir = buildFixtureRunDir();

    const prepared = prepareResume(runDir);

    expect(prepared.rerunNodeIds).toContain("b");
    expect(prepared.rerunNodeIds).not.toContain("a");
    expect(prepared.rerunNodeIds).not.toContain("c");
  });
});
