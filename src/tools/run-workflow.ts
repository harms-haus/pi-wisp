// ═══════════════════════════════════════════════════════════════════════════
// run_workflow tool (S34 / PLAN §13 / kb-19).
//
// Compiles, validates, and executes a wisp workflow DAG.
// Accepts an inline script, a path to a .ts workflow file, or a resume-from
// reference. Returns the synthesized output text plus a structured summary
// of all nodes. Errors are classified as compile, validation, or runtime
// with location hints.
// ═══════════════════════════════════════════════════════════════════════════

import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { join } from "node:path";

import type { IREdge, PoolUsage, RunState, ValidationError, WispError } from "../types.js";
import type { RunSuccess, RunFailure } from "../engine/run.js";
import type { RunSummaryNode } from "../engine/executor.js";
import { compileWorkflow } from "../dsl/compile.js";
import { runWorkflow } from "../engine/run.js";
import { prepareResume } from "../engine/resume.js";
import { piAdapter } from "../adapters/pi.js";
import { CONFIG_DEFAULTS, WISP_CONFIG_DIR, builderPath, harnessPath } from "../constants.js";
import { loadConfig } from "../config.js";
import { clearWidget, WISP_WIDGET_NAME, renderWidget } from "../tui/widget.js";

import type { AgentAdapter } from "../adapters/types.js";

// ─── Parameter schema (§13) ───────────────────────────────────────

/**
 * TypeBox schema for the `run_workflow` tool parameters.
 *
 * Exactly one of `path` / `script` / `resumeFrom` is required.
 * - `path`: filesystem path to a `.ts` workflow script.
 * - `script`: inline workflow script source (compiled at runtime).
 * - `resumeFrom`: run directory slug or path to resume from a prior run.
 */
export const RunWorkflowParams = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "Path to a .ts workflow script file" })),
    script: Type.Optional(
      Type.String({ description: "Inline workflow script source (compiled at runtime)" }),
    ),
    resumeFrom: Type.Optional(
      Type.String({ description: "Run directory slug or path to resume from a prior run" }),
    ),
  },
  {
    description:
      "Exactly one of path/script/resumeFrom is required. Compiles, validates, and executes a wisp DAG workflow.",
  },
);

// ─── Default adapter ─────────────────────────────────────────────

/**
 * Default adapter resolver used when the tool's runtime context does not
 * provide a `getAdapter` callback. In v1 (D1) only the pi adapter ships.
 * Returns the canonical pi adapter for any requested type, logging a warning
 * when the requested type differs from "pi".
 */
function defaultGetAdapter(type?: string, _nodeId?: string) {
  if (type !== undefined && type !== "pi") {
    console.warn(
      `run_workflow: requested adapter "${type}" is not available (v1 only ships pi); falling back to pi`,
    );
  }
  return piAdapter;
}

// ─── Tool ctx shape ──────────────────────────────────────────────

/**
 * The expected shape of the `ctx` passed to the execute function.
 *
 * The `ui` methods are declared as optional methods (bivariant) so they are
 * compatible with the real `ExtensionUIContext` which has overloaded
 * `setWidget`. Without method syntax the overloaded type would not be
 * assignable to a simple function type.
 *
 * `getAdapter` is an optional injection point for tests or custom adapter
 * routing. When absent, `defaultGetAdapter` (the canonical pi adapter) is
 * used.
 *
 * `pi.appendEntry` is how persisted run snapshots survive across sessions.
 * When unset (e.g. in test contexts), runs are not persisted but the run
 * itself still completes normally.
 */
interface ToolCtx {
  cwd: string;
  ui?: {
    /** Set the TUI widget content (array of lines) or clear with `undefined`. */
    setWidget?(name: string, content: string[] | undefined): void;
    setStatus?(name: string, text: unknown): void;
  };
  /** Optional adapter resolver — overrides the default pi adapter. */
  getAdapter?: (type?: string, nodeId?: string) => AgentAdapter;
  /**
   * Pi extension API — when provided, run snapshots are persisted via
   * `appendEntry('wisp:run', serializedRun)` for cross-session reconstruction.
   */
  pi?: {
    appendEntry: (key: string, data: unknown) => void;
  };
}

// ─── Error helpers ───────────────────────────────────────────────

/** Shape returned as `details` for classified errors. */
interface ErrorDetails {
  kind: string;
  message: string;
  line?: number;
  nodeId?: string;
  errors?: unknown[];
}

/** Build a structured error response from a WispError. */
function wispErrorToDetails(err: WispError): ErrorDetails {
  const details: ErrorDetails = {
    kind: err.kind,
    message: err.message,
  };
  if (err.nodeId) details.nodeId = err.nodeId;
  if ("errors" in err && err.errors) {
    details.errors = err.errors;
  }
  // Parse location for line number hint.
  if (err.location) {
    const parts = err.location.split(":");
    if (parts.length >= 2) {
      const line = Number(parts[1]);
      if (!Number.isNaN(line)) details.line = line;
    }
  }
  return details;
}

/** Build a validation error response when params are invalid. */
function paramValidationError(message: string): {
  content: Array<{ type: "text"; text: string }>;
  details: ErrorDetails;
} {
  return {
    content: [{ type: "text", text: `Validation error: ${message}` }],
    details: { kind: "validation", message },
  };
}

/**
 * Find the DAG terminal (graph-sink) node among completed nodes.
 *
 * A terminal node is a completed node with no outgoing `dep` edge to an
 * incomplete node — i.e. every node that depends on it is also completed.
 * Returns `undefined` when the terminal cannot be unambiguously identified
 * (no edges available, zero or multiple candidates).
 */
function findTerminalNode(
  completed: RunSummaryNode[],
  allNodes: RunSummaryNode[],
  edges: IREdge[] | undefined,
): RunSummaryNode | undefined {
  if (!edges || edges.length === 0) return undefined;

  const completedIds = new Set(completed.map((n) => n.id));
  const allIds = new Set(allNodes.map((n) => n.id));

  // Filter dep edges that are within our graph.
  const relevantDepEdges = edges.filter(
    (e) => e.kind === "dep" && allIds.has(e.from) && allIds.has(e.to),
  );

  // Find completed nodes that have NO outgoing dep edge to an incomplete node.
  const terminals = completed.filter((completedNode) => {
    const outgoingDepEdges = relevantDepEdges.filter((e) => e.from === completedNode.id);
    return !outgoingDepEdges.some((e) => !completedIds.has(e.to));
  });

  return terminals.length === 1 ? terminals[0] : undefined;
}

/** Extract the synthesized result text from a successful run. */
function extractSynthesizedOutput(
  summary: {
    nodes: RunSummaryNode[];
    totals: { completed: number; nodes: number };
  },
  edges?: IREdge[],
): string {
  const completed = summary.nodes.filter((n) => n.status === "completed");
  if (completed.length === 0) {
    return `Workflow completed with no synthesized output (${summary.totals.completed}/${summary.totals.nodes} nodes succeeded).`;
  }

  // Prefer the DAG terminal node (unique graph sink) over the arbitrary
  // last-in-iteration-order node.
  const terminal = findTerminalNode(completed, summary.nodes, edges);
  const targetNode = terminal ?? completed[completed.length - 1];

  if (targetNode?.finalText) {
    return targetNode.finalText;
  }
  return `Workflow completed: ${summary.totals.completed} of ${summary.totals.nodes} nodes succeeded.`;
}

/** Build a tool result from a successful run workflow result. */
function buildSuccessResult(
  success: RunSuccess,
  edges?: IREdge[],
): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: extractSynthesizedOutput(success.summary, edges) }],
    details: {
      runId: success.summary.runId,
      runPath: success.runDir,
      nodes: success.summary.nodes,
      totals: success.summary.totals,
      failed: success.summary.nodes.filter((n) => n.status === "failed"),
    },
  };
}

/** Build a tool result from a failed run workflow result that has a summary. */
function buildFailureWithSummary(failure: RunFailure): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  const errorDetails = wispErrorToDetails(failure.error);
  // When multiple nodes failed, append a brief multi-failure list so the
  // caller sees all failures at a glance.
  const failedNodes = failure.summary?.nodes.filter((n) => n.status === "failed") ?? [];
  let text = failure.error.message;
  if (failedNodes.length > 1) {
    const failureList = failedNodes
      .map((n) => `  \u2717 ${n.id}: ${n.error ?? "unknown error"}`)
      .join("\n");
    text += `\n${failureList}`;
  }
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    details: {
      ...errorDetails,
      runPath: failure.runDir,
      runId: failure.summary?.runId,
      ...(failure.summary
        ? {
            nodes: failure.summary.nodes,
            totals: failure.summary.totals,
            failed: failure.summary.nodes.filter((n) => n.status === "failed"),
          }
        : {}),
    },
  };
}

/** Build a tool result from a run workflow failure (compile/validation/runtime). */
function buildFailureResult(failure: RunFailure): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  if (failure.summary) {
    return buildFailureWithSummary(failure);
  }
  return {
    content: [{ type: "text", text: failure.error.message }],
    details: wispErrorToDetails(failure.error),
  };
}

// ─── Validate params ─────────────────────────────────────────────

/**
 * Validate tool params. Returns a validation error result when none of
 * path/script/resumeFrom is provided. Otherwise returns the extracted params.
 */
function validateParams(
  params: Record<string, unknown>,
):
  | { path?: string; script?: string; resumeFrom?: string }
  | { error: ReturnType<typeof paramValidationError> } {
  const path = typeof params.path === "string" && params.path.length > 0 ? params.path : undefined;
  const script =
    typeof params.script === "string" && params.script.length > 0 ? params.script : undefined;
  const resumeFrom =
    typeof params.resumeFrom === "string" && params.resumeFrom.length > 0
      ? params.resumeFrom
      : undefined;

  if (!path && !script && !resumeFrom) {
    return {
      error: paramValidationError('One of "path", "script", or "resumeFrom" must be provided.'),
    };
  }

  return { path, script, resumeFrom };
}

// ─── TUI helpers ─────────────────────────────────────────────────

/** Initialize TUI widget and status at the start of a run. */
function initTUI(ctx: ToolCtx): void {
  ctx.ui?.setWidget?.(WISP_WIDGET_NAME, [`${WISP_WIDGET_NAME}: running workflow...`]);
  ctx.ui?.setStatus?.(WISP_WIDGET_NAME, "running");
}

/** Clear TUI widget and status at the end of a run. */
function clearTUI(ctx: ToolCtx): void {
  try {
    clearWidget(ctx);
  } catch {
    // Best-effort — TUI cleanup must never break the tool result.
  }
}

/** Build the base runWorkflow options shared by resume and fresh-run paths. */
function buildBaseRunOpts(
  ctx: ToolCtx,
  runsDir: string,
  signal: AbortSignal | undefined,
  engineOnUpdate: ((runState: RunState, poolUsage: PoolUsage) => void) | undefined,
  getAdapter: (type?: string, nodeId?: string) => AgentAdapter,
  profilesRunDir?: string,
) {
  // Load config from the project (fall back to CONFIG_DEFAULTS on error).
  let defaultRetries: number = CONFIG_DEFAULTS.defaultRetries;
  let retryBackoffMs: number = CONFIG_DEFAULTS.retryBackoffMs;
  let maxAgentConcurrency: number = CONFIG_DEFAULTS.maxAgentConcurrency;
  try {
    const cfg = loadConfig(ctx.cwd);
    defaultRetries = cfg.defaultRetries;
    retryBackoffMs = cfg.retryBackoffMs;
    maxAgentConcurrency = cfg.maxAgentConcurrency;
  } catch {
    // Config load failure is non-fatal — use hardcoded defaults.
  }
  return {
    runsDir,
    builderPath,
    harnessPath,
    defaultRetries,
    retryBackoffMs,
    maxAgentConcurrency,
    getAdapter,
    profiles: { cwd: ctx.cwd, ...(profilesRunDir ? { runDir: profilesRunDir } : {}) },
    pi: { appendEntry: ctx.pi?.appendEntry ?? (() => {}) },
    signal,
    onUpdate: engineOnUpdate,
  };
}

/**
 * Handle the resumeFrom path: load the prior run and execute it.
 * Returns a tool result on success or a structured error.
 */
async function executeResumePath(
  resumeFrom: string,
  ctx: ToolCtx,
  runsDir: string,
  signal: AbortSignal | undefined,
  engineOnUpdate: ((runState: RunState, poolUsage: PoolUsage) => void) | undefined,
  getAdapter: (type?: string, nodeId?: string) => AgentAdapter,
): Promise<ReturnType<typeof runWorkflowTool.execute>> {
  let prepared: ReturnType<typeof prepareResume>;
  try {
    prepared = prepareResume(resumeFrom);
  } catch (err) {
    clearTUI(ctx);
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: message }],
      details: {
        kind: "runtime",
        message,
      },
    };
  }

  const base = buildBaseRunOpts(ctx, runsDir, signal, engineOnUpdate, getAdapter, resumeFrom);
  const result = await runWorkflow({
    ir: prepared.ir,
    runState: prepared.runState,
    runDir: resumeFrom,
    ...base,
  });

  clearTUI(ctx);
  if (result.ok) return buildSuccessResult(result, prepared.ir.edges);
  return buildFailureResult(result);
}

/**
 * Keywords in compile/runtime error messages that indicate a VALIDATION
 * error rather than a true compilation or runtime failure. When the compile
 * step returns one of these, the tool reclassifies the result as a validation
 * error with the appropriate sub-errors array.
 */
const VALIDATION_PATTERNS = [
  /duplicate node id/i,
  /a node with this id already exists/i,
  /dependsOn/i,
  /not found/i,
  /outputSchema/i,
];

/**
 * Check if a WispError's message indicates a validation (graph-structure)
 * error. Returns true when the message matches any validation pattern.
 */
function isValidationError(err: WispError): boolean {
  // Only reclassify runtime errors that match validation patterns; a
  // genuine compile error (e.g. "Workflow script not found") must stay as
  // "compile" even if its message coincidentally matches a pattern.
  if (err.kind === "compile") return false;
  return VALIDATION_PATTERNS.some((re) => re.test(err.message));
}

/**
 * Handle the compile → validate → run path for fresh workflow execution.
 * Returns a tool result on error or completion.
 */
async function executeFreshPath(
  script: string | undefined,
  path: string | undefined,
  ctx: ToolCtx,
  runsDir: string,
  signal: AbortSignal | undefined,
  engineOnUpdate: ((runState: RunState, poolUsage: PoolUsage) => void) | undefined,
  getAdapter: (type?: string, nodeId?: string) => AgentAdapter,
): Promise<ReturnType<typeof runWorkflowTool.execute>> {
  // Compile
  const compileResult = await compileWorkflow({
    scriptSource: script,
    scriptPath: path,
    builderPath,
    harnessPath,
  });

  if ("error" in compileResult) {
    clearTUI(ctx);
    const err = compileResult.error;
    // Reclassify builder-level validation errors (e.g. duplicate node ids)
    // that compile.ts classifies as "runtime" into proper "validation" errors.
    if (isValidationError(err)) {
      const subErrors = err.kind === "validation" ? (err.errors ?? [err]) : [err];
      const validationError: ValidationError = {
        kind: "validation",
        message: err.message,
        errors: subErrors,
      };
      const errorDetails = wispErrorToDetails(validationError);
      return {
        content: [{ type: "text", text: validationError.message }],
        details: errorDetails,
      };
    }
    const errorDetails = wispErrorToDetails(err);
    return {
      content: [{ type: "text", text: err.message }],
      details: errorDetails,
    };
  }

  // Compile already validated — run the IR directly
  const ir = compileResult.ir;

  // Run
  const base = buildBaseRunOpts(ctx, runsDir, signal, engineOnUpdate, getAdapter);
  const result = await runWorkflow({ scriptSource: script, scriptPath: path, ir, ...base });

  clearTUI(ctx);
  if (result.ok) return buildSuccessResult(result, ir.edges);
  return buildFailureResult(result);
}

// ─── Tool definition ──────────────────────────────────────────────

export const runWorkflowTool = {
  name: "run_workflow" as const,
  label: "Run Workflow",
  description: [
    "Compile, validate, and execute a wisp workflow DAG.",
    "Accepts an inline script, a path to a .ts workflow file, or a resume-from reference.",
    "Returns the synthesized output text plus a structured summary of all nodes.",
    "Errors are classified as compile, validation, or runtime with location hints.",
  ].join(" "),
  parameters: RunWorkflowParams,

  // ── renderCall ──────────────────────────────────────────────

  renderCall(params: { path?: string; script?: string; resumeFrom?: string }): Component {
    if (params.resumeFrom) return new Text(`resume workflow from ${params.resumeFrom}`, 0, 0);
    if (params.path) return new Text(`run workflow from ${params.path}`, 0, 0);
    if (params.script) return new Text("run inline workflow", 0, 0);
    return new Text("run workflow", 0, 0);
  },

  // ── renderResult ────────────────────────────────────────────

  renderResult(
    result: { content: Array<{ type: string; text?: string }>; details: unknown },
    _options: { expanded: boolean; isPartial: boolean },
  ): Component {
    const text = result.content[0]?.text ?? "";
    const details = result.details as ErrorDetails | Record<string, unknown> | undefined;
    if (details && "kind" in details) {
      return new Text(`[${String(details.kind)}] ${text}`, 0, 0);
    }
    return new Text(text, 0, 0);
  },

  // ── execute ──────────────────────────────────────────────────

  async execute(
    _toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate:
      | ((update: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void)
      | undefined,
    ctx: ToolCtx,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
    // ── 1. Validate params ────────────────────────────────────
    const validated = validateParams(params);
    if ("error" in validated) return validated.error;
    const { path, script, resumeFrom } = validated;

    // ── 2. Derive runsDir + adapter ───────────────────────────
    const runsDir = join(ctx.cwd, WISP_CONFIG_DIR, "runs");
    const getAdapter = ctx.getAdapter ?? defaultGetAdapter;

    // ── 3. Set up onUpdate bridge — receives live RunState + pool snapshot ──
    const engineOnUpdate = onUpdate
      ? (runState: RunState, poolUsage: PoolUsage) => {
          // Render the live TUI widget
          const lines = renderWidget(runState, poolUsage);
          ctx.ui?.setWidget?.(WISP_WIDGET_NAME, lines);
          ctx.ui?.setStatus?.(WISP_WIDGET_NAME, "running");
          // Stream a textual progress update to the tool result
          let completed = 0;
          for (const nr of runState.nodes.values()) {
            if (nr.status === "completed") completed += 1;
          }
          onUpdate({
            content: [
              {
                type: "text",
                text: `Workflow running: ${completed}/${runState.nodes.size} nodes`,
              },
            ],
            details: { status: "running", runId: runState.runId },
          });
        }
      : undefined;

    // ── 4. TUI setup ──────────────────────────────────────────
    initTUI(ctx);

    try {
      // ── 5. Delegate to resume or fresh-run path ───────────────
      return resumeFrom
        ? await executeResumePath(resumeFrom, ctx, runsDir, signal, engineOnUpdate, getAdapter)
        : await executeFreshPath(script, path, ctx, runsDir, signal, engineOnUpdate, getAdapter);
    } catch (err) {
      clearTUI(ctx);
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        details: {
          kind: "runtime",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
