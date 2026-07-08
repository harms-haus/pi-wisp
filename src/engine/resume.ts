/**
 * Engine — Resume (S29a / S29b).
 *
 * `prepareResume` loads a prior run's artifacts (graph.json) and manifest
 * (run.json) from an on-disk run directory, reconstructs the in-memory
 * RunState, and applies the following status transitions:
 *
 *   - `completed` nodes → remain completed (output + sessionId preserved so
 *     dependents can access them via NodeCtx without re-running).
 *   - `failed` / `skipped` nodes → become `pending` with a FRESH sessionId
 *     (D4 — resume ≠ CLI resume; only .loop / .reviewLoop reuse transcripts).
 *   - `pending` / `ready` / `running` (stale) → become `pending` with fresh
 *     sessionId.
 *
 * The prepared IR + runState is then passed to `executeDAG` (S26), which runs
 * only the nodes that need re-running.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { GraphIR, NodeRuntime, NodeState, RunState } from "../types.js";

import type { TSchema } from "typebox";

import { RUN_GRAPH_FILE } from "../constants.js";
import { readSession } from "../run/sessions.js";
import { validateOutputAgainstSchema } from "../dsl/fn-serialize.js";

// ─── Public types ─────────────────────────────────────────────────

/** Result returned by {@link prepareResume}. */
export interface PrepareResumeResult {
  /** The loaded IR (graph). */
  ir: GraphIR;
  /** The reconstructed run state with nodes set to appropriate statuses. */
  runState: RunState;
  /** Node ids that need to be re-run (were failed / skipped / unfinished). */
  rerunNodeIds: string[];
}

// ─── Internal types for parsing ──────────────────────────────────

/** Shape of the `run.json` manifest as written by {@link writeRunJson}. */
interface RunJsonManifest {
  runId?: unknown;
  title?: unknown;
  slug?: unknown;
  status?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  nodes?: unknown[];
  totals?: unknown;
}

/** Shape of a single node entry inside `run.json`. */
interface RunJsonNode {
  id?: unknown;
  status?: unknown;
  sessionId?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  durationMs?: unknown;
  toolCount?: unknown;
  retries?: unknown;
  filesEdited?: unknown;
  costUsd?: unknown;
  finalText?: unknown;
  parsedOutput?: unknown;
  error?: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Parse a `string` field, returning `undefined` when absent or wrong type. */
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Parse a `number` field. */
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Parse a `string[]` field. */
function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is string => typeof e === "string");
}

/**
 * The set of valid {@link NodeState} values for validation during
 * deserialisation. Stale / unknown statuses fall back to `"pending"`.
 */
const NODE_STATES: ReadonlySet<string> = new Set<string>([
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "skipped",
]);

/** Parse a `NodeState`, falling back to `"pending"` for unknown values. */
function parseNodeState(v: unknown): NodeState {
  if (typeof v === "string" && NODE_STATES.has(v)) return v as NodeState;
  return "pending";
}

// ─── Deserialisation ─────────────────────────────────────────────

/**
 * Deserialise a single node entry from run.json into a {@link NodeRuntime}.
 *
 * Timing fields (`startedAt`, `endedAt`) are restored directly when present;
 * when only `durationMs` is available, `startedAt` is synthesised from the
 * run's start time so `endedAt - startedAt` is non-zero and matches the
 * recorded duration.
 */
function deserializeNodeEntry(
  entry: unknown,
  runStartedAt: number,
): [string, NodeRuntime] | undefined {
  const raw = entry as RunJsonNode | undefined;
  if (!raw) return undefined;
  const id = str(raw.id);
  if (id === undefined) return undefined;

  const durationMs = num(raw.durationMs);
  let startedAt = num(raw.startedAt);
  let endedAt = num(raw.endedAt);
  if (startedAt === undefined && durationMs !== undefined) {
    startedAt = runStartedAt;
  }
  if (endedAt === undefined && startedAt !== undefined && durationMs !== undefined) {
    endedAt = startedAt + durationMs;
  }

  // Read finalText and parsedOutput from the session file if available.
  // The run.json manifest may not carry these fields, but the session file
  // (written by S21) does. We prefer the session file for full fidelity.
  const sessionId = str(raw.sessionId);

  return [
    id,
    {
      status: parseNodeState(raw.status),
      sessionId,
      startedAt,
      endedAt,
      attempts: num(raw.retries) ?? 0,
      toolCount: num(raw.toolCount) ?? 0,
      filesEdited: strArr(raw.filesEdited),
      costUsd: num(raw.costUsd),
      finalText: str(raw.finalText),
      parsedOutput: raw.parsedOutput,
      error: str(raw.error),
    },
  ];
}

/**
 * Safely attempt JSON.parse, returning undefined on failure.
 */
function tryParseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Produces a fresh UUID-based session id (D4: retry sessions are always fresh). */
function freshSessionId(): string {
  return `sess-${randomUUID().slice(0, 8)}`;
}

// ─── Main entry point ────────────────────────────────────────────

/**
 * Prepare a workflow run for resumption from an on-disk run directory.
 *
 * Loads `artifacts/graph.json`, `run.json`, and session files; reconstructs
 * the in-memory {@link RunState}; applies status transitions per D4.
 *
 * @param runDir - Absolute path to the prior run directory
 *   (must contain artifacts/graph.json + run.json).
 * @returns A result with the loaded IR, reconstructed run state, and the set
 *   of node ids to re-run.
 * @throws When `runDir` does not contain the required files.
 */
export function prepareResume(runDir: string): PrepareResumeResult {
  // ── 1. Load IR ──────────────────────────────────────────────
  const graphPath = join(runDir, RUN_GRAPH_FILE);
  if (!existsSync(graphPath)) {
    throw new Error(`prepareResume: graph IR not found at "${graphPath}". Cannot resume.`);
  }
  const graphRaw = readFileSync(graphPath, "utf-8");
  let ir: GraphIR;
  try {
    ir = JSON.parse(graphRaw) as GraphIR;
  } catch {
    throw new Error(`prepareResume: failed to parse graph IR at "${graphPath}".`);
  }

  // ── 2. Load run.json (manifest) ─────────────────────────────
  const runJsonPath = join(runDir, "run.json");
  if (!existsSync(runJsonPath)) {
    throw new Error(`prepareResume: run.json not found at "${runJsonPath}". Cannot resume.`);
  }
  const runJsonRaw = readFileSync(runJsonPath, "utf-8");
  let manifest: RunJsonManifest;
  try {
    manifest = JSON.parse(runJsonRaw) as RunJsonManifest;
  } catch {
    throw new Error(`prepareResume: failed to parse run.json at "${runJsonPath}".`);
  }

  const runId = str(manifest.runId) ?? "unknown";
  const runStartedAt = num(manifest.startedAt) ?? 0;

  // ── 3. Reconstruct RunState from manifest ───────────────────
  const nodes = new Map<string, NodeRuntime>();
  if (Array.isArray(manifest.nodes)) {
    for (const entry of manifest.nodes) {
      const pair = deserializeNodeEntry(entry, runStartedAt);
      if (pair === undefined) continue;
      const [nodeId, rt] = pair;

      // Enrich with session data (finalText/parsedOutput) if available.
      if (rt.sessionId) {
        const session = readSession(runDir, rt.sessionId);
        if (session) {
          if (rt.finalText === undefined) rt.finalText = session.finalText;
          // The session file doesn't carry parsedOutput — that lives in
          // NodeRuntime only. If finalText was set by the session, good.
        }
      }

      nodes.set(nodeId, rt);
    }
  }

  const runState: RunState = {
    runId,
    title: str(manifest.title) ?? ir.title,
    slug: str(manifest.slug) ?? ir.slug,
    startedAt: runStartedAt,
    endedAt: num(manifest.endedAt),
    status: "running", // resume resets to running
    nodes,
  };

  // ── 4. Status transitions per D4 ──────────────────────────
  const rerunNodeIds: string[] = [];
  applyResumeTransitions(nodes, rerunNodeIds);

  // ── 5. Reconstruct parsedOutput for completed nodes ───────
  //
  // The run.json manifest (written by audit.ts summarizeNode) persists only
  // {id,status,sessionId,durationMs,toolCount,retries,error} but NOT
  // parsedOutput. To avoid data loss after resume, we re-parse + validate
  // each completed node's finalText against its schema (when known) to
  // reconstruct parsedOutput. This keeps the fix contained in resume.ts
  // without changing the audit format (kb-12).
  reconstructParsedOutput(nodes, ir);

  return { ir, runState, rerunNodeIds };
}

/**
 * Apply D4 status transitions to every node in the run state.
 *
 * Completed nodes preserve their state (output + sessionId available for
 * dependents).
 *
 * Failed / skipped / stale (ready / running) nodes are reset to `pending`
 * with a fresh sessionId and added to `rerunNodeIds` — they need active
 * re-execution.
 *
 * Nodes already `pending` are left as-is (their sessionId is cleared to
 * signal a fresh run, but they are NOT added to `rerunNodeIds` because they
 * will naturally become ready when their dependencies are met).
 *
 * Extracted from {@link prepareResume} to keep cyclomatic complexity under 15.
 */
function applyResumeTransitions(nodes: Map<string, NodeRuntime>, rerunNodeIds: string[]): void {
  for (const [nodeId, rt] of nodes) {
    if (rt.status === "completed") {
      // Preserve as-is — output + sessionId are available to dependents
      // via NodeCtx without re-running.
      continue;
    }

    // A node that was already pending before the run ended should stay
    // pending and will become ready naturally when its deps are met.
    // We clear the sessionId so a fresh one is assigned on re-run, but we
    // do NOT add it to rerunNodeIds.
    if (rt.status === "pending") {
      rt.sessionId = undefined;
      continue;
    }

    // Failed / skipped / stale (ready / running) — reset for active re-run.
    // Reset ALL accumulated state so the fresh run starts clean:
    //   - attempts=0 (otherwise prior attempts inflate the retry count beyond
    //     maxRetries and the node gets ZERO fresh retries)
    //   - toolCount/filesEdited/finalText/parsedOutput/costUsd/startedAt/endedAt
    //     are all cleared so the new run's telemetry replaces them.
    rt.status = "pending";
    rt.sessionId = freshSessionId();
    rt.attempts = 0;
    rt.toolCount = 0;
    rt.filesEdited = [];
    rt.finalText = undefined;
    rt.parsedOutput = undefined;
    rt.costUsd = undefined;
    rt.startedAt = undefined;
    rt.endedAt = undefined;
    rt.error = undefined;
    rerunNodeIds.push(nodeId);
  }
}

/**
 * Reconstruct `parsedOutput` for completed nodes whose parsedOutput was lost
 * during the run.json round-trip (kb-14 audit.ts {@code summarizeNode} persists
 * only a subset of NodeRuntime fields).
 *
 * For each completed node:
 *   - If `parsedOutput` is already set (e.g. restored from session file), skip.
 *   - If `finalText` exists AND the node has a known schema (node.outputSchema
 *     first, then ir.schemas[nodeId]), parse finalText as JSON and validate it
 *     against the schema. On success, set `parsedOutput` to the parsed value;
 *     on parse/validation failure, leave parsedOutput undefined (finalText is
 *     still available as fallback).
 *
 * @param nodes - Mutable node runtime map (mutated in place).
 * @param ir    - The loaded graph IR (provides schemas keyed by node id).
 */
function reconstructParsedOutput(nodes: Map<string, NodeRuntime>, ir: GraphIR): void {
  for (const [nodeId, rt] of nodes) {
    if (rt.status !== "completed") continue;
    if (rt.parsedOutput !== undefined) continue;
    if (rt.finalText === undefined || rt.finalText.length === 0) continue;

    // Resolve the schema: node.outputSchema first, then ir.schemas.
    // This matches the executor's resolution in runNode (S26).
    const irNode = ir.nodes.find((n) => n.id === nodeId);
    const schemaRaw =
      irNode !== undefined && irNode.outputSchema !== undefined && irNode.outputSchema !== true
        ? irNode.outputSchema
        : ir.schemas[nodeId];
    if (schemaRaw === undefined) continue;

    const parsed = tryParseJSON(rt.finalText);
    if (parsed === undefined) continue;

    const result = validateOutputAgainstSchema(parsed, schemaRaw as TSchema);
    if (result.ok) {
      rt.parsedOutput = parsed;
    }
  }
}
