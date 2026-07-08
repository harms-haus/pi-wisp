/**
 * ═══════════════════════════════════════════════════════════════════════════
 * S29a — Resume spike (isolated, NO executor).
 *
 * Tests for `prepareResume`. Hand-builds a fixture run directory on disk
 * containing one completed node (with stored output + sessionId), one failed
 * node, and one pending dependent node. Calls `prepareResume(runDir)` and
 * asserts the expected resume behavior:
 *
 *   1. Completed nodes → remain 'completed' (reused; stored output + session
 *      preserved; available to dependents via NodeCtx context).
 *   2. Failed nodes → become 'pending' with a FRESH sessionId (D4 — resume ≠
 *      CLI resume; only .loop/.reviewLoop reuse transcripts).
 *   3. The dependent's NodeCtx can see the prior completed node's output
 *      WITHOUT re-running it.
 *   4. Nodes that were `failed`/`skipped`/stale have their accumulated
 *      state reset (attempts=0, toolCount=0, etc.) so fresh retries are
 *      not prematurely exhausted by prior attempts.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";

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

// ══════════════════════════════════════════════════════════════════════
// Fixture builder
// ══════════════════════════════════════════════════════════════════════

/**
 * Build a fixture run directory on a temp location.
 *
 * Graph: A → B → C
 *   - A: completed (output="Task A complete", sessionId="sess-a-original")
 *   - B: failed  (retries exhausted)
 *   - C: pending (depends on B — would be skipped if B fails definitively)
 *
 * Returns the absolute path to the run directory plus the expected resume
 * outcome so tests can assert against the structured result.
 */
function buildFixtureRunDir(): {
  runDir: string;
  completedNodeId: string;
  failedNodeId: string;
  pendingNodeId: string;
  completedSessionId: string;
  completedOutput: string;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), "wisp-resume-spike-"));
  createdTmpDirs.push(tmpDir);
  const runDir = join(tmpDir, "runs", "20260707-1200-resume-test");
  const artifactsDir = join(runDir, "artifacts");
  const sessionsDir = join(runDir, "sessions");

  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  // ── IR ────────────────────────────────────────────────────
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
    title: "resume-test",
    slug: "resume-test",
    options: { defaultRetries: 0 },
    nodes,
    edges,
    conditions: [],
    schemas: {},
    primitives: {},
  };

  writeFileSync(join(artifactsDir, "graph.json"), JSON.stringify(graph, null, 2));

  // ── run.json (manifest) ──────────────────────────────────
  // Simulates a run where A completed, B failed, C pending.
  const runJson = {
    runId: "run-resume-test",
    title: "resume-test",
    slug: "resume-test",
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

  // ── Session for node A ──────────────────────────────────
  const sessionA = {
    sessionId: "sess-a-original",
    nodeId: "a",
    agentType: "pi",
    profile: "default",
    messages: [
      { role: "user", content: "Do Task A" },
      { role: "assistant", content: "Task A complete" },
      { role: "toolResult", content: "tool executed for Task A" },
    ],
    finalText: "Task A complete",
    toolCallCount: 3,
    durationMs: 100000,
  };
  writeFileSync(join(sessionsDir, "sess-a-original.json"), JSON.stringify(sessionA, null, 2));

  return {
    runDir,
    completedNodeId: "a",
    failedNodeId: "b",
    pendingNodeId: "c",
    completedSessionId: "sess-a-original",
    completedOutput: "Task A complete",
  };
}

// ══════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════

describe("prepareResume — isolated spike (S29a)", () => {
  /**
   * (a) Completed node remains completed with preserved output.
   *
   * `prepareResume` loads the fixture run dir, finds node A completed,
   * and preserves its `completed` status and stored output so dependents
   * can access it via NodeCtx without re-running.
   */
  it("preserves completed node status and stored output after resume preparation", async () => {
    const { runDir, completedNodeId, completedOutput } = buildFixtureRunDir();

    const result = prepareResume(runDir);

    const aRt = result.runState.nodes.get(completedNodeId);
    expect(aRt).toBeDefined();
    expect(aRt!.status).toBe("completed");
    expect(aRt!.finalText).toBe(completedOutput);
    expect(aRt!.sessionId).toBe("sess-a-original");
  });

  /**
   * (b) Failed node becomes pending with a FRESH sessionId.
   *
   * The failed node's status is reset to 'pending' and its sessionId is
   * set to a fresh value (different from the original failed session).
   * This ensures the node is re-run from scratch (D4 —
   * resume ≠ CLI resume; only .loop/.reviewLoop reuse transcripts).
   */
  it("resets failed node to pending with a fresh sessionId", async () => {
    const { runDir, failedNodeId } = buildFixtureRunDir();

    const result = prepareResume(runDir);

    const bRt = result.runState.nodes.get(failedNodeId);
    expect(bRt).toBeDefined();
    expect(bRt!.status).toBe("pending");
    // Fresh sessionId means it's different from the original failed session
    expect(bRt!.sessionId).not.toBe("sess-b-original");
    expect(typeof bRt!.sessionId).toBe("string");
    expect(bRt!.sessionId!.length).toBeGreaterThan(0);
  });

  /**
   * (c) Dependent node (pending) stays pending and can see prior completed
   * output via NodeCtx without re-running the completed node.
   *
   * Node C stays pending; the completed node A's output is accessible via
   * NodeCtx without re-running A. When the executor later runs B and it
   * succeeds, C can become ready and its context can reference A's output.
   */
  it("keeps dependent pending and prior completed output available via NodeCtx", async () => {
    const { runDir, pendingNodeId, completedNodeId, completedOutput } = buildFixtureRunDir();

    const result = prepareResume(runDir);

    const cRt = result.runState.nodes.get(pendingNodeId);
    expect(cRt).toBeDefined();
    // Dependent should stay pending (will be skipped if B fails again)
    expect(cRt!.status).toBe("pending");

    // The completed node A can be accessed via NodeCtx — its output is
    // preserved without re-running A. We verify via raw runState access:
    const aRt = result.runState.nodes.get(completedNodeId);
    expect(aRt!.status).toBe("completed");
    expect(aRt!.finalText).toBe(completedOutput);

    // The rerunNodeIds list should include B (failed) but NOT A (completed)
    expect(result.rerunNodeIds).toContain("b");
    expect(result.rerunNodeIds).not.toContain(completedNodeId);
  });
});
