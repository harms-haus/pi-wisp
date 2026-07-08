// ═══════════════════════════════════════════════════════════════════════════
// Green tests — run_workflow tool (S34 / PLAN §13 / kb-19).
//
// Tests the full compile → validate → execute pipeline. Success-path tests
// inject a deterministic FakeAgentAdapter so they are NOT dependent on the
// real pi CLI. Error-path tests likewise inject fake adapters to produce
// the desired error kind.
//
// Schema validation tests PASS because the TypeBox schema is final.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from "vitest";
import { createFakeAdapter } from "../helpers/fake-adapter.js";
import type { AgentAdapter } from "../../adapters/types.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Value } from "typebox/value";

import { runWorkflowTool, RunWorkflowParams } from "../../tools/run-workflow.js";

// ─── Types ──────────────────────────────────────────────────────────

/** Shape of the ctx argument expected by run_workflow.execute. */
interface MockToolCtx {
  cwd: string;
  ui: {
    setWidget: (name: string, component: unknown) => void;
    setStatus: (name: string, text: unknown) => void;
  };
  /** Optional adapter resolver (injected for deterministic tests). */
  getAdapter?: (type?: string, nodeId?: string) => AgentAdapter;
}

/** Shape of the onUpdate callback expected by run_workflow.execute. */
type MockOnUpdate = (update: {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}) => void;

// ─── Mocks ─────────────────────────────────────────────────────────

/** Create minimal mock context with spies that satisfy the execute signature. */
function mockCtx(): MockToolCtx {
  const cwd = mkdtempSync(join(tmpdir(), "wisp-run-test-"));
  return {
    cwd,
    ui: {
      setWidget: vi.fn() as MockToolCtx["ui"]["setWidget"],
      setStatus: vi.fn() as MockToolCtx["ui"]["setStatus"],
    },
  };
}

/** Create a mock onUpdate callback. */
function mockOnUpdate(): MockOnUpdate {
  return vi.fn() as MockOnUpdate;
}

// ─── Helpers ──────────────────────────────────────────────────────

/** A minimal valid inline workflow script. */
const VALID_SCRIPT = `import { wf } from "pi-wisp";
export default wf("test", {}).node("a", { prompt: "hello" });`;

/** A script with duplicate node ids (validation error). */
const DUP_SCRIPT = `import { wf } from "pi-wisp";
export default wf("dup", {}).node("id", {}).node("id", {});`;

/** A simple script with a single node (for path tests). */
const MINIMAL_SCRIPT = `import { wf } from "pi-wisp";
export default wf("work", {}).node("main", { prompt: "Complete the task." });`;

// ─── Schema validation tests ───────────────────────────────────

describe("run_workflow — schema", () => {
  it("validates params with only 'path'", () => {
    expect(Value.Check(RunWorkflowParams, { path: "/tmp/test-workflow.ts" })).toBe(true);
  });

  it("validates params with only 'script'", () => {
    expect(
      Value.Check(RunWorkflowParams, {
        script: VALID_SCRIPT,
      }),
    ).toBe(true);
  });

  it("validates params with only 'resumeFrom'", () => {
    expect(Value.Check(RunWorkflowParams, { resumeFrom: "/tmp/.wisp/runs/20250707-test" })).toBe(
      true,
    );
  });

  it("validates params with all three (optional fields)", () => {
    expect(
      Value.Check(RunWorkflowParams, {
        path: "/tmp/a.ts",
        script: VALID_SCRIPT,
        resumeFrom: "/tmp/run",
      }),
    ).toBe(true);
  });

  it("rejects non-string path", () => {
    expect(Value.Check(RunWorkflowParams, { path: 42 })).toBe(false);
  });

  it("accepts extra keys (Value.Check does not enforce closed objects by default)", () => {
    expect(
      Value.Check(RunWorkflowParams, {
        script: VALID_SCRIPT,
        unknownKey: "oops",
      }),
    ).toBe(true);
  });

  it("accepts empty params — schema allows it; execute should reject at runtime", () => {
    expect(Value.Check(RunWorkflowParams, {})).toBe(true);
  });
});

// ─── Execute behaviour tests ─────────────────────────────────────

describe("run_workflow — execute", () => {
  // ── Basic invocation ──────────────────────────────────────────────

  it("returns structured result when called with a valid inline 'script'", async () => {
    // Inject a deterministic success adapter so the execution path completes
    // and produces real synthesized output (no vacuous failure pass).
    const adapter = createFakeAdapter({
      sessionId: "sess-1",
      finalText: "Task completed successfully",
      durationMs: 5,
    });

    const ctx: MockToolCtx = {
      ...mockCtx(),
      getAdapter: () => adapter,
    };
    const onUpdate = mockOnUpdate();

    const result = await runWorkflowTool.execute(
      "call-1",
      { script: VALID_SCRIPT },
      undefined,
      onUpdate,
      ctx,
    );

    // Must return synthesized output text (the injected finalText), NOT an
    // error message — this assertion would FAIL if the success path is broken.
    expect(result.content[0]!.text).toContain("Task completed successfully");
    const details = result.details as {
      runId?: string;
      runPath?: string;
      nodes?: unknown;
      totals?: unknown;
      failed?: unknown;
    };
    expect(details).toHaveProperty("runId");
    expect(details).toHaveProperty("runPath");
    expect(details).toHaveProperty("nodes");
    expect(details).toHaveProperty("totals");
    expect(details).toHaveProperty("failed");
    // There must be NO error kind on a success result.
    expect((details as Record<string, unknown>).kind).toBeUndefined();
  });

  it("returns structured result when called with a real workflow 'path'", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wisp-path-test-"));
    const workflowPath = join(tmpDir, "my-workflow.ts");
    writeFileSync(workflowPath, MINIMAL_SCRIPT, "utf-8");

    // Inject a deterministic success adapter so the execution path completes
    // and produces real synthesized output (no vacuous failure pass).
    const adapter = createFakeAdapter({
      sessionId: "sess-path",
      finalText: "Path workflow completed",
      durationMs: 5,
    });

    const ctx: MockToolCtx = {
      cwd: tmpDir,
      ui: { setWidget: vi.fn(), setStatus: vi.fn() },
      getAdapter: () => adapter,
    };
    const onUpdate = mockOnUpdate();

    const result = await runWorkflowTool.execute(
      "call-2",
      { path: workflowPath },
      undefined,
      onUpdate,
      ctx,
    );

    // Must return synthesized output text (the injected finalText), NOT an
    // error message — this assertion would FAIL if the success path is broken.
    expect(result.content[0]!.text).toContain("Path workflow completed");
    const details = result.details as {
      runId?: string;
      runPath?: string;
      nodes?: Array<{ id: string; status: string }>;
      totals?: unknown;
      failed?: unknown;
    };
    expect(details).toHaveProperty("runId");
    expect(details).toHaveProperty("runPath");
    expect(details).toHaveProperty("nodes");
    expect(details).toHaveProperty("totals");
    expect(details).toHaveProperty("failed");
    // There must be NO error kind on a success result.
    expect((details as Record<string, unknown>).kind).toBeUndefined();

    // The single node 'main' must be completed (proving the run genuinely
    // succeeded rather than failing silently).
    expect(details.nodes).toBeDefined();
    const mainNode = details.nodes!.find((n) => n.id === "main");
    expect(mainNode).toBeDefined();
    expect(mainNode!.status).toBe("completed");
  });

  it("returns structured compile error for a non-existent path", async () => {
    const ctx = mockCtx();

    const result = await runWorkflowTool.execute(
      "call-notfound",
      { path: "/tmp/non-existent-workflow-123456789.ts" },
      undefined,
      undefined,
      ctx,
    );

    const details = result.details as { kind?: string; message?: string };
    expect(details.kind).toBe("compile");
    expect(details.message).toBeDefined();
    expect(details.message!.toLowerCase()).toContain("not found");
  });

  it("resumes from a real 'resumeFrom' run directory fixture", async () => {
    // Create a real run directory fixture with one completed node and one
    // failed node, then resume from it. The completed node must remain
    // completed (NOT re-invoked).
    const tmpDir = mkdtempSync(join(tmpdir(), "wisp-resume-test-"));
    const runDir = join(tmpDir, "runs", "run-resume-test");
    const artifactsDir = join(runDir, "artifacts");
    const sessionsDir = join(runDir, "sessions");
    mkdirSync(artifactsDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });

    // Write graph.json with two nodes: A (independent) and B (depends on A)
    const graph = {
      title: "resume-test",
      slug: "resume-test",
      options: { defaultRetries: 0 },
      nodes: [
        { id: "a", kind: "node", agentType: "pi", profileRef: "default", prompt: "Task A" },
        {
          id: "b",
          kind: "node",
          agentType: "pi",
          profileRef: "default",
          prompt: "Task B",
          dependsOn: ["a"],
        },
      ],
      edges: [{ from: "a", to: "b", kind: "dep" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    writeFileSync(join(artifactsDir, "graph.json"), JSON.stringify(graph, null, 2));

    // Write run.json: node A completed, node B failed
    const runJson = {
      runId: "run-resume-test-original",
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
          toolCount: 1,
          retries: 0,
          filesEdited: [],
        },
        {
          id: "b",
          status: "failed",
          sessionId: "sess-b-original",
          startedAt: 1200000,
          endedAt: 1300000,
          durationMs: 100000,
          toolCount: 0,
          retries: 1,
          error: "previous failure",
          filesEdited: [],
        },
      ],
      totals: {
        nodes: 2,
        completed: 1,
        failed: 1,
        skipped: 0,
        totalCostUsd: 0,
        totalDurationMs: 200000,
      },
    };
    writeFileSync(join(runDir, "run.json"), JSON.stringify(runJson, null, 2));

    // Write session file for the completed node A
    const sessionA = {
      sessionId: "sess-a-original",
      nodeId: "a",
      agentType: "pi",
      profile: "default",
      messages: [],
      finalText: "Task A complete",
      toolCallCount: 1,
      durationMs: 100000,
    };
    writeFileSync(join(sessionsDir, "sess-a-original.json"), JSON.stringify(sessionA, null, 2));

    const ctx: MockToolCtx = {
      cwd: tmpDir,
      ui: { setWidget: vi.fn(), setStatus: vi.fn() },
    };

    const result = await runWorkflowTool.execute(
      "call-3",
      { resumeFrom: runDir },
      undefined,
      undefined,
      ctx,
    );

    const details = result.details as {
      runId?: string;
      runPath?: string;
      nodes?: Array<{ id: string; status: string }>;
    };
    expect(details.runId).toBeDefined();
    expect(details.runPath).toBeDefined();

    // The completed node A must NOT be re-invoked — it should remain
    // completed in the summary.
    if (details.nodes) {
      const nodeA = details.nodes.find((n) => n.id === "a");
      expect(nodeA).toBeDefined();
      expect(nodeA!.status).toBe("completed");
    }
  });

  // ── TUI integration ────────────────────────────────────────────────

  it("calls onUpdate during execution (TUI streaming)", async () => {
    const ctx = mockCtx();
    const onUpdate = mockOnUpdate();

    await runWorkflowTool.execute("call-4", { script: VALID_SCRIPT }, undefined, onUpdate, ctx);

    expect(onUpdate).toHaveBeenCalled();
  });

  it("calls ctx.ui.setWidget and ctx.ui.setStatus during execution", async () => {
    const ctx = mockCtx();

    await runWorkflowTool.execute(
      "call-5",
      { script: VALID_SCRIPT },
      undefined,
      mockOnUpdate(),
      ctx,
    );

    expect(ctx.ui.setWidget).toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenCalled();
  });

  // ── Error classification ───────────────────────────────────────────

  it("returns classified compile error for invalid script", async () => {
    const ctx = mockCtx();

    const result = await runWorkflowTool.execute(
      "call-6",
      { script: "this is not valid TypeScript @#$%" },
      undefined,
      undefined,
      ctx,
    );

    const details = result.details as {
      kind?: string;
      message?: string;
      line?: number;
      errors?: unknown[];
    };
    expect(details.kind).toBe("compile");
    expect(details.message).toBeDefined();
    expect(details.kind).not.toBe("runtime");
  });

  it("returns classified validation error for duplicate node ids", async () => {
    const ctx = mockCtx();

    const result = await runWorkflowTool.execute(
      "call-7",
      { script: DUP_SCRIPT },
      undefined,
      undefined,
      ctx,
    );

    const details = result.details as {
      kind?: string;
      message?: string;
      errors?: unknown[];
    };
    expect(details.kind).toBe("validation");
    expect(details.message).toBeDefined();
    expect(details.errors).toBeDefined();
  });

  it("returns classified runtime error when a node fails", async () => {
    // Inject a deterministic failing adapter so a node genuinely FAILS
    // (rather than relying on the real pi CLI being unavailable).
    const failAdapter = createFakeAdapter({
      mode: "fail-after-events",
      failAfterEvents: 0,
      sessionId: "sess-fail",
      errorMessage: "node execution failed",
    });

    const ctx: MockToolCtx = {
      ...mockCtx(),
      getAdapter: () => failAdapter,
    };

    const result = await runWorkflowTool.execute(
      "call-8",
      { script: VALID_SCRIPT },
      undefined,
      undefined,
      ctx,
    );

    const details = result.details as { kind?: string; message?: string };
    expect(details.kind).toBe("runtime");
    expect(details.message).toBeDefined();
  });

  // ── Param validation ──────────────────────────────────────────────

  it("rejects when none of path/script/resumeFrom is provided", async () => {
    const ctx = mockCtx();

    const result = await runWorkflowTool.execute("call-9", {}, undefined, undefined, ctx);

    const details = result.details as { kind?: string; message?: string };
    expect(details.kind).toBe("validation");
    expect(details.message).toBeDefined();
    expect(details.message!.toLowerCase()).toContain("path");
    expect(details.message!.toLowerCase()).toContain("script");
  });
});
