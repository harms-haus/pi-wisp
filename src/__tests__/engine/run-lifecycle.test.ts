// ═══════════════════════════════════════════════════════════════════════════
// RED tests: Run lifecycle orchestration (S31 / PLAN §7.3).
//
// These tests pin the contract of `runWorkflow` — the orchestrator that wires
// compilation, validation, run-directory creation, DAG execution, audit, session
// persistence, and result return into a single async call.
//
// The stub (`src/engine/run.ts`) throws `Not implemented`, so every test is RED
// in this phase. Tests are structured so that once the real implementation is
// written they will pass without modification.
//
// ### Test scenarios
//   1. **Happy path** — 3-node linear graph compiles, executes, persists →
//      correct on-disk layout + RunSummary.
//   2. **Compile error** — uncompilable workflow → structured `{kind:'compile'}`
//      WispError + audit.run.fail (NO execution started).
//   3. **Validation error** — compiles but fails IR validation →
//      `{kind:'validation'}` + audit.run.fail (NO execution started).
//   4. **Runtime failure** — a node that fails with no recoverable deps →
//      `{kind:'runtime'}` + audit.run.fail + partial RunSummary.
//   5. **Mid-run finalization guard** — simulate process death during
//      execution → run marked error + audit.run.fail.
// ═══════════════════════════════════════════════════════════════════════════

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Module mocks (the orchestrator will import these) ───────────────
//
// We mock at the vitest level so the orchestrator receives controlled
// responses for every external call it makes.

vi.mock("../../dsl/ir.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../dsl/ir.js");
  const realValidate = actual.validateIR as (
    ir: unknown,
  ) => Array<{ kind: string; message: string }>;
  return {
    ...actual,
    validateIR: vi.fn((ir: unknown) => realValidate(ir)),
  };
});

vi.mock("../../dsl/compile.js");
vi.mock("../../dsl/fn-serialize.js");

vi.mock("../../run/layout.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../run/layout.js");
  return {
    ...actual,
    createRunDir: vi.fn(),
  };
});

vi.mock("../../run/audit.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../run/audit.js");

  // Proxy the AuditLogger constructor: calls the real implementation so
  // audit.jsonl is actually created, but prototype methods are replaced with
  // spies so tests can assert they were called.
  const RealAuditLogger = actual.AuditLogger as new (runDir: string) => Record<string, unknown>;

  // Capture original methods BEFORE replacing them on the prototype,
  // so the spies can delegate to the real implementations without recursion.
  const origRunStart = RealAuditLogger.prototype.runStart;
  const origRunComplete = RealAuditLogger.prototype.runComplete;
  const origRunFail = RealAuditLogger.prototype.runFail;

  const mockRunStart = vi.fn(function (this: Record<string, unknown>) {
    return origRunStart.call(this);
  });
  const mockRunComplete = vi.fn(function (this: Record<string, unknown>) {
    return origRunComplete.call(this);
  });
  const mockRunFail = vi.fn(function (this: Record<string, unknown>, ...args: [string?]) {
    return origRunFail.apply(this, args);
  });

  // Spies on the prototype so `AuditLogger.prototype.runComplete` works
  // after the test sets up `new AuditLogger(...)`.
  RealAuditLogger.prototype.runStart = mockRunStart;
  RealAuditLogger.prototype.runComplete = mockRunComplete;
  RealAuditLogger.prototype.runFail = mockRunFail;

  const MockAuditLogger = vi.fn().mockImplementation(function (runDir: string) {
    return new RealAuditLogger(runDir);
  }) as unknown as typeof RealAuditLogger;
  // Copy spy references to the mock's prototype so assertions via
  // `AuditLogger.prototype.runComplete` resolve to the spies.
  MockAuditLogger.prototype.runStart = mockRunStart;
  MockAuditLogger.prototype.runComplete = mockRunComplete;
  MockAuditLogger.prototype.runFail = mockRunFail;

  return {
    ...actual,
    AuditLogger: MockAuditLogger,
    writeRunJson: vi.fn((...args: unknown[]) => {
      (actual.writeRunJson as (...args: unknown[]) => void)(...args);
    }),
  };
});

vi.mock("../../run/store.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../run/store.js");
  return {
    ...actual,
    // Keep real implementations — runWorkflow's persistRun uses serializeRunState.
  };
});
vi.mock("../../run/sessions.js");
vi.mock("../../engine/scheduler.js");
vi.mock("../../engine/executor.js");

// ── Module under test ───────────────────────────────────────────────

import { runWorkflow } from "../../engine/run.js";
import type {
  RunWorkflowOptions,
  RunWorkflowResult,
  RunSuccess,
  RunFailure,
} from "../../engine/run.js";

// ── Import mocked modules for assertion ────────────────────────────

import { compileWorkflow } from "../../dsl/compile.js";
import { validateIR } from "../../dsl/ir.js";
import { createRunDir } from "../../run/layout.js";
import { AuditLogger, writeRunJson } from "../../run/audit.js";
import { executeDAG } from "../../engine/executor.js";

// ── Types used across tests ────────────────────────────────────────

import type { GraphIR, IRNode, IREdge, WispError } from "../../types.js";
import type { RunSummary } from "../../engine/executor.js";
import type { AgentAdapter } from "../../adapters/types.js";

// ══════════════════════════════════════════════════════════════════════
// Fixture builders
// ══════════════════════════════════════════════════════════════════════

/** A minimal 3-node linear GraphIR: A → B → C. */
function makeLinearGraphIR(): GraphIR {
  const nodes: IRNode[] = [
    { id: "a", kind: "node", prompt: "Task A" },
    { id: "b", kind: "node", prompt: "Task B", dependsOn: ["a"] },
    { id: "c", kind: "node", prompt: "Task C", dependsOn: ["b"] },
  ];
  const edges: IREdge[] = [
    { from: "a", to: "b", kind: "dep" },
    { from: "b", to: "c", kind: "dep" },
  ];
  return {
    title: "test-workflow",
    slug: "test-workflow",
    options: { maxConcurrency: 12, defaultRetries: 3 },
    nodes,
    edges,
    conditions: [],
    schemas: {},
    primitives: {},
  };
}

/** Build a RunSummary where all three nodes completed. */
function makeSuccessSummary(): RunSummary {
  return {
    runId: "test-run-001",
    nodes: [
      { id: "a", status: "completed", toolCount: 0, retries: 0 },
      { id: "b", status: "completed", toolCount: 1, retries: 0 },
      { id: "c", status: "completed", toolCount: 2, retries: 0 },
    ],
    totals: {
      nodes: 3,
      completed: 3,
      failed: 0,
      skipped: 0,
      totalCostUsd: 0,
      totalDurationMs: 100,
    },
  };
}

/** Build a RunSummary where node b failed and node c was skipped. */
function makeFailureSummary(): RunSummary {
  return {
    runId: "test-run-001",
    nodes: [
      { id: "a", status: "completed", toolCount: 0, retries: 0 },
      { id: "b", status: "failed", toolCount: 1, retries: 2, error: "Task B failed" },
      { id: "c", status: "skipped", toolCount: 0, retries: 0, error: "dep-failed" },
    ],
    totals: { nodes: 3, completed: 1, failed: 1, skipped: 1, totalCostUsd: 0, totalDurationMs: 50 },
  };
}

/** A compile error WispError. */
function makeCompileError(): WispError {
  return {
    kind: "compile",
    message: "Syntax error in workflow: unexpected token '=>'",
    location: "/tmp/workflow.ts:5:12",
  };
}

/** Build minimal RunWorkflowOptions for a happy path test (overrides merged in). */
function makeOptions(
  overrides: Partial<RunWorkflowOptions> & { runsDir: string },
): RunWorkflowOptions {
  const defaults: RunWorkflowOptions = {
    runsDir: join(overrides.runsDir, "runs"),
    builderPath: "/home/user/.pi/agent/extensions/pi-wisp/src/dsl/builder.ts",
    harnessPath: "/home/user/.pi/agent/extensions/pi-wisp/src/dsl/compile-harness.ts",
    defaultRetries: 3,
    retryBackoffMs: 2000,
    maxAgentConcurrency: 12,
    getAdapter: vi.fn(() => ({ type: "fake" }) as unknown as AgentAdapter),
    pi: { appendEntry: vi.fn() },
    signal: undefined,
    onUpdate: vi.fn(),
  };
  return { ...defaults, ...overrides };
}

// ══════════════════════════════════════════════════════════════════════
// Test runner helpers
// ══════════════════════════════════════════════════════════════════════

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wisp-run-lifecycle-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Await a promise with a timeout, so tests fail fast instead of hanging
 * when the implementation rejects with a generic Error instead of the expected
 * "Not implemented" pattern (or when awaiting completes but the result is
 * undefined). Default 5_000 ms; can be increased for slower CI.
 */
function withTimeout<T>(p: Promise<T>, ms = 5_000): Promise<T> {
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
 * Call runWorkflow and handle the stub's synchronous throw gracefully.
 *
 * The RED-phase stub throws synchronously before returning a Promise. This
 * wrapper catches that synchronous throw and returns a rejected Promise so
 * callers can await it uniformly. Once the real implementation is in place,
 * this wrapper becomes unnecessary — tests call `runWorkflow` directly.
 */
function callRunWorkflow(options: RunWorkflowOptions): Promise<RunWorkflowResult> {
  try {
    return Promise.resolve(runWorkflow(options));
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

// ══════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════

describe("runWorkflow — run lifecycle orchestration", () => {
  // ── 1. Happy path ──────────────────────────────────────────────
  describe("happy path", () => {
    it("completes a 3-node linear graph producing on-disk artifacts and a RunSuccess", async () => {
      const runsDir = join(tmpDir, "runs");
      const runDir = join(runsDir, "20260707-1200-test-workflow");

      // Arrange mock responses
      const ir = makeLinearGraphIR();
      const summary = makeSuccessSummary();
      vi.mocked(compileWorkflow).mockResolvedValueOnce({ ir });
      vi.mocked(createRunDir).mockReturnValueOnce(runDir);
      vi.mocked(executeDAG).mockImplementationOnce(async (opts) => {
        // Mutate runState so reconcileRunStatus + run.json reflect a successful run.
        for (const nodeId of opts.runState.nodes.keys()) {
          opts.runState.nodes.set(nodeId, {
            status: "completed",
            attempts: 0,
            toolCount: 0,
            filesEdited: [],
          });
        }
        return summary;
      });

      const appendEntry = vi.fn();
      const options = makeOptions({
        runsDir,
        scriptSource: "export default wf('test')",
        pi: { appendEntry },
      });

      // Act
      const result = await withTimeout(callRunWorkflow(options));

      // Assert
      expect(result.ok).toBe(true);
      const success = result as RunSuccess;
      expect(success.summary.runId).toBe("test-run-001");
      expect(success.summary.nodes).toHaveLength(3);
      expect(success.summary.nodes.every((n: { status: string }) => n.status === "completed")).toBe(
        true,
      );
      expect(success.summary.totals.completed).toBe(3);
      expect(success.runDir).toBe(runDir);

      // -- Verify the orchestration sequence --
      // 1a. Compilation was called with the script source
      expect(compileWorkflow).toHaveBeenCalledTimes(1);
      expect(compileWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ scriptSource: "export default wf('test')" }),
      );

      // 1b. Run directory was created
      expect(createRunDir).toHaveBeenCalledTimes(1);
      expect(createRunDir).toHaveBeenCalledWith(runsDir, ir.title);

      // 1c. AuditLogger was created (implied by event calls below)
      // 1d. Scheduler was created (implied by executeDAG call)

      // 1e. DAG was executed
      expect(executeDAG).toHaveBeenCalledTimes(1);
      const dagOptions = vi.mocked(executeDAG).mock.calls[0]?.[0];
      expect(dagOptions).toBeDefined();
      expect(dagOptions!.ir).toBe(ir);
      expect(typeof dagOptions!.getAdapter).toBe("function");

      // 1f. Run.json was written — check on-disk file existence
      expect(writeRunJson).toHaveBeenCalledWith(runDir, expect.any(Object));

      // 1g. Audit run.complete was logged
      expect(AuditLogger.prototype.runComplete).toHaveBeenCalled();

      // 1h. Run was persisted via pi.appendEntry
      expect(appendEntry).toHaveBeenCalledWith("wisp:run", expect.any(Object));

      // 1i. On-disk artifacts exist
      expect(existsSync(join(runDir, "run.json"))).toBe(true);
      expect(existsSync(join(runDir, "audit.jsonl"))).toBe(true);
      expect(existsSync(join(runDir, "sessions"))).toBe(true);
    });

    it("supports pre-compiled IR (skips compilation) for resume scenarios", async () => {
      const runsDir = join(tmpDir, "runs");
      const runDir = join(runsDir, "20260707-1200-test-workflow");
      const ir = makeLinearGraphIR();
      const summary = makeSuccessSummary();

      vi.mocked(createRunDir).mockReturnValueOnce(runDir);
      vi.mocked(executeDAG).mockImplementationOnce(async (opts) => {
        // Mutate runState so reconcileRunStatus + run.json reflect a successful run.
        for (const nodeId of opts.runState.nodes.keys()) {
          opts.runState.nodes.set(nodeId, {
            status: "completed",
            attempts: 0,
            toolCount: 0,
            filesEdited: [],
          });
        }
        return summary;
      });

      const options = makeOptions({
        runsDir,
        ir, // pre-compiled IR
        pi: { appendEntry: vi.fn() },
      });

      const result = await withTimeout(callRunWorkflow(options));

      expect(result.ok).toBe(true);
      // Compilation was skipped
      expect(compileWorkflow).not.toHaveBeenCalled();
    });
  });

  // ── 6. Cond-branching with skipped branches ─────────────────────
  describe("cond-branching with skipped branches (benign per S27)", () => {
    it("returns RunSuccess when the only skips are cond-not-taken (no dep-failed)", async () => {
      const runsDir = join(tmpDir, "runs");
      const runDir = join(runsDir, "20260707-1200-cond-workflow");

      // Build a cond-branching IR: cond → then-branch (succeeds), else-branch (cond-not-taken).
      const condIr: GraphIR = {
        title: "cond-workflow",
        slug: "cond-workflow",
        options: { maxConcurrency: 12, defaultRetries: 3 },
        nodes: [
          { id: "a", kind: "node", prompt: "Setup" },
          {
            id: "cond",
            kind: "cond",
            on: "a",
            whenFnRef: { __fn: true as const, src: "return true", kind: "cond" },
            then: "then-branch",
            else: "else-branch",
            dependsOn: ["a"],
          },
          { id: "then-branch", kind: "node", prompt: "Then branch" },
          { id: "else-branch", kind: "node", prompt: "Else branch" },
        ],
        edges: [
          { from: "a", to: "cond", kind: "dep" },
          { from: "cond", to: "then-branch", kind: "cond:branch" },
          { from: "cond", to: "else-branch", kind: "cond:branch" },
        ],
        conditions: [],
        schemas: {},
        primitives: {},
      };

      const summary: RunSummary = {
        runId: "test-cond-run",
        nodes: [
          { id: "a", status: "completed", toolCount: 0, retries: 0 },
          { id: "cond", status: "completed", toolCount: 0, retries: 0 },
          { id: "then-branch", status: "completed", toolCount: 5, retries: 0 },
          {
            id: "else-branch",
            status: "skipped",
            toolCount: 0,
            retries: 0,
            error: "cond-not-taken",
          },
        ],
        totals: {
          nodes: 4,
          completed: 3,
          failed: 0,
          skipped: 1,
          totalCostUsd: 0,
          totalDurationMs: 100,
        },
      };

      vi.mocked(compileWorkflow).mockResolvedValueOnce({ ir: condIr });
      vi.mocked(createRunDir).mockReturnValueOnce(runDir);
      vi.mocked(executeDAG).mockImplementationOnce(async (opts) => {
        // Mutate runState to match the summary — cond-not-taken is benign.
        opts.runState.nodes.set("a", {
          status: "completed",
          attempts: 0,
          toolCount: 0,
          filesEdited: [],
        });
        opts.runState.nodes.set("cond", {
          status: "completed",
          attempts: 0,
          toolCount: 0,
          filesEdited: [],
        });
        opts.runState.nodes.set("then-branch", {
          status: "completed",
          attempts: 0,
          toolCount: 5,
          filesEdited: [],
        });
        opts.runState.nodes.set("else-branch", {
          status: "skipped",
          attempts: 0,
          toolCount: 0,
          filesEdited: [],
          error: "cond-not-taken",
        });
        return summary;
      });

      const appendEntry = vi.fn();
      const options = makeOptions({
        runsDir,
        scriptSource: "export default wf('test')",
        pi: { appendEntry },
      });

      const result = await withTimeout(callRunWorkflow(options));

      // ── Assert success even though a branch was skipped (cond-not-taken is benign) ──
      expect(result.ok).toBe(true);
      const success = result as RunSuccess;
      expect(success.summary.totals.skipped).toBe(1);
      expect(success.summary.totals.failed).toBe(0);
      expect(success.summary.totals.completed).toBe(3);
      expect(success.summary.nodes).toHaveLength(4);

      // Audit run.complete was called (NOT runFail).
      expect(AuditLogger.prototype.runComplete).toHaveBeenCalled();
      expect(AuditLogger.prototype.runFail).not.toHaveBeenCalled();

      // runState.status was 'completed' in writeRunJson.
      expect(writeRunJson).toHaveBeenCalledWith(
        runDir,
        expect.objectContaining({ status: "completed" }),
      );

      // On-disk artifacts exist.
      expect(existsSync(join(runDir, "run.json"))).toBe(true);
      expect(existsSync(join(runDir, "audit.jsonl"))).toBe(true);
    });
  });

  // ── 2. Compile error ──────────────────────────────────────────
  describe("compile error", () => {
    it("returns a structured compile WispError without starting execution", async () => {
      const runsDir = join(tmpDir, "runs");
      const compileError = makeCompileError();

      vi.mocked(compileWorkflow).mockResolvedValueOnce({ error: compileError });

      const options = makeOptions({
        runsDir,
        scriptPath: "/tmp/broken-workflow.ts",
        pi: { appendEntry: vi.fn() },
      });

      const result = await withTimeout(callRunWorkflow(options));

      // Compile error: no successful run
      expect(result.ok).toBe(false);
      const failure = result as RunFailure;
      expect(failure.error.kind).toBe("compile");
      expect(failure.error.message).toContain("Syntax error");
      expect(failure.error.location).toBeDefined();

      // No execution started
      expect(executeDAG).not.toHaveBeenCalled();
      // No run dir was created (no valid IR to run)
      expect(createRunDir).not.toHaveBeenCalled();
    });
  });

  // ── 3. Validation error ───────────────────────────────────────
  describe("validation error", () => {
    it("returns a structured validation WispError without starting execution", async () => {
      const runsDir = join(tmpDir, "runs");
      const ir = makeLinearGraphIR();

      // Compilation succeeds but validation fails — the orchestrator is
      // expected to run validateIR internally and reject the IR.
      vi.mocked(compileWorkflow).mockResolvedValueOnce({ ir });
      // Make validateIR return errors so the orchestrator short-circuits.
      vi.mocked(validateIR).mockReturnValueOnce([
        { kind: "validation", message: "Test validation error" },
      ]);
      // NOTE: In the real orchestrator, validateIR is called internally.
      // We verify below that the returned error has kind "validation" and
      // carries sub-errors. The orchestrator must NOT pass an invalid IR
      // to executeDAG.

      const options = makeOptions({
        runsDir,
        scriptSource: "export default wf('test')",
        pi: { appendEntry: vi.fn() },
      });

      const result = await withTimeout(callRunWorkflow(options));

      expect(result.ok).toBe(false);
      const failure = result as RunFailure;
      expect(failure.error.kind).toBe("validation");
      if (failure.error.kind === "validation") {
        expect(failure.error.errors).toBeDefined();
        expect(failure.error.errors!.length).toBeGreaterThan(0);
      } else {
        // Unreachable — force a failure if the kind is not validation.
        expect(failure.error.kind).toBe("validation");
      }

      // No execution started for an invalid IR
      expect(executeDAG).not.toHaveBeenCalled();
    });
  });

  // ── 4. Runtime failure ────────────────────────────────────────
  describe("runtime failure", () => {
    it("returns a structured runtime WispError with partial RunSummary and audit.run.fail", async () => {
      const runsDir = join(tmpDir, "runs");
      const runDir = join(runsDir, "20260707-1200-test-workflow");
      const ir = makeLinearGraphIR();
      const failureSummary = makeFailureSummary();

      vi.mocked(compileWorkflow).mockResolvedValueOnce({ ir });
      vi.mocked(createRunDir).mockReturnValueOnce(runDir);
      vi.mocked(executeDAG).mockResolvedValueOnce(failureSummary);

      const options = makeOptions({
        runsDir,
        scriptSource: "export default wf('test')",
        pi: { appendEntry: vi.fn() },
      });

      const result = await withTimeout(callRunWorkflow(options));

      // Runtime failure: the orchestrator returns the error but still
      // produces on-disk artifacts (the run DID execute).
      expect(result.ok).toBe(false);
      const failure = result as RunFailure;
      expect(failure.error.kind).toBe("runtime");
      expect(failure.summary).toBeDefined();
      expect(failure.summary!.totals.failed).toBe(1);
      expect(failure.summary!.totals.skipped).toBe(1);

      // Execution DID start
      expect(createRunDir).toHaveBeenCalled();
      expect(executeDAG).toHaveBeenCalled();

      // Audit run.fail was called
      expect(AuditLogger.prototype.runFail).toHaveBeenCalledWith(
        expect.stringContaining("Task B failed"),
      );

      // On-disk artifacts exist despite the failure
      expect(existsSync(join(runDir, "run.json"))).toBe(true);
      expect(existsSync(join(runDir, "audit.jsonl"))).toBe(true);
    });
  });

  // ── 5. Mid-run finalization guard ─────────────────────────────
  describe("mid-run finalization guard", () => {
    it("captures an unexpected throw during execution as a runtime error and marks the run", async () => {
      const runsDir = join(tmpDir, "runs");
      const runDir = join(runsDir, "20260707-1200-test-workflow");
      const ir = makeLinearGraphIR();

      vi.mocked(compileWorkflow).mockResolvedValueOnce({ ir });
      vi.mocked(createRunDir).mockReturnValueOnce(runDir);
      // Simulate the process dying mid-execution: executeDAG rejects.
      vi.mocked(executeDAG).mockRejectedValueOnce(new Error("Process terminated unexpectedly"));

      const options = makeOptions({
        runsDir,
        scriptSource: "export default wf('test')",
        pi: { appendEntry: vi.fn() },
      });

      const result = await withTimeout(callRunWorkflow(options));

      // The orchestrator must catch the throw and return a structured error.
      expect(result.ok).toBe(false);
      const failure = result as RunFailure;
      expect(failure.error.kind).toBe("runtime");
      expect(failure.error.message).toContain("terminated");

      // There is no summary because execution never completed.
      expect(failure.summary).toBeUndefined();

      // The audit was informed of the run failure.
      expect(AuditLogger.prototype.runFail).toHaveBeenCalled();
    });

    it("handles an AbortSignal triggering mid-run", async () => {
      const runsDir = join(tmpDir, "runs");
      const runDir = join(runsDir, "20260707-1200-test-workflow");
      const ir = makeLinearGraphIR();

      vi.mocked(compileWorkflow).mockResolvedValueOnce({ ir });
      vi.mocked(createRunDir).mockReturnValueOnce(runDir);

      // Simulate abort — executeDAG returns a partial (failed) summary.
      const ac = new AbortController();
      vi.mocked(executeDAG).mockImplementationOnce(async () => {
        ac.abort();
        return makeFailureSummary();
      });

      const options = makeOptions({
        runsDir,
        scriptSource: "export default wf('test')",
        pi: { appendEntry: vi.fn() },
        signal: ac.signal,
      });

      const result = await withTimeout(callRunWorkflow(options));

      // Even with an abort, the orchestrator should not throw — it returns a
      // structured result. Whether it's success or failure depends on whether
      // executeDAG completed despite the abort.
      expect(result.ok).toBe(false);
      const failure = result as RunFailure;
      expect(failure.error.kind).toBe("runtime");
    });
  });
});
