// ═══════════════════════════════════════════════════════════════════════════
// run_workflow tool (S34 / PLAN §13 / kb-19).
//
// Compiles, validates, and executes a wisp workflow DAG.
// Accepts an inline script, a path to a .ts workflow file, or a resume-from
// reference. Returns the synthesized output text plus a structured summary
// of all nodes. Errors are classified as compile, validation, or runtime
// with location hints.
//
// Error/result helpers live in `run-workflow-helpers.ts`, the TUI lifecycle
// in `run-workflow-tui.ts`, and the resume/fresh execution paths in
// `run-workflow-paths.ts`.
// ═══════════════════════════════════════════════════════════════════════════

import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { join } from "node:path";

import type { PoolUsage, RunState } from "../types.js";
import type { AgentAdapter } from "../adapters/types.js";
import { WISP_CONFIG_DIR } from "../constants.js";
import { WISP_WIDGET_NAME, renderWidget } from "../tui/widget.js";

import type { ErrorDetails, ToolResult } from "./run-workflow-helpers.js";
import { clearTUI, initTUI } from "./run-workflow-tui.js";
import {
  defaultGetAdapter,
  executeFreshPath,
  executeResumePath,
  validateParams,
} from "./run-workflow-paths.js";

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
export interface ToolCtx {
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
    onUpdate: ((update: ToolResult) => void) | undefined,
    ctx: ToolCtx,
  ): Promise<ToolResult> {
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
