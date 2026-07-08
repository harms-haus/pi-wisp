// ═══════════════════════════════════════════════════════════════════════════
// run-workflow TUI helpers (extracted from run-workflow.ts).
//
// Owns the TUI widget lifecycle (init/clear) and the assembly of the shared
// run-engine options consumed by both the resume and fresh-run paths.
// ═══════════════════════════════════════════════════════════════════════════

import type { PoolUsage, RunState } from "../types.js";
import type { AgentAdapter } from "../adapters/types.js";
import { CONFIG_DEFAULTS, builderPath, harnessPath } from "../constants.js";
import { loadConfig } from "../config.js";
import { clearWidget, WISP_WIDGET_NAME } from "../tui/widget.js";

import type { ToolCtx } from "./run-workflow.js";

/** Initialize the TUI widget and status at the start of a run. */
export function initTUI(ctx: ToolCtx): void {
  ctx.ui?.setWidget?.(WISP_WIDGET_NAME, [`${WISP_WIDGET_NAME}: running workflow...`]);
  ctx.ui?.setStatus?.(WISP_WIDGET_NAME, "running");
}

/** Clear the TUI widget and status at the end of a run. */
export function clearTUI(ctx: ToolCtx): void {
  try {
    clearWidget(ctx);
  } catch {
    // Best-effort — TUI cleanup must never break the tool result.
  }
}

/** Build the base runWorkflow options shared by the resume and fresh-run paths. */
export function buildBaseRunOpts(
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
