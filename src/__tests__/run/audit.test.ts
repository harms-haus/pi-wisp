// ═══════════════════════════════════════════════════════════════════════════
// RED tests: AuditLogger + writeRunJson (S22 / PLAN §12).
//
// These tests define the contract for the production implementation. Each test
// expects the IMPLEMENTATION to fulfil the described behaviour. Currently the
// implementation is a STUB that throws; after the test pass confirms the RED
// state, the stubs are replaced.
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { AuditLogger, writeRunJson } from "../../run/audit.js";
import type { RunState, NodeRuntime } from "../../types.js";

// ─── Test-runner helpers ──────────────────────────────────────────

let tmpDir: string;
const activeLoggers: AuditLogger[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wisp-audit-test-"));
});

afterEach(() => {
  // Close all active loggers before deleting the temp directory.
  for (const l of activeLoggers) l.close();
  activeLoggers.length = 0;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Convenience: create a logger + register for auto-close on afterEach. */
function createLogger(): AuditLogger {
  const logger = new AuditLogger(tmpDir);
  activeLoggers.push(logger);
  return logger;
}

/**

/** Interface for the run.json manifest shape (used for typed assertions). */
interface RunJsonManifest {
  runId: string;
  title: string;
  slug: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  nodes: Array<{
    id: string;
    status: string;
    sessionId?: string;
    durationMs?: number;
    toolCount?: number;
    retries?: number;
    error?: string;
  }>;
  totals: {
    nodes: number;
    completed: number;
    failed: number;
    skipped: number;
    totalCostUsd: number;
    totalDurationMs: number;
  };
}

/** Build a minimal NodeRuntime with defaults. */
function makeNodeRuntime(id: string, overrides: Partial<NodeRuntime> = {}): [string, NodeRuntime] {
  return [
    id,
    {
      status: "pending",
      attempts: 0,
      toolCount: 0,
      filesEdited: [],
      ...overrides,
    },
  ];
}

/** Build a minimal RunState for testing writeRunJson. */
function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "test-run-001",
    title: "Test Workflow",
    slug: "test-workflow",
    startedAt: 1000,
    status: "running",
    nodes: new Map([
      makeNodeRuntime("node-a", { status: "completed", sessionId: "sess-a", toolCount: 3 }),
      makeNodeRuntime("node-b", { status: "running" }),
    ]),
    ...overrides,
  };
}

// ─── AuditLogger ───────────────────────────────────────────────────

describe("AuditLogger", () => {
  describe("construction", () => {
    it("creates an audit.jsonl file in the run directory", () => {
      createLogger();

      const auditPath = join(tmpDir, "audit.jsonl");
      expect(existsSync(auditPath)).toBe(true);
    });
  });

  describe("run-level events", () => {
    it("run.start appends one JSON line with type=run.start and a ts field", () => {
      const logger = createLogger();
      logger.runStart();

      const lines = readAuditLines(tmpDir);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.type).toBe("run.start");
      expect(typeof lines[0]!.ts).toBe("number");
    });

    it("run.complete appends one JSON line with type=run.complete and a ts field", () => {
      const logger = createLogger();
      logger.runStart();
      logger.runComplete();

      const lines = readAuditLines(tmpDir);
      expect(lines).toHaveLength(2);
      expect(lines[1]!.type).toBe("run.complete");
      expect(typeof lines[1]!.ts).toBe("number");
    });

    it("run.fail appends one JSON line with type=run.fail, a ts field, and an optional error", () => {
      const logger = createLogger();
      logger.runStart();
      logger.runFail("Something went wrong");

      const lines = readAuditLines(tmpDir);
      expect(lines).toHaveLength(2);
      expect(lines[1]!.type).toBe("run.fail");
      expect(lines[1]!.error).toBe("Something went wrong");
      expect(typeof lines[1]!.ts).toBe("number");
    });

    it("run.fail omits the error field when no argument is passed", () => {
      const logger = createLogger();
      logger.runStart();
      logger.runFail();

      const lines = readAuditLines(tmpDir);
      expect(lines[1]!.type).toBe("run.fail");
      expect(lines[1]!.error).toBeUndefined();
    });
  });

  describe("node-level events", () => {
    it("node.start appends one JSON line with type=node.start, nodeId, and ts", () => {
      const logger = createLogger();
      logger.nodeStart("node-a");

      const lines = readAuditLines(tmpDir);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.type).toBe("node.start");
      expect(lines[0]!.nodeId).toBe("node-a");
      expect(typeof lines[0]!.ts).toBe("number");
    });

    it("node.tool appends one JSON line with type=node.tool, nodeId, toolName, and ts", () => {
      const logger = createLogger();
      logger.nodeTool("node-a", "write");

      const lines = readAuditLines(tmpDir);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.type).toBe("node.tool");
      expect(lines[0]!.nodeId).toBe("node-a");
      expect(lines[0]!.toolName).toBe("write");
      expect(typeof lines[0]!.ts).toBe("number");
    });

    it("node.retry appends one JSON line with type=node.retry, nodeId, attempt, optional error, and ts", () => {
      const logger = createLogger();
      logger.nodeRetry("node-a", 2, "Timeout");

      const lines = readAuditLines(tmpDir);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.type).toBe("node.retry");
      expect(lines[0]!.nodeId).toBe("node-a");
      expect(lines[0]!.attempt).toBe(2);
      expect(lines[0]!.error).toBe("Timeout");
      expect(typeof lines[0]!.ts).toBe("number");
    });

    it("node.retry omits the error field when not passed", () => {
      const logger = createLogger();
      logger.nodeRetry("node-a", 1);

      const lines = readAuditLines(tmpDir);
      expect(lines[0]!.error).toBeUndefined();
    });

    it("node.complete appends one JSON line with type=node.complete, nodeId, sessionId, durationMs, toolCount, and ts", () => {
      const logger = createLogger();
      logger.nodeComplete("node-a", {
        sessionId: "sess-001",
        durationMs: 500,
        toolCount: 3,
      });

      const lines = readAuditLines(tmpDir);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.type).toBe("node.complete");
      expect(lines[0]!.nodeId).toBe("node-a");
      expect(lines[0]!.sessionId).toBe("sess-001");
      expect(lines[0]!.durationMs).toBe(500);
      expect(lines[0]!.toolCount).toBe(3);
      expect(typeof lines[0]!.ts).toBe("number");
    });

    it("node.fail appends one JSON line with type=node.fail, nodeId, error, and ts", () => {
      const logger = createLogger();
      logger.nodeFail("node-a", "Retries exhausted");

      const lines = readAuditLines(tmpDir);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.type).toBe("node.fail");
      expect(lines[0]!.nodeId).toBe("node-a");
      expect(lines[0]!.error).toBe("Retries exhausted");
      expect(typeof lines[0]!.ts).toBe("number");
    });

    it("node.skip appends one JSON line with type=node.skip, nodeId, reason, and ts", () => {
      const logger = createLogger();
      logger.nodeSkip("node-c", "dep-failed");

      const lines = readAuditLines(tmpDir);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.type).toBe("node.skip");
      expect(lines[0]!.nodeId).toBe("node-c");
      expect(lines[0]!.reason).toBe("dep-failed");
      expect(typeof lines[0]!.ts).toBe("number");
    });
  });

  describe("event ordering", () => {
    it("events are appended in the exact order they were called", () => {
      const logger = createLogger();
      logger.runStart();
      logger.nodeStart("node-a");
      logger.nodeTool("node-a", "read");
      logger.nodeComplete("node-a", { sessionId: "sess-a" });
      logger.nodeStart("node-b");
      logger.nodeComplete("node-b", {});
      logger.runComplete();

      const lines = readAuditLines(tmpDir);
      expect(lines).toHaveLength(7);
      expect(lines[0]!.type).toBe("run.start");
      expect(lines[1]!.type).toBe("node.start");
      expect(lines[1]!.nodeId).toBe("node-a");
      expect(lines[2]!.type).toBe("node.tool");
      expect(lines[2]!.nodeId).toBe("node-a");
      expect(lines[3]!.type).toBe("node.complete");
      expect(lines[3]!.nodeId).toBe("node-a");
      expect(lines[4]!.type).toBe("node.start");
      expect(lines[4]!.nodeId).toBe("node-b");
      expect(lines[5]!.type).toBe("node.complete");
      expect(lines[5]!.nodeId).toBe("node-b");
      expect(lines[6]!.type).toBe("run.complete");
    });
  });

  describe("append-only — each line is a complete JSON object", () => {
    it("every line in audit.jsonl is valid JSON", () => {
      const logger = createLogger();
      logger.runStart();
      logger.nodeStart("node-a");
      logger.nodeComplete("node-a", { sessionId: "sess-a" });

      const raw = readFileSync(join(tmpDir, "audit.jsonl"), "utf-8").trim();
      const parts = raw.split("\n");
      expect(parts).toHaveLength(3);
      for (const part of parts) {
        expect(() => JSON.parse(part)).not.toThrow();
      }
    });
  });
});

// ─── writeRunJson ─────────────────────────────────────────────────

describe("writeRunJson", () => {
  it("writes a run.json file in the run directory", () => {
    const state = makeRunState();
    writeRunJson(tmpDir, state);

    const runJsonPath = join(tmpDir, "run.json");
    expect(existsSync(runJsonPath)).toBe(true);
  });

  it("contains top-level fields: runId, title, slug, status, startedAt, endedAt, nodes, totals", () => {
    const state = makeRunState({ endedAt: 5000 });
    writeRunJson(tmpDir, state);

    const parsed = parseRunJson(tmpDir);
    expect(parsed.runId).toBe("test-run-001");
    expect(parsed.title).toBe("Test Workflow");
    expect(parsed.slug).toBe("test-workflow");
    expect(parsed.status).toBe("running");
    expect(parsed.startedAt).toBe(1000);
    expect(parsed.endedAt).toBe(5000);
    expect(parsed.nodes).toBeDefined();
    expect(parsed.totals).toBeDefined();
  });

  it("nodes array contains per-node summaries with id, status, sessionId, durationMs, toolCount, retries, error", () => {
    // NodeRuntime has startedAt/endedAt, NOT durationMs directly.
    // run.json derives durationMs from (endedAt - startedAt).
    const state = makeRunState({
      nodes: new Map([
        makeNodeRuntime("node-a", {
          status: "completed",
          sessionId: "sess-a",
          startedAt: 100,
          endedAt: 600,
          toolCount: 3,
          attempts: 1,
          error: undefined,
        }),
        makeNodeRuntime("node-b", {
          status: "failed",
          sessionId: "sess-b",
          startedAt: 100,
          endedAt: 400,
          toolCount: 1,
          attempts: 2,
          error: "Retries exhausted",
        }),
      ]),
    });
    writeRunJson(tmpDir, state);

    const parsed = parseRunJson(tmpDir);
    expect(parsed.nodes).toHaveLength(2);

    const nodeA = parsed.nodes.find((n) => n.id === "node-a")!;
    expect(nodeA.status).toBe("completed");
    expect(nodeA.sessionId).toBe("sess-a");
    expect(nodeA.durationMs).toBe(500);
    expect(nodeA.toolCount).toBe(3);
    expect(nodeA.retries).toBe(1);
    expect(nodeA.error).toBeUndefined();

    const nodeB = parsed.nodes.find((n) => n.id === "node-b")!;
    expect(nodeB.status).toBe("failed");
    expect(nodeB.sessionId).toBe("sess-b");
    expect(nodeB.error).toBe("Retries exhausted");
    expect(nodeB.retries).toBe(2);
  });

  it("totals aggregates node counts and cost/duration", () => {
    const state = makeRunState({
      status: "completed",
      endedAt: 5000,
      nodes: new Map([
        makeNodeRuntime("node-a", {
          status: "completed",
          startedAt: 0,
          endedAt: 1000,
          toolCount: 3,
          costUsd: 0.05,
        }),
        makeNodeRuntime("node-b", {
          status: "completed",
          startedAt: 0,
          endedAt: 2000,
          toolCount: 5,
          costUsd: 0.08,
        }),
        makeNodeRuntime("node-c", {
          status: "failed",
          startedAt: 0,
          endedAt: 500,
          toolCount: 1,
          costUsd: 0.02,
        }),
        makeNodeRuntime("node-d", {
          status: "skipped",
        }),
      ]),
    });
    writeRunJson(tmpDir, state);

    const parsed = parseRunJson(tmpDir);
    expect(parsed.totals.nodes).toBe(4);
    expect(parsed.totals.completed).toBe(2);
    expect(parsed.totals.failed).toBe(1);
    expect(parsed.totals.skipped).toBe(1);
    expect(parsed.totals.totalCostUsd).toBeCloseTo(0.15);
    expect(parsed.totals.totalDurationMs).toBe(3500);
  });

  it("overwrites an existing run.json (progressive update)", () => {
    const earlyState = makeRunState();
    writeRunJson(tmpDir, earlyState);

    // Read mid-run state
    const mid = parseRunJson(tmpDir);
    expect(mid.status).toBe("running");

    // Overwrite with final state
    const finalState = makeRunState({ status: "completed", endedAt: 9999 });
    writeRunJson(tmpDir, finalState);

    const final = parseRunJson(tmpDir);
    expect(final.status).toBe("completed");
    expect(final.endedAt).toBe(9999);
  });
});

// ─── File helpers ─────────────────────────────────────────────────

function readAuditLines(dir: string): Record<string, unknown>[] {
  const auditPath = join(dir, "audit.jsonl");
  if (!existsSync(auditPath)) return [];
  const raw = readFileSync(auditPath, "utf-8").trim();
  if (raw.length === 0) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

function parseRunJson(dir: string): RunJsonManifest {
  const raw = readFileSync(join(dir, "run.json"), "utf-8");
  return JSON.parse(raw) as RunJsonManifest;
}
