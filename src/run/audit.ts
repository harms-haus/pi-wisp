// ═══════════════════════════════════════════════════════════════════════════
// Audit trail + run.json manifest (S22 / IMPLEMENTATION_PROMPT §12).
//
// `AuditLogger` writes an append-only `audit.jsonl` file inside the run
// directory. Every lifecycle event (run.start, node.start, node.tool,
// node.retry, node.complete, node.fail, node.skip, run.complete, run.fail) is
// one JSON object per line with a `ts` (ms Unix epoch) timestamp.
//
// A file descriptor is opened synchronously in the constructor and kept open
// for the lifetime of the logger. Each `log()` call uses `writeSync` on that
// fd (no open/close per event). Call {@link close} to close the fd.
//
// `writeRunJson` writes/overwrites the `run.json` manifest summarising the
// run's overall state, per-node results, and aggregate totals.
// ═══════════════════════════════════════════════════════════════════════════

import { closeSync, openSync, writeSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunState } from "../types.js";
import {
  summarizeNode,
  computeTotals,
  type RunSummaryNode,
  type RunSummaryTotals,
} from "../engine/events.js";

/** Relative path of the audit trail inside a run directory. */
const AUDIT_FILE = "audit.jsonl";
/** Relative path of the run manifest inside a run directory. */
const RUN_JSON_FILE = "run.json";

// ─── AuditLogger ──────────────────────────────────────────────────

/**
 * Append-only audit logger for a single run.
 *
 * Opens `<runDir>/audit.jsonl` synchronously in the constructor and writes
 * each line via `writeSync` (non-blocking I/O on the already-open fd).
 * Call {@link close} to release the file descriptor.
 */
export class AuditLogger {
  private readonly auditPath: string;
  private fd: number | undefined;
  private closed = false;

  /**
   * @param runDir - Absolute path to the run directory (must exist).
   */
  constructor(runDir: string) {
    this.auditPath = join(runDir, AUDIT_FILE);
    // Open the fd synchronously so the file exists immediately and all
    // subsequent writes are visible to synchronous readers.
    this.fd = openSync(this.auditPath, "a");
  }

  /** Append a single record as one JSON line with a `ts` timestamp. */
  private log(record: Record<string, unknown>): void {
    if (this.closed || this.fd === undefined) return;
    const line = JSON.stringify({ ...record, ts: Date.now() }) + "\n";
    // Non-blocking: write on the already-open fd avoids open/close per event.
    writeSync(this.fd, line);
  }

  /**
   * Close the underlying file descriptor. After calling `close()`,
   * no more events will be written.
   */
  close(): void {
    if (this.closed || this.fd === undefined) return;
    this.closed = true;
    closeSync(this.fd);
    this.fd = undefined;
  }

  // ── Run-level events ──────────────────────────────────────────

  /** The run has started. */
  runStart(): void {
    this.log({ type: "run.start" });
  }

  /** The run has completed successfully. */
  runComplete(): void {
    this.log({ type: "run.complete" });
  }

  /** The run has failed (unrecoverable or no remaining nodes). */
  runFail(error?: string): void {
    this.log({ type: "run.fail", error });
  }

  // ── Node-level events ─────────────────────────────────────────

  /** A node has started execution. */
  nodeStart(nodeId: string): void {
    this.log({ type: "node.start", nodeId });
  }

  /** A node has made a tool call. */
  nodeTool(nodeId: string, toolName: string): void {
    this.log({ type: "node.tool", nodeId, toolName });
  }

  /** A node is being retried (attempt N+1). */
  nodeRetry(nodeId: string, attempt: number, error?: string): void {
    this.log({ type: "node.retry", nodeId, attempt, error });
  }

  /** A node has completed successfully. */
  nodeComplete(
    nodeId: string,
    result: { sessionId?: string; durationMs?: number; toolCount?: number },
  ): void {
    this.log({
      type: "node.complete",
      nodeId,
      sessionId: result.sessionId,
      durationMs: result.durationMs,
      toolCount: result.toolCount,
    });
  }

  /** A node has failed (retries exhausted). */
  nodeFail(nodeId: string, error: string): void {
    this.log({ type: "node.fail", nodeId, error });
  }

  /** A node has been skipped (dep failed or cond not-taken). */
  nodeSkip(nodeId: string, reason: string): void {
    this.log({ type: "node.skip", nodeId, reason });
  }
}

// ─── writeRunJson ─────────────────────────────────────────────────

/**
 * Write (or overwrite) `run.json` inside the run directory.
 *
 * The manifest tracks final state including per-node summaries and aggregate
 * totals. Updated at run end (and optionally progressively).
 *
 * @param runDir - Absolute path to the run directory.
 * @param state  - Current in-memory run state.
 */
export function writeRunJson(runDir: string, state: RunState): void {
  const nodeEntries = Array.from(state.nodes.entries());
  const nodes: RunSummaryNode[] = nodeEntries.map(([id, rt]) => summarizeNode(id, rt));
  const totals: RunSummaryTotals = computeTotals(nodeEntries);

  const manifest = {
    runId: state.runId,
    title: state.title,
    slug: state.slug,
    status: state.status,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    nodes,
    totals,
  };

  writeFileSync(join(runDir, RUN_JSON_FILE), JSON.stringify(manifest, null, 2), "utf-8");
}
