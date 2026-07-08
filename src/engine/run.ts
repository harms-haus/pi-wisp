// ═══════════════════════════════════════════════════════════════════════════
// Run lifecycle orchestration (S31 / PLAN §7.3).
//
// Orchestrates a full workflow run:
//   1. Compile (or resume) → validated GraphIR
//   2. Create run directory + copy artifact + write graph
//   3. Create AuditLogger, Scheduler, RunState
//   4. executeDAG (concurrent, scheduler-gated, fake-adapter-aware)
//   5. On completion: writeRunJson, audit.run.complete, persistRun
//   6. On error: audit.run.fail, return structured WispError
// ═══════════════════════════════════════════════════════════════════════════

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { AgentAdapter } from "../adapters/types.js";
import type { ResolveOptions } from "../profiles/resolve.js";
import type {
  ConcurrencyLimits,
  GraphIR,
  NodeRuntime,
  PoolUsage,
  RunState,
  RunStatus,
  WispError,
} from "../types.js";
import type { RunSummary } from "./events.js";
import { compileWorkflow } from "../dsl/compile.js";
import { SKIP_REASONS } from "./retry.js";
import { validateIR } from "../dsl/validate.js";
import { createRunDir, copyWorkflowArtifact, writeGraph } from "../run/layout.js";
import { AuditLogger, writeRunJson } from "../run/audit.js";
import { RUN_ARTIFACTS_DIR, RUN_PROFILES_SUBDIR, RUN_SESSIONS_DIR } from "../constants.js";
import { createScheduler } from "./scheduler.js";
import { executeDAG } from "./executor.js";

import { RUN_ENTRY_KEY, serializeRunState } from "../run/store.js";

// ─── Options ─────────────────────────────────────────────────────────

/**
 * Options for {@link runWorkflow}.
 */
export interface RunWorkflowOptions {
  /** Workflow script source text (alternative to scriptPath). */
  scriptSource?: string;
  /** Path to the workflow script file (alternative to scriptSource). */
  scriptPath?: string;
  /** Pre-compiled GraphIR (for resume or test injection, skips compilation). */
  ir?: GraphIR;

  /**
   * Absolute directory where run directories are created
   * (from config runsDir, after ~-expansion).
   */
  runsDir: string;

  /** Absolute path to the shipped builder.ts (for import rewriting). */
  builderPath: string;
  /** Absolute path to the shipped compile-harness.ts (tsx entrypoint). */
  harnessPath: string;

  /** Default retries for nodes that don't specify their own. */
  defaultRetries: number;
  /** Base backoff in ms between retries (exponential: backoff * 2^(attempt-1)). */
  retryBackoffMs: number;

  /** Maximum global agent concurrency (default 12). */
  maxAgentConcurrency: number;
  /** Per-type concurrency limits (AND semantics). */
  concurrencyLimits?: ConcurrencyLimits;

  /** Adapter factory — receives adapter type + optional node id. */
  getAdapter: (type?: string, nodeId?: string) => AgentAdapter;
  /** Profile resolution options (cwd, runDir, inlineProfiles). */
  profiles?: ResolveOptions;
  /** Pi extension API (used for persistRun → appendEntry). */
  pi: Pick<ExtensionAPI, "appendEntry">;

  /** Optional pre-built run state (for resume). When provided, the run state
   *  is used as-is instead of creating a fresh one from the IR. The caller
   *  must ensure the run state is consistent with the IR. */
  runState?: RunState;
  /** Optional pre-existing run directory path (for resume). When provided,
   *  the run layout is set up in this directory instead of creating a new one.
   *  The directory must already exist with the appropriate layout. */
  runDir?: string;
  /** Optional abort signal for cancellation. */
  signal?: AbortSignal;
  /** Called after significant state changes with the live run state + pool snapshot. */
  onUpdate?: (runState: RunState, poolUsage: PoolUsage) => void;
}

// ─── Result ─────────────────────────────────────────────────────────

/**
 * Successful result of a workflow run.
 */
export interface RunSuccess {
  ok: true;
  summary: RunSummary;
  /** Absolute path to the run directory (with artifacts, sessions, audit, run.json). */
  runDir: string;
}

/**
 * Failed result of a workflow run.
 */
export interface RunFailure {
  ok: false;
  error: WispError;
  /** Absolute path to the run directory if one was created before the error; undefined otherwise. */
  runDir?: string;
  /** Partial summary if execution started before failing; undefined for compile/validation errors. */
  summary?: RunSummary;
}

/** Union of possible run results. */
export type RunWorkflowResult = RunSuccess | RunFailure;

// ─── RunState factory ───────────────────────────────────────────────

/**
 * Build a fresh {@link RunState} from a compiled {@link GraphIR}.
 *
 * Every node starts `pending` with zero attempts. The executor mutates
 * statuses as nodes run.
 */
export function makeRunStateFromIR(ir: GraphIR): RunState {
  const nodes = new Map<string, NodeRuntime>();
  for (const node of ir.nodes) {
    nodes.set(node.id, {
      status: "pending",
      attempts: 0,
      toolCount: 0,
      filesEdited: [],
    });
  }
  return {
    runId: randomUUID(),
    title: ir.title,
    slug: ir.slug,
    startedAt: Date.now(),
    status: "running" as const,
    nodes,
  };
}

// ─── Persistence helpers ────────────────────────────────────────────

/**
 * Persist a run snapshot via `pi.appendEntry`.
 * Best-effort (logs errors so a persist failure never breaks the run).
 */
function persistRun(pi: Pick<ExtensionAPI, "appendEntry">, runState: RunState): void {
  try {
    pi.appendEntry(RUN_ENTRY_KEY, serializeRunState(runState));
  } catch (err) {
    console.error("[wisp] persistRun: appendEntry threw", err);
  }
}

/**
 * Reconcile the run status after executeDAG returns.
 *
 * Only `dep-failed` skips count as run failures; `cond-not-taken` skips are
 * expected per S27 and must NOT fail the run.
 */
function reconcileRunStatus(summary: RunSummary): RunStatus {
  if (summary.totals.failed > 0) return "failed";
  // dep-failed skips indicate a dependency failure; cond-not-taken is benign.
  if (summary.totals.skipped > 0) {
    const hasDepFailed = summary.nodes.some(
      (n) => n.status === "skipped" && n.error === SKIP_REASONS.DEP_FAILED,
    );
    if (hasDepFailed) return "failed";
  }
  return "completed";
}

// ── Compile / validate helpers ──────────────────────────────────────

/**
 * Resolve the GraphIR: use a pre-compiled `ir` from options, or invoke the
 * compile pipeline. Returns `{ ir }` on success, or a compile/validation
 * failure result when the IR could not be obtained or validated.
 */
async function resolveIR(options: RunWorkflowOptions): Promise<{ ir: GraphIR } | RunFailure> {
  // Obtain the IR from either a pre-built `options.ir` (resume path, loaded
  // from an on-disk trust boundary) or the compile pipeline, then validate
  // BOTH through validateIR so a tampered/resume IR cannot bypass checks
  // (e.g. path traversal via node.cwd or a structurally-broken graph).
  let ir: GraphIR;
  if (options.ir !== undefined) {
    ir = options.ir;
  } else {
    const compileResult = await compileWorkflow({
      scriptSource: options.scriptSource,
      scriptPath: options.scriptPath,
      builderPath: options.builderPath,
      harnessPath: options.harnessPath,
    });
    if ("error" in compileResult) {
      return {
        ok: false,
        error: compileResult.error,
        runDir: undefined,
      };
    }
    ir = compileResult.ir;
  }
  const validationErrors = validateIR(ir);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      error: {
        kind: "validation",
        message: `Workflow validation failed with ${validationErrors.length} error${
          validationErrors.length === 1 ? "" : "s"
        }.`,
        errors: validationErrors,
      },
      runDir: undefined,
    };
  }
  return { ir };
}

/**
 * Create the on-disk run layout: run directory, copy workflow source, write
 * the graph IR.
 */
function createRunLayout(options: RunWorkflowOptions, ir: GraphIR): string {
  const runDir = createRunDir(options.runsDir, ir.title);
  // Ensure subdirectories exist (createRunDir creates them in production,
  // but tests may mock that out).
  mkdirSync(join(runDir, RUN_ARTIFACTS_DIR), { recursive: true });
  mkdirSync(join(runDir, RUN_PROFILES_SUBDIR), { recursive: true });
  mkdirSync(join(runDir, RUN_SESSIONS_DIR), { recursive: true });
  if (options.scriptPath !== undefined) {
    copyWorkflowArtifact(options.scriptPath, runDir);
  } else if (options.scriptSource !== undefined) {
    writeFileSync(join(runDir, RUN_ARTIFACTS_DIR, "workflow.ts"), options.scriptSource, "utf-8");
  }
  writeGraph(runDir, ir);
  return runDir;
}

/** Return a {@link RunFailure} for the mid-run finalization guard. */
function buildMidRunFailure(err: unknown, runDir: string): RunFailure {
  return {
    ok: false,
    error: {
      kind: "runtime",
      message: err instanceof Error ? err.message : String(err),
    },
    runDir,
  };
}

/** Return a {@link RunFailure} for runtime failures (nodes failed/skipped). */
function buildRuntimeFailure(summary: RunSummary, runDir: string): RunFailure {
  const errorMessage = `Workflow completed with ${summary.totals.failed} failed and ${summary.totals.skipped} skipped nodes.`;
  const firstFailed = summary.nodes.find((n) => n.status === "failed");
  const detailed = firstFailed?.error
    ? `${errorMessage} (e.g.: ${firstFailed.error})`
    : errorMessage;
  return {
    ok: false,
    error: {
      kind: "runtime",
      message: detailed,
    },
    runDir,
    summary,
  };
}

/**
 * Setup the run directory, AuditLogger, RunState, and Scheduler.
 * Returns the created artifacts or a {@link RunFailure} if any step throws.
 * On failure the partial run-dir is cleaned up best-effort.
 *
 * When `options.runDir` is provided, it is used as the run directory
 * (the caller is responsible for ensuring it exists and has the correct
 * layout). When `options.runState` is provided, it is used instead of
 * creating a fresh one from the IR (for resume).
 */
function setupRunEnv(
  options: RunWorkflowOptions,
  ir: GraphIR,
):
  | {
      runDir: string;
      audit: AuditLogger;
      runState: RunState;
      scheduler: ReturnType<typeof createScheduler>;
    }
  | RunFailure {
  let runDir: string | undefined;
  let isExistingRunDir = false;
  try {
    if (options.runDir !== undefined) {
      runDir = options.runDir;
      isExistingRunDir = true;
    } else {
      runDir = createRunLayout(options, ir);
    }
    const audit = new AuditLogger(runDir);
    audit.runStart();
    const runState = options.runState ?? makeRunStateFromIR(ir);
    const scheduler = createScheduler({
      maxAgentConcurrency: options.maxAgentConcurrency,
      limits: options.concurrencyLimits,
    });
    return { runDir, audit, runState, scheduler };
  } catch (err) {
    // Best-effort clean up the partial run-dir (only if we created it)
    if (runDir !== undefined && !isExistingRunDir) {
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        // Best-effort — cleanup must not throw, but log so failures are observable.
        console.error("[wisp] run directory cleanup failed:", cleanupErr);
      }
    }
    return {
      ok: false,
      error: {
        kind: "runtime",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Run a complete workflow lifecycle: compile → validate → create run dir →
 * execute → persist results.
 *
 * @param options - Compilation, execution, and persistence configuration.
 * @returns A {@link RunSuccess} or {@link RunFailure} describing the outcome.
 */
export async function runWorkflow(options: RunWorkflowOptions): Promise<RunWorkflowResult> {
  let resolved: { ir: GraphIR } | RunFailure;
  try {
    resolved = await resolveIR(options);
  } catch (err) {
    return {
      ok: false as const,
      error: {
        kind: "compile",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
  if ("error" in resolved) return resolved; // compile / validation failure
  const { ir } = resolved;

  // ── Setup phase (guarded: extract function cleans up on failure) ──
  const env = setupRunEnv(options, ir);
  if ("error" in env) return env;
  const { runDir, audit, runState, scheduler } = env;

  // Merge IR inline profiles into the profile resolution options so the
  // executor's resolveProfileSync can find profiles defined via
  // wf.profile() in the DSL. The IR's inlineProfiles always take
  // precedence over any caller-provided inlineProfiles (safe to merge
  // because they share the same scope — both are "inline" source).
  const mergedProfiles: ResolveOptions = {
    ...options.profiles,
    inlineProfiles: {
      ...options.profiles?.inlineProfiles,
      ...ir.inlineProfiles,
    },
  };

  let summary: RunSummary;
  try {
    summary = await executeDAG({
      ir,
      runState,
      getAdapter: options.getAdapter,
      scheduler,
      signal: options.signal,
      onUpdate: options.onUpdate,
      retryBackoffMs: options.retryBackoffMs,
      profiles: mergedProfiles,
      audit,
    });
  } catch (err) {
    runState.status = "error";
    runState.endedAt = Date.now();
    // Best-effort finalization — each step wrapped so a single failure does
    // not skip the next.
    try {
      audit.runFail(err instanceof Error ? err.message : String(err));
    } catch (err2) {
      // Best-effort — audit must not throw, but log so failures are observable.
      console.error("[wisp] audit.runFail failed:", err2);
    }
    try {
      writeRunJson(runDir, runState);
    } catch (err2) {
      // Best-effort — writeRunJson must not throw, but log so failures are observable.
      console.error("[wisp] writeRunJson failed:", err2);
    }
    persistRun(options.pi, runState);
    return buildMidRunFailure(err, runDir);
  }

  // ── Finalize: terminal audit event FIRST, then persist. ──
  // Wrapped in try/catch so a thrown cleanup error NEVER escapes.
  runState.status = reconcileRunStatus(summary);
  runState.endedAt = Date.now();

  try {
    if (runState.status === "failed") {
      const failure = buildRuntimeFailure(summary, runDir);
      audit.runFail(failure.error.message);
      writeRunJson(runDir, runState);
      persistRun(options.pi, runState);
      return failure;
    }

    audit.runComplete();
    writeRunJson(runDir, runState);
    persistRun(options.pi, runState);
  } catch (err) {
    // Thrown cleanup error: attempt audit.runFail best-effort and return a
    // structured RunFailure so the throw NEVER escapes the orchestrator.
    try {
      audit.runFail(err instanceof Error ? err.message : String(err));
    } catch (err2) {
      // Best-effort — audit must not throw, but log so failures are observable.
      console.error("[wisp] audit.runFail failed:", err2);
    }
    return {
      ok: false,
      error: {
        kind: "runtime",
        message: err instanceof Error ? err.message : String(err),
      },
      runDir,
      summary,
    };
  }

  return { ok: true, summary, runDir };
}
