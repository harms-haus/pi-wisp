/**
 * Engine — Shared event-reducer & adapter-invocation helpers.
 *
 * Consolidates DRY violations across executor.ts, synthesize.ts,
 * adapters/pi.ts, and run/audit.ts by providing ONE implementation of:
 *
 *   • finalTextFromEvents / fileEditsFromEvents / toolCountFromEvents /
 *     sessionIdFromEvents  (event-stream reducers)
 *   • nodeDurationMs / summarizeNode / computeTotals  (run-summary helpers)
 *   • invokeAdapter  (duck-type dispatch to emitEvents vs buildInvocation+runAgent)
 */

import type { AgentAdapter, NodeInvocationContext } from "../adapters/types.js";
import { runAgent, type RunAgentResult } from "../spawn/spawner.js";
import type { NodeRuntime, NormalizedEvent } from "../types.js";

// ─── Types ─────────────────────────────────────────────────────────

/** Per-node summary entry in a RunSummary or run.json manifest. */
export interface RunSummaryNode {
  id: string;
  status: string;
  sessionId?: string;
  durationMs?: number;
  toolCount: number;
  retries: number;
  error?: string;
  /** The node's final assistant text (synthesized output). */
  finalText?: string;
}

/** Aggregate totals in a RunSummary or run.json manifest. */
export interface RunSummaryTotals {
  nodes: number;
  completed: number;
  failed: number;
  skipped: number;
  totalCostUsd: number;
  totalDurationMs: number;
}

/** Return value of {@link executeDAG}. */
export interface RunSummary {
  runId: string;
  nodes: RunSummaryNode[];
  totals: RunSummaryTotals;
}

// ─── Constants ─────────────────────────────────────────────────────

/** Tool names whose `args.path` counts as a file edit. */
const DEFAULT_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "write_file"]);

// ─── Event reducers ───────────────────────────────────────────────

/**
 * Extract the final assistant text from an event stream.
 *
 * Preference order: an explicit `done.finalText` (used once) wins; otherwise
 * the last `message_complete.text` (full text, avoids doubling incremental
 * deltas); otherwise the concatenation of `text_delta` deltas.
 */
export function finalTextFromEvents(events: NormalizedEvent[]): string {
  let lastComplete: string | null = null;
  let deltaText = "";
  for (const e of events) {
    if (e.type === "done") return e.finalText;
    if (e.type === "message_complete") lastComplete = e.text;
    else if (e.type === "text_delta") deltaText += e.delta;
  }
  return lastComplete ?? deltaText;
}

/**
 * Extract a session id from events (first `session` event).
 */
export function sessionIdFromEvents(events: NormalizedEvent[]): string | undefined {
  for (const e of events) {
    if (e.type === "session") return e.id;
  }
  return undefined;
}

/**
 * Count `tool_call` events.
 */
export function toolCountFromEvents(events: NormalizedEvent[]): number {
  let count = 0;
  for (const e of events) {
    if (e.type === "tool_call") count += 1;
  }
  return count;
}

/**
 * Collect file paths from file-write `tool_call` events.
 *
 * @param events - The event stream to scan.
 * @param fileWriteTools - Set of tool names considered file writes.
 *   Defaults to `["edit", "write", "write_file"]`.
 */
export function fileEditsFromEvents(
  events: NormalizedEvent[],
  fileWriteTools?: ReadonlySet<string>,
): string[] {
  const tools = fileWriteTools ?? DEFAULT_FILE_WRITE_TOOLS;
  const edits: string[] = [];
  for (const e of events) {
    if (e.type === "tool_call" && tools.has(e.name)) {
      const args = e.args;
      if (args && typeof args === "object" && !Array.isArray(args)) {
        const path = (args as Record<string, unknown>).path;
        if (typeof path === "string") edits.push(path);
      }
    }
  }
  return edits;
}

// ─── Run-summary helpers ───────────────────────────────────────────

/** Duration of a node in milliseconds (0 when incomplete). */
export function nodeDurationMs(rt: NodeRuntime): number {
  if (rt.startedAt != null && rt.endedAt != null) {
    return rt.endedAt - rt.startedAt;
  }
  return 0;
}

/** Build a RunSummaryNode from a NodeRuntime entry. */
export function summarizeNode(id: string, rt: NodeRuntime): RunSummaryNode {
  return {
    id,
    status: rt.status,
    sessionId: rt.sessionId,
    durationMs: nodeDurationMs(rt),
    toolCount: rt.toolCount,
    retries: rt.attempts,
    error: rt.error,
    finalText: rt.finalText,
  };
}

/** Aggregate totals across all nodes in the run state. */
export function computeTotals(entries: Iterable<[string, NodeRuntime]>): RunSummaryTotals {
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let count = 0;
  for (const [, rt] of entries) {
    count += 1;
    if (rt.status === "completed") completed += 1;
    else if (rt.status === "failed") failed += 1;
    else if (rt.status === "skipped") skipped += 1;
    totalCostUsd += rt.costUsd ?? 0;
    totalDurationMs += nodeDurationMs(rt);
  }
  return { nodes: count, completed, failed, skipped, totalCostUsd, totalDurationMs };
}

// ─── Adapter invocation ───────────────────────────────────────────

/** Duck-typed emitEvents signature for fake (in-process) adapters. */
type EmitEventsFn = (
  onEvent: (event: NormalizedEvent) => void,
  ctx?: NodeInvocationContext,
  signal?: AbortSignal,
) => Promise<void>;

/** Options for {@link invokeAdapter}. */
export interface InvokeAdapterOptions {
  /** The final prompt for this node / synthesis. */
  prompt: string;
  /** Node id (used for context). */
  nodeId: string;
  /** Current attempt number (1-based). */
  attempt: number;
  /** Optional working directory override. */
  cwd?: string;
  /** Optional abort signal. */
  signal?: AbortSignal;
  /** Callback for each normalized event emitted by the adapter. */
  onEvent: (event: NormalizedEvent) => void;
  /**
   * Optional update callback (debounced externally). Called to signal the TUI
   * that something changed and a re-render should happen.
   */
  onUpdate?: () => void;
  /** Agent type (default "pi") passed to buildInvocation. */
  agentType?: string;
}

/**
 * Invoke an adapter uniformly, regardless of whether it is a fake (in-process)
 * adapter with `emitEvents` or a real adapter that requires a subprocess.
 *
 * Returns a `RunAgentResult` when a subprocess was spawned (real adapter), or
 * `undefined` when the fake-adapter path was used.
 */
export async function invokeAdapter(
  adapter: AgentAdapter,
  options: InvokeAdapterOptions,
): Promise<RunAgentResult | undefined> {
  const { prompt, nodeId, attempt, cwd, signal, onEvent, onUpdate, agentType } = options;

  // Duck-type detect a fake (in-process) adapter; otherwise spawn.
  const adapterAny = adapter as unknown as { emitEvents?: unknown };
  if (typeof adapterAny.emitEvents === "function") {
    const invokeCtx: NodeInvocationContext = { nodeId, attempt, prompt, cwd };
    await (adapterAny.emitEvents as EmitEventsFn)(onEvent, invokeCtx, signal);
    return undefined;
  }

  const invocation = adapter.buildInvocation(
    { profile: { agentType: agentType ?? "pi" }, source: "inline" },
    { nodeId, attempt, prompt, cwd },
  );
  return runAgent({
    command: invocation.command,
    args: invocation.args,
    env: invocation.env,
    stdinPrompt: invocation.stdinPrompt,
    signal,
    parseLine: (line: string) => adapter.parseEventStreamLine(line),
    onEvent: (event: NormalizedEvent | null) => {
      if (event !== null) onEvent(event);
    },
    onUpdate: onUpdate ?? (() => {}),
    cwd,
  });
}
