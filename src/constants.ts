import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Get the pi agent directory path.
 * Ported from pi-subagents/src/constants.ts.
 */
export function getAgentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Directory name for wisp config within a project. */
export const WISP_CONFIG_DIR = ".wisp";

// ─── Run-directory layout ──────────────────────────────────────────

/** Directory name for the run-artifacts folder inside a run directory. */
export const RUN_ARTIFACTS_DIR = "artifacts";

/** Subdirectory (relative to a run dir) holding resolved agent-profile files. */
export const RUN_PROFILES_SUBDIR = join(RUN_ARTIFACTS_DIR, "profiles");

/** File path (relative to a run dir) of the copied workflow artifact. */
export const RUN_WORKFLOW_FILE = join(RUN_ARTIFACTS_DIR, "workflow.ts");

/** File path (relative to a run dir) of the serialized graph IR. */
export const RUN_GRAPH_FILE = join(RUN_ARTIFACTS_DIR, "graph.json");

/** Directory name for sessions inside a run directory. */
export const RUN_SESSIONS_DIR = "sessions";

/**
 * Absolute path to the shipped DSL builder module (for import rewriting
 * during compilation). Computed from `import.meta.url` so it survives jiti:
 * jiti preserves `import.meta.url` for loaded extensions.
 */
export const builderPath = fileURLToPath(new URL("./dsl/builder.ts", import.meta.url));

/**
 * Absolute path to the shipped DSL compile harness (tsx entrypoint).
 * The compile subprocess is spawned via this absolute path because a relative
 * path would resolve against the user's project cwd and ENOENT.
 */
export const harnessPath = fileURLToPath(new URL("./dsl/compile-harness.ts", import.meta.url));

/** Default agent type when none is explicitly specified (v1 ships only the pi adapter). */
export const DEFAULT_AGENT_TYPE = "pi";

/** Default values for the scalar config fields (concurrency/retries/backoff). */
export const CONFIG_DEFAULTS = {
  maxAgentConcurrency: 12,
  defaultRetries: 3,
  retryBackoffMs: 2000,
} as const;

/** Maximum number of messages persisted per session file before oldest are dropped. */
export const MAX_MESSAGES_PER_SESSION = 500;

/**
 * Default timeout (ms) for draining in-flight coroutines after the main loop
 * exits (e.g. on abort). Bounds the trailing `Promise.allSettled` so a
 * misbehaving adapter that ignores the abort signal cannot hang executeDAG
 * forever.
 */
export const ABORT_DRAIN_TIMEOUT_MS = 30_000;
