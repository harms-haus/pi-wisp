// ═══════════════════════════════════════════════════════════════════════════
// Live TUI widget (PLAN S33 / kb-18).
//
// `renderWidget` produces a snapshot of the current run as a multi-line string,
// ready to pass to `ctx.ui.setWidget("wisp", lines, { placement: "belowEditor" })`.
// The caller (the executor) is responsible for debouncing `onUpdate` — this
// module just renders the current RunState + pool snapshot.
//
// Example output:
//
//   wisp: fix-bugs · stage: do-work · 1/5 nodes
//   ✓ review · do-work · 4.2s · 11 tools · 2 files
//   ⏳ fix-0 · do-work · 1.1s · 3 tools
//   · fix-1 · do-work
//   · fix-2 · do-work
//   ◇ verify · review
//   global 4/12 · zai 5/7
// ═══════════════════════════════════════════════════════════════════════════

import type { PoolUsage, RunState } from "../types.js";
import {
  formatFiles,
  formatTime,
  formatToolCount,
  poolUsageString,
  stageLabel,
  statusGlyph,
} from "./format.js";

/**
 * The canonical widget name used by all wisp TUI interactions. Extracted to a
 * named constant so that consumers (e.g. run_workflow tool) reference the same
 * string instead of duplicating the magic literal "wisp".
 */
export const WISP_WIDGET_NAME = "wisp";

/**
 * Shape of the pi-coding-agent `ctx.ui` surface used by `clearWidget`.
 *
 * Declared as methods (bivariant) so it is compatible with the real
 * `ExtensionUIContext` which has overloaded `setWidget`. Without method
 * syntax the overloaded type is not assignable to a simple function type.
 *
 * `content` is `string[] | undefined`: pass an array of lines (one per row)
 * or `undefined` to clear the widget. The pi runtime joins the lines internally.
 */
export interface WidgetUi {
  setWidget?(name: string, content: string[] | undefined): void;
  setStatus?(name: string, text: unknown): void;
}

/**
 * Derive the single header stage: the stage of the currently running node, else
 * the first queued (pending/ready) node, else "failed" when any node has
 * failed, else "done" when nothing remains.
 */
function deriveHeaderStage(
  runState: RunState,
  nodeStages: Record<string, string> | undefined,
): string {
  for (const [id, nr] of runState.nodes) {
    if (nr.status === "running") return stageLabel({ stage: nodeStages?.[id] });
  }
  for (const [id, nr] of runState.nodes) {
    if (nr.status === "pending" || nr.status === "ready") {
      return stageLabel({ stage: nodeStages?.[id] });
    }
  }
  for (const [, nr] of runState.nodes) {
    if (nr.status === "failed") return "failed";
  }
  return "done";
}

/**
 * Render the live TUI widget content as a string.
 *
 * Produces:
 * - A header line: `wisp: {title} · stage: {stage} · {completed}/{total} nodes`
 * - One row per node: `{glyph} {id} · {stage}[ · {elapsed} · {tools}[ · {files}]]`
 * - A footer line with the pool-usage snapshot (omitted when empty)
 *
 * @param runState - The current in-memory run state.
 * @param poolUsage - Current concurrency-pool snapshot (e.g. from `scheduler.usage()`).
 * @param nodeStages - Optional map of node id → stage label (when absent, nodes
 *   fall back to "do-work"; stages are normally derived from primitive metadata
 *   by the caller via `stageLabel`).
 * @returns The formatted lines ready for `ctx.ui.setWidget` (array of strings).
 */
export function renderWidget(
  runState: RunState,
  poolUsage: PoolUsage,
  nodeStages?: Record<string, string>,
): string[] {
  const total = runState.nodes.size;
  let completed = 0;
  for (const nr of runState.nodes.values()) {
    if (nr.status === "completed") completed += 1;
  }

  const lines: string[] = [];
  const headerStage = deriveHeaderStage(runState, nodeStages);
  lines.push(`wisp: ${runState.title} · stage: ${headerStage} · ${completed}/${total} nodes`);

  for (const [id, nr] of runState.nodes) {
    const glyph = statusGlyph(nr.status);
    const stage = stageLabel({ stage: nodeStages?.[id] });
    let row = `${glyph} ${id} · ${stage}`;

    const detailParts: string[] = [];
    if (nr.startedAt !== undefined) {
      const end = nr.endedAt ?? nr.startedAt;
      detailParts.push(formatTime(end - nr.startedAt));
    }
    if (nr.toolCount > 0) detailParts.push(formatToolCount(nr.toolCount));
    if (detailParts.length > 0) row += ` · ${detailParts.join(" · ")}`;
    // formatFiles returns its own leading " · " separator (or "" when empty).
    row += formatFiles(nr.filesEdited);
    // Append error snippet for failed nodes.
    if (nr.status === "failed" && nr.error) {
      const truncated = nr.error.length > 57 ? `${nr.error.slice(0, 57)}…` : nr.error;
      row += ` · ⚠ ${truncated}`;
    }

    lines.push(row);
  }

  const footer = poolUsageString(poolUsage);
  if (footer.length > 0) lines.push(footer);

  return lines;
}

/**
 * Clear the wisp widget and status line from the TUI.
 *
 * Calls `ctx.ui.setWidget("wisp", undefined)` and
 * `ctx.ui.setStatus("wisp", undefined)` to remove the live widget when a run
 * ends. Defensively handles a missing `ctx.ui` or individual methods.
 *
 * @param ctx - An object with an optional `ui` property matching the
 *   pi-coding-agent `ctx.ui` shape.
 */
export function clearWidget(ctx: { ui?: WidgetUi }): void {
  ctx.ui?.setWidget?.(WISP_WIDGET_NAME, undefined);
  ctx.ui?.setStatus?.(WISP_WIDGET_NAME, undefined);
}
