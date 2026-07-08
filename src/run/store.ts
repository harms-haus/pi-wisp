// ═══════════════════════════════════════════════════════════════════════════
// In-memory run store + pi.appendEntry persistence (S23 / IMPLEMENTATION_PROMPT §12).
//
// The store is a closure-held `Map<runId, RunState>` reconstructed from branch
// entries on `session_start` and finalized on `session_shutdown`.
//
// `reconstructRuns` is called on `session_start` to restore prior runs from
// the session manager's branch entries. Stale `"running"` runs are
// automatically transitioned to `"error"` (the agent process must have died).
//
// An LRU eviction policy keeps memory bounded when many runs accumulate.
//
// NOTE: mutation accessors (registerRun/updateRun/persistRun) were removed
// because runs are created and persisted inside engine/run.ts, not via the
// store. The store only serves reconstruction + finalization.
// ═══════════════════════════════════════════════════════════════════════════

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { NodeRuntime, NodeState, RunState, RunStatus } from "../types.js";

/** Key under which run snapshots are persisted via `pi.appendEntry`. */
export const RUN_ENTRY_KEY = "wisp:run";

/** Default maximum number of runs retained in memory before LRU eviction. */
const DEFAULT_MAX_RUNS = 50;

// ─── StoreAPI ─────────────────────────────────────────────────────

/**
 * Return type of `createRunStore()`. Exposes closure-held accessors so the
 * extension entry (S36) can call them from lifecycle hooks without a global.
 */
export interface StoreAPI {
  /**
   * Look up a run by id. Primarily used by tests to verify reconstruction;
   * production code uses reconstructRuns + finalizeAll.
   */
  getRun(runId: string): RunState | undefined;
  /**
   * Reconstruct prior runs from a session manager's branch entries.
   * Scans `ctx.sessionManager.getBranch()` in reverse (most recent first) for
   * pi `CustomEntry`s whose `customType` is `"wisp:run"`, deserialises their
   * `data` payload, and registers them.
   *
   * Stale `"running"` runs (and their in-flight nodes) are transitioned to
   * `"error"`/`"failed"` (passive detection).
   */
  reconstructRuns(ctx: { sessionManager?: { getBranch?: () => unknown[] } }): void;
  /**
   * Finalize any runs still marked as `running` — set them to `error` and
   * persist the terminal state via `pi.appendEntry`. Called from
   * `session_shutdown` as a safety net when the process terminates with
   * in-flight runs.
   */
  finalizeAll(pi: ExtensionAPI): void;
  /** Internal: for testing — clear the store. */
  _clear(): void;
}

// ─── (De)serialisation ────────────────────────────────────────────

/** Serialised per-node entry (mirrors the run.json / audit node shape). */
interface SerializedNode {
  id: string;
  status: string;
  sessionId?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  toolCount: number;
  retries: number;
  filesEdited: string[];
  costUsd?: number;
  error?: string;
}

/** Serialised run snapshot persisted via `pi.appendEntry`. */
interface SerializedRun {
  runId: string;
  title: string;
  slug: string;
  startedAt: number;
  endedAt?: number;
  status: string;
  nodes: SerializedNode[];
}

/** A typed brand over an untyped `unknown` object field access. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Serialise a {@link RunState} into the snapshot shape persisted via
 * `pi.appendEntry` and reconstructed by {@link reconstructRuns}.
 */
export function serializeRunState(run: RunState): SerializedRun {
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

/** Parse a string field, returning `undefined` when the value is not a string. */
function parseString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parse a number field, returning `undefined` when the value is not a number. */
function parseNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Parse a `string[]` field, dropping non-string members (empty array when absent). */
function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

// ─── Status / entry validation ──────────────────────────────────

const RUN_STATUS_VALUES: readonly RunStatus[] = ["running", "completed", "failed", "error"];
const NODE_STATE_VALUES: readonly NodeState[] = [
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "skipped",
];

const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUS_VALUES);
const NODE_STATE_SET: ReadonlySet<string> = new Set(NODE_STATE_VALUES);

/** Type guard: is `value` a valid {@link RunStatus}? */
function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && RUN_STATUS_SET.has(value);
}

/** Type guard: is `value` a valid {@link NodeState}? */
function isNodeState(value: unknown): value is NodeState {
  return typeof value === "string" && NODE_STATE_SET.has(value);
}

/** Shape of a pi `CustomEntry` narrowed to the fields wisp reads. */
interface CustomRunEntry {
  customType: string;
  data?: unknown;
}

/**
 * Type guard: is `entry` a pi `CustomEntry` (the real session-manager shape)?
 * A real custom entry is `{ type: 'custom', customType, data?, id, parentId, timestamp }`.
 */
function isCustomEntry(entry: unknown): entry is CustomRunEntry {
  const obj = asObject(entry);
  if (obj === undefined) return false;
  return obj["type"] === "custom" && typeof obj["customType"] === "string";
}

/**
 * Deserialise a single persisted node into an `[id, NodeRuntime]` pair.
 * Returns `undefined` when the entry lacks an `id`. Timing (`startedAt`/
 * `endedAt`) is restored directly, else synthesised from `durationMs` using
 * `runStartedAt` as a baseline so the reconstructed node reports a correct
 * duration instead of `0`.
 */
function deserializeNode(entry: unknown, runStartedAt: number): [string, NodeRuntime] | undefined {
  const n = asObject(entry);
  if (n === undefined) return undefined;
  const id = parseString(n["id"]);
  if (id === undefined) return undefined;

  // Timing: restore raw timestamps when present, else synthesise from
  // durationMs so `endedAt - startedAt` is non-zero.
  const durationMs = parseNumber(n["durationMs"]);
  let startedAt = parseNumber(n["startedAt"]);
  let endedAt = parseNumber(n["endedAt"]);
  if (startedAt === undefined && durationMs !== undefined) {
    startedAt = runStartedAt;
  }
  if (endedAt === undefined && startedAt !== undefined && durationMs !== undefined) {
    endedAt = startedAt + durationMs;
  }

  return [
    id,
    {
      status: isNodeState(n["status"]) ? n["status"] : "pending",
      sessionId: parseString(n["sessionId"]),
      startedAt,
      endedAt,
      attempts: parseNumber(n["retries"]) ?? 0,
      toolCount: parseNumber(n["toolCount"]) ?? 0,
      filesEdited: parseStringArray(n["filesEdited"]),
      costUsd: parseNumber(n["costUsd"]),
      error: parseString(n["error"]),
    },
  ];
}

/**
 * Deserialise a persisted snapshot back into a {@link RunState}.
 * Returns `undefined` when the payload is malformed (missing runId).
 *
 * Status strings are validated via {@link isRunStatus}/{@link isNodeState} and
 * fall back to `error`/`pending` when stale or unknown.
 */
function deserializeRun(value: unknown): RunState | undefined {
  const raw = asObject(value);
  if (raw === undefined) return undefined;
  const runId = parseString(raw["runId"]);
  if (runId === undefined) return undefined;

  const runStartedAt = parseNumber(raw["startedAt"]) ?? 0;

  const nodes = new Map<string, NodeRuntime>();
  if (Array.isArray(raw["nodes"])) {
    for (const entry of raw["nodes"]) {
      const pair = deserializeNode(entry, runStartedAt);
      if (pair === undefined) continue;
      nodes.set(pair[0], pair[1]);
    }
  }

  return {
    runId,
    title: parseString(raw["title"]) ?? "",
    slug: parseString(raw["slug"]) ?? "",
    startedAt: runStartedAt,
    endedAt: parseNumber(raw["endedAt"]),
    status: isRunStatus(raw["status"]) ? raw["status"] : "error",
    nodes,
  };
}

/**
 * Normalise stale per-node states after reconstruction: when the parent run is
 * marked `error`, any node still `running`/`ready` could not have finished, so
 * mark it `failed` (the agent process must have died mid-flight).
 */
function normalizeStaleNodes(run: RunState): void {
  if (run.status !== "error") return;
  for (const node of run.nodes.values()) {
    if (node.status === "running" || node.status === "ready") {
      node.status = "failed";
      if (node.error === undefined) {
        node.error = "Node was running when the run terminated unexpectedly.";
      }
    }
  }
}

// ─── createRunStore ───────────────────────────────────────────────

/**
 * Create a closure-based run store with LRU eviction.
 *
 * @param maxRuns - Maximum number of runs kept in memory before LRU eviction.
 *   Defaults to 50.
 * @returns A {@link StoreAPI} handle backed by a private Map.
 */
export function createRunStore(maxRuns?: number): StoreAPI {
  const cap = maxRuns ?? DEFAULT_MAX_RUNS;
  // A JS Map preserves insertion order, so the first key is the least-recently-used.
  const store = new Map<string, RunState>();

  /** Evict least-recently-used entries until the store fits within `cap`. */
  function evictIfNeeded(): void {
    while (store.size > cap) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }

  return {
    getRun(runId: string): RunState | undefined {
      const run = store.get(runId);
      if (run === undefined) return undefined;
      // Promote recency: re-insert at the tail of the Map.
      store.delete(runId);
      store.set(runId, run);
      return run;
    },

    reconstructRuns(ctx: { sessionManager?: { getBranch?: () => unknown[] } }): void {
      const sessionManager = ctx.sessionManager;
      if (sessionManager === undefined) return;
      const getBranch = sessionManager.getBranch;
      if (typeof getBranch !== "function") return;

      let branch: unknown[];
      try {
        branch = getBranch();
      } catch (err) {
        // Be resilient to a throwing getBranch, but surface the failure rather
        // than silently swallowing it (doc claims resilient, not silent).
        console.error("[wisp] reconstructRuns: sessionManager.getBranch() threw", err);
        return;
      }

      // Scan in reverse (most recent first); the first snapshot per runId wins,
      // so older progressive updates for the same run are ignored.
      const seen = new Set<string>();
      const reversed = [...branch].reverse();
      for (const entry of reversed) {
        // C1: pi persists snapshots as CustomEntry ({type:'custom',
        // customType, data, …}) — NOT a fabricated {key, value} shape.
        if (!isCustomEntry(entry)) continue;
        if (entry.customType !== RUN_ENTRY_KEY) continue;

        const run = deserializeRun(entry.data);
        if (run === undefined) continue;
        if (seen.has(run.runId)) continue;
        seen.add(run.runId);

        // Passive stale detection: a persisted "running" run means the agent
        // process died mid-flight (SCOUTING C4).
        if (run.status === "running") {
          run.status = "error";
        }
        // Cascade the terminal state to any nodes still in flight.
        normalizeStaleNodes(run);
        store.set(run.runId, run);
      }
      evictIfNeeded();
    },

    finalizeAll(pi: ExtensionAPI): void {
      for (const runState of store.values()) {
        if (runState.status === "running") {
          runState.status = "error";
          runState.endedAt = Date.now();
          pi.appendEntry(RUN_ENTRY_KEY, serializeRunState(runState));
        }
      }
    },

    _clear(): void {
      store.clear();
    },
  };
}
