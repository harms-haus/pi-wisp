// ═══════════════════════════════════════════════════════════════════════════
// run-workflow execution paths (extracted from run-workflow.ts).
//
// Param validation, the default adapter resolver, and the two execution
// paths (resume-from-run vs. fresh compile → run) that the run_workflow tool
// delegates to.
// ═══════════════════════════════════════════════════════════════════════════

import type { PoolUsage, RunState, ValidationError } from "../types.js";
import type { AgentAdapter } from "../adapters/types.js";
import { compileWorkflow } from "../dsl/compile.js";
import { runWorkflow } from "../engine/run.js";
import { prepareResume } from "../engine/resume.js";
import { piAdapter } from "../adapters/pi.js";
import { builderPath, harnessPath } from "../constants.js";

import {
  augmentEdgesWithFanOutChildren,
  buildFailureResult,
  buildSuccessResult,
  isValidationError,
  paramValidationError,
  wispErrorToDetails,
  type ToolResult,
} from "./run-workflow-helpers.js";
import { buildBaseRunOpts, clearTUI } from "./run-workflow-tui.js";
import type { ToolCtx } from "./run-workflow.js";

// ─── Default adapter ─────────────────────────────────────────────

/**
 * Default adapter resolver used when the tool's runtime context does not
 * provide a `getAdapter` callback. In v1 (D1) only the pi adapter ships.
 * Returns the canonical pi adapter for any requested type, logging a warning
 * when the requested type differs from "pi".
 */
export function defaultGetAdapter(type?: string, _nodeId?: string) {
  if (type !== undefined && type !== "pi") {
    console.warn(
      `run_workflow: requested adapter "${type}" is not available (v1 only ships pi); falling back to pi`,
    );
  }
  return piAdapter;
}

// ─── Validate params ─────────────────────────────────────────────

/**
 * Validate tool params. Returns a validation error result when none of
 * path/script/resumeFrom is provided. Otherwise returns the extracted params.
 */
export function validateParams(
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

// ─── Resume path ─────────────────────────────────────────────────

/**
 * Handle the resumeFrom path: load the prior run and execute it.
 * Returns a tool result on success or a structured error.
 */
export async function executeResumePath(
  resumeFrom: string,
  ctx: ToolCtx,
  runsDir: string,
  signal: AbortSignal | undefined,
  engineOnUpdate: ((runState: RunState, poolUsage: PoolUsage) => void) | undefined,
  getAdapter: (type?: string, nodeId?: string) => AgentAdapter,
): Promise<ToolResult> {
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
  if (result.ok) {
    const edges = augmentEdgesWithFanOutChildren(
      prepared.ir.edges,
      prepared.ir.nodes,
      new Set(result.summary.nodes.map((n) => n.id)),
    );
    return buildSuccessResult(result, edges);
  }
  return buildFailureResult(result);
}

// ─── Fresh-run path ──────────────────────────────────────────────

/**
 * Handle the compile → validate → run path for fresh workflow execution.
 * Returns a tool result on error or completion.
 */
export async function executeFreshPath(
  script: string | undefined,
  path: string | undefined,
  ctx: ToolCtx,
  runsDir: string,
  signal: AbortSignal | undefined,
  engineOnUpdate: ((runState: RunState, poolUsage: PoolUsage) => void) | undefined,
  getAdapter: (type?: string, nodeId?: string) => AgentAdapter,
): Promise<ToolResult> {
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
  if (result.ok) {
    const edges = augmentEdgesWithFanOutChildren(
      ir.edges,
      ir.nodes,
      new Set(result.summary.nodes.map((n) => n.id)),
    );
    return buildSuccessResult(result, edges);
  }
  return buildFailureResult(result);
}
