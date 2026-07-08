// ═══════════════════════════════════════════════════════════════════════════
// Tests: createRunStore — getRun / reconstructRuns / finalizeAll / _clear
// (S23 / PLAN §12).
//
// Mutation accessors (registerRun/updateRun/persistRun) were removed because
// runs are created and persisted inside engine/run.ts, not via the store.
// The store only serves reconstruction + finalization.
//
// IMPORTANT: Branch entries in reconstructRuns tests use the REAL pi CustomEntry
// shape ({type:'custom', customType:'wisp:run', data, id, parentId, timestamp})
// — NOT a fabricated {key, value} shape.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";

import { createRunStore } from "../../run/store.js";
import type { NodeRuntime, RunState } from "../../types.js";

// ─── Helpers ──────────────────────────────────────────────────────

let _entrySeq = 0;

/**
 * Build a real CustomEntry as stored by pi's session-manager.
 * Mirrors the shape of @earendil-works/pi-coding-agent's CustomEntry:
 *   { type:'custom', customType, data?, id, parentId, timestamp }
 */
function makeCustomEntry(customType: string, data: unknown): Record<string, unknown> {
  _entrySeq += 1;
  return {
    type: "custom",
    customType,
    data,
    id: `entry-${_entrySeq.toString(36).padStart(4, "0")}`,
    parentId: null,
    timestamp: new Date(1_000_000 + _entrySeq).toISOString(),
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

/**
 * Build a minimal RunState with a deterministic runId and a single node.
 */
function makeRunState(overrides: Partial<RunState> = {}): RunState {
  const runId = overrides.runId ?? `run-${Math.random().toString(36).slice(2, 8)}`;
  return {
    runId,
    title: "Test Workflow",
    slug: "test-workflow",
    startedAt: 1000,
    status: "running",
    nodes: new Map([makeNodeRuntime("node-a", { status: "pending" })]),
    ...overrides,
  };
}

/**
 * Transform a RunState into the serialised shape that appendEntry would store.
 * Mirrors what `persistRun` should produce (see store.ts serializeRun).
 */
function serializeRun(run: RunState): unknown {
  return {
    runId: run.runId,
    title: run.title,
    slug: run.slug,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    status: run.status,
    nodes: Array.from(run.nodes.entries()).map(([id, rt]) => ({
      id,
      status: rt.status,
      sessionId: rt.sessionId,
      startedAt: rt.startedAt,
      endedAt: rt.endedAt,
      durationMs:
        rt.endedAt != null && rt.startedAt != null ? rt.endedAt - rt.startedAt : undefined,
      toolCount: rt.toolCount,
      retries: rt.attempts,
      filesEdited: rt.filesEdited,
      costUsd: rt.costUsd,
      error: rt.error,
    })),
  };
}

/**
 * Build a mock session-manager context for reconstructRuns.
 */
function mockCtx(branch: unknown[]): { sessionManager: { getBranch: () => unknown[] } } {
  return {
    sessionManager: {
      getBranch: () => branch,
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("createRunStore", () => {
  describe("StoreAPI shape", () => {
    it("returns a StoreAPI with getRun, reconstructRuns, finalizeAll, and _clear", () => {
      const store = createRunStore();
      expect(store).toBeDefined();
      expect(typeof store.getRun).toBe("function");
      expect(typeof store.reconstructRuns).toBe("function");
      expect(typeof store.finalizeAll).toBe("function");
      expect(typeof store._clear).toBe("function");
    });

    it("getRun returns undefined for an unknown runId", () => {
      const store = createRunStore();
      const retrieved = store.getRun("nonexistent");
      expect(retrieved).toBeUndefined();
    });
  });

  describe("reconstructRuns", () => {
    it("scans sessionManager.getBranch() in reverse for 'wisp:run' entries and registers them", () => {
      const run1 = makeRunState({ runId: "run-recon-1", status: "completed", endedAt: 2000 });
      const run2 = makeRunState({ runId: "run-recon-2", status: "completed", endedAt: 3000 });

      const branch = [
        makeCustomEntry("other:entry", "ignore"),
        makeCustomEntry("wisp:run", serializeRun(run1)),
        makeCustomEntry("wisp:run", serializeRun(run2)),
      ];

      const store = createRunStore();
      const ctx = mockCtx(branch);

      store.reconstructRuns(ctx);

      // Both runs should be registered
      const retrieved1 = store.getRun("run-recon-1");
      expect(retrieved1).toBeDefined();
      expect(retrieved1!.status).toBe("completed");

      const retrieved2 = store.getRun("run-recon-2");
      expect(retrieved2).toBeDefined();
      expect(retrieved2!.status).toBe("completed");
    });

    it("transitions stale 'running' runs to 'error' (passive detection)", () => {
      // A persisted run with status 'running' means the agent died mid-flight
      const staleRun = makeRunState({ runId: "run-stale", status: "running" });

      const branch = [makeCustomEntry("wisp:run", serializeRun(staleRun))];

      const store = createRunStore();
      store.reconstructRuns(mockCtx(branch));

      const retrieved = store.getRun("run-stale")!;
      expect(retrieved.status).toBe("error");
    });

    it("does not transition already-terminal runs to error", () => {
      const completedRun = makeRunState({
        runId: "run-completed",
        status: "completed",
        endedAt: 2000,
      });
      const failedRun = makeRunState({
        runId: "run-failed",
        status: "failed",
        endedAt: 1500,
      });

      const branch = [
        makeCustomEntry("wisp:run", serializeRun(completedRun)),
        makeCustomEntry("wisp:run", serializeRun(failedRun)),
      ];

      const store = createRunStore();
      store.reconstructRuns(mockCtx(branch));

      expect(store.getRun("run-completed")!.status).toBe("completed");
      expect(store.getRun("run-failed")!.status).toBe("failed");
    });

    it("handles empty branch gracefully (no runs to reconstruct)", () => {
      const store = createRunStore();
      expect(() => {
        store.reconstructRuns(mockCtx([]));
      }).not.toThrow();
    });

    it("skips branch entries that are not 'wisp:run'", () => {
      const branch = [
        makeCustomEntry("some:other", "ignore me"),
        makeCustomEntry("another:entry", 42),
        { type: "message", id: "msg-1", parentId: null, timestamp: "2024-01-01T00:00:00Z" },
      ];

      const store = createRunStore();
      store.reconstructRuns(mockCtx(branch));

      // No runs were registered
      expect(store.getRun("anything")).toBeUndefined();
    });

    it("handles missing sessionManager gracefully", () => {
      const store = createRunStore();
      expect(() => {
        store.reconstructRuns({});
      }).not.toThrow();
    });

    it("handles missing getBranch gracefully", () => {
      const store = createRunStore();
      expect(() => {
        store.reconstructRuns({ sessionManager: {} });
      }).not.toThrow();
    });
  });

  // ── Round-trip: serializeRun → reconstructRuns ──────────────────

  describe("reconstruction round-trip", () => {
    it("round-trips a serialized run through reconstructRuns using the real CustomEntry shape", () => {
      const run = makeRunState({
        runId: "run-rt-1",
        status: "completed",
        endedAt: 9999,
      });

      // Build branch entries directly (simulating persisted entries)
      const branchEntries = [makeCustomEntry("wisp:run", serializeRun(run))];

      const reconStore = createRunStore();
      reconStore.reconstructRuns(mockCtx(branchEntries));

      const reconstructed = reconStore.getRun("run-rt-1");
      expect(reconstructed).toBeDefined();
      expect(reconstructed!.runId).toBe("run-rt-1");
      expect(reconstructed!.status).toBe("completed");
      expect(reconstructed!.title).toBe(run.title);
      expect(reconstructed!.slug).toBe(run.slug);
      expect(reconstructed!.startedAt).toBe(run.startedAt);
      expect(reconstructed!.endedAt).toBe(run.endedAt);
      expect(reconstructed!.nodes.size).toBe(run.nodes.size);
    });

    it("multiple entries for the same runId reconstruct only the most recent", () => {
      const runRunning = makeRunState({ runId: "run-rt-multi", status: "running" });
      const runCompleted = makeRunState({
        runId: "run-rt-multi",
        status: "completed",
        endedAt: 7777,
      });

      // Earlier entry first (running), later entry after (completed)
      const branchEntries = [
        makeCustomEntry("wisp:run", serializeRun(runRunning)),
        makeCustomEntry("wisp:run", serializeRun(runCompleted)),
      ];

      const reconStore = createRunStore();
      reconStore.reconstructRuns(mockCtx(branchEntries));

      const reconstructed = reconStore.getRun("run-rt-multi");
      expect(reconstructed).toBeDefined();
      // Most recent snapshot should win (completed, not running)
      expect(reconstructed!.status).toBe("completed");
      expect(reconstructed!.endedAt).toBe(7777);
    });
  });

  // ── H1: durationMs survival ──────────────────────────────────

  describe("node timing survival (H1)", () => {
    it("reconstructs a node's startedAt/endedAt so durationMs is nonzero", () => {
      const store = createRunStore();

      const serializedRun = {
        runId: "run-h1-timing",
        title: "Timing Test",
        slug: "timing-test",
        startedAt: 1000,
        endedAt: 5000,
        status: "completed" as const,
        nodes: [
          {
            id: "node-timing",
            status: "completed",
            startedAt: 1000,
            endedAt: 5000,
            durationMs: 4000,
            toolCount: 3,
            retries: 1,
            sessionId: "sess-001",
          },
        ],
      };

      const branch = [makeCustomEntry("wisp:run", serializedRun)];
      store.reconstructRuns(mockCtx(branch));

      const run = store.getRun("run-h1-timing");
      expect(run).toBeDefined();
      const node = run!.nodes.get("node-timing");
      expect(node).toBeDefined();

      expect(node!.startedAt).toBe(1000);
      expect(node!.endedAt).toBe(5000);
      expect(node!.endedAt! - node!.startedAt!).toBe(4000);
    });
  });

  // ── H2: costUsd + filesEdited survival ──────────────────────

  describe("node metadata survival (H2)", () => {
    it("reconstructs costUsd and filesEdited (not dropped to undefined/[])", () => {
      const store = createRunStore();

      const serializedRun = {
        runId: "run-h2-meta",
        title: "Meta Test",
        slug: "meta-test",
        startedAt: 1000,
        endedAt: 5000,
        status: "completed" as const,
        nodes: [
          {
            id: "node-meta",
            status: "completed",
            costUsd: 1.23,
            filesEdited: ["src/index.ts", "src/utils.ts"],
            toolCount: 5,
            retries: 0,
          },
        ],
      };

      const branch = [makeCustomEntry("wisp:run", serializedRun)];
      store.reconstructRuns(mockCtx(branch));

      const run = store.getRun("run-h2-meta");
      expect(run).toBeDefined();
      const node = run!.nodes.get("node-meta");
      expect(node).toBeDefined();

      expect(node!.costUsd).toBe(1.23);
      expect(node!.filesEdited).toEqual(["src/index.ts", "src/utils.ts"]);
    });
  });

  // ── _clear ──────────────────────────────────────────────────

  describe("_clear", () => {
    it("empties the store completely", () => {
      const store = createRunStore();

      // Populate via reconstructRuns
      const run = makeRunState({ runId: "run-clear", status: "completed" });
      const branch = [makeCustomEntry("wisp:run", serializeRun(run))];
      store.reconstructRuns(mockCtx(branch));

      expect(store.getRun("run-clear")).toBeDefined();

      store._clear();
      expect(store.getRun("run-clear")).toBeUndefined();
    });
  });
});
