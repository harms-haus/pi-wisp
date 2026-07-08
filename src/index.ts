// ═══════════════════════════════════════════════════════════════════════════
// pi-wisp extension entry (S36 / IMPLEMENTATION_PROMPT §15–§16)
//
// Registers lifecycle hooks and tools for multi-agent workflow orchestration.
// Follows the pi-workflows closure+accessor pattern: closure-captured run store
// with accessor callbacks, lifecycle hooks wrapped in stale guards, and tool
// registration via `pi.registerTool`.
//
// Lifecycle:
//   session_start / session_tree → loadConfig + reconstructRuns (stale-guarded)
//   session_shutdown             → clear TUI widget + status
//
// Tools:
//   run_workflow  — compile, validate, and execute a wisp workflow DAG
//   list_profiles — list available agent profiles across scopes
// ═══════════════════════════════════════════════════════════════════════════

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config.js";

export { builderPath, harnessPath } from "./constants.js";
import { runWorkflowTool } from "./tools/run-workflow.js";
import { listProfilesTool } from "./tools/list-profiles.js";
import { createRunStore } from "./run/store.js";
import { clearWidget, WISP_WIDGET_NAME } from "./tui/widget.js";
import { withStaleGuard } from "./stale.js";

/**
 * pi-wisp extension factory.
 *
 * Registers lifecycle hooks and tools. Follows the pi-workflows
 * closure+accessor pattern for the in-memory run store.
 */
export default function (pi: ExtensionAPI): void {
  // ── Closure-captured state (pi-workflows pattern) ────────────
  const runStore = createRunStore();

  // ── Shared session initialisation ────────────────────────────
  function initSession(ctx: ExtensionContext): void {
    // Load config — silently fall back to defaults on failure so a malformed
    // config never crashes the lifecycle hook.
    try {
      loadConfig(ctx.cwd);
    } catch (e) {
      console.error(`[wisp] config load failed, using defaults: ${(e as Error).message}`);
    }

    // Reconstruct prior runs from persisted session entries.
    // Stale `"running"` runs are automatically transitioned to `"error"`
    // (passive detection — the agent process must have died).
    runStore.reconstructRuns(ctx);
  }

  // ── Lifecycle hooks ──────────────────────────────────────────
  pi.on("session_start", (_event, ctx) => {
    withStaleGuard(() => {
      initSession(ctx);
    });
  });

  pi.on("session_tree", (_event, ctx) => {
    withStaleGuard(() => {
      initSession(ctx);
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // 1. Finalize runs: the pi runtime aborts tool signals on shutdown
    // (triggering killProcessTree in the spawner); mark any in-store runs
    // as error so reconstructed state reflects the abrupt termination.
    runStore.finalizeAll(pi);

    // 2. Sync audit is already flushed (AuditLogger uses appendFileSync).

    // 3. Clean up the TUI layer so stale widgets don't persist.
    ctx.ui.setStatus(WISP_WIDGET_NAME, undefined);
    clearWidget({ ui: ctx.ui });
  });

  // ── Register tools ──────────────────────────────────────────
  pi.registerTool(runWorkflowTool);
  pi.registerTool(listProfilesTool);
}
