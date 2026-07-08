/**
 * Executor shared state + pure helpers (split from executor.ts).
 *
 * Defines {@link ExecutorContext} — the bundle of mutable shared state that
 * the `executeDAG` closures previously captured by lexical scope (nodeMap,
 * runState, ir, scheduler, adjacency maps, promptOverrides, inFlight, etc.).
 * The extracted sub-operation modules (`fanout.ts`, `run-node.ts`,
 * `reduce-node.ts`) receive an `ExecutorContext` as their first argument
 * instead of closing over `executeDAG` locals, following the precedent set by
 * `LoopDispatch` in `loop.ts`.
 *
 * Also hosts the pure helpers that need no closure state:
 *   - {@link resolveAgentType} — agent type resolution per node kind
 *   - {@link determineOutcome} — last-error-wins outcome classification
 *   - {@link validateNodeOutput} — JSON parse + post-hoc schema validation
 *   - {@link sleep} — promise-based delay
 *
 * @module
 */

import type { TSchema } from "typebox";

import type { AgentAdapter } from "../adapters/types.js";
import type { AuditLogger } from "../run/audit.js";
import type { Scheduler } from "./scheduler.js";
import type { GraphIR, IRNode, NormalizedEvent, RunState } from "../types.js";
import type { ExecuteDAGOptions } from "./executor.js";
import { DEFAULT_AGENT_TYPE } from "../constants.js";
import { validateOutputAgainstSchema } from "../dsl/fn-serialize.js";

// ─── ExecutorContext ──────────────────────────────────────────────

/**
 * Bundle of the mutable shared state that `executeDAG` closures previously
 * captured by lexical scope. Extracted sub-operations (`expandFanOut`,
 * `runNode`, `buildPrompt`, `failNode`, `depsMet`, `executeReduceNode`) read
 * and mutate these fields in place — every field is a reference owned by
 * `executeDAG`, never a copy.
 */
export interface ExecutorContext {
  /** The compiled graph IR (nodes may be extended by fanOut expansion). */
  ir: GraphIR;
  /** Mutable in-memory run state (updated in place as nodes run). */
  runState: RunState;
  /** Mutable node map: seeded from IR nodes, extended with dynamic fanOut children. */
  nodeMap: Map<string, IRNode>;
  /** Forward adjacency map (nodeId → successorIds) from IR edges. */
  successors: Map<string, string[]>;
  /** Reverse adjacency map (nodeId → predecessorIds) from IR edges. */
  predecessors: Map<string, string[]>;
  /** Per-node prompt overrides (e.g. loop body transcript-replay). */
  promptOverrides: Map<string, string>;
  /** In-flight node promises (concurrent execution). */
  inFlight: Map<string, Promise<void>>;
  /** Concurrency-pool scheduler (AND-semantics). */
  scheduler: Scheduler;
  /** Optional abort signal for cancellation. */
  signal?: AbortSignal;
  /** Optional audit logger for per-node lifecycle events. */
  audit?: AuditLogger;
  /** Resolved default retry count (from ir.options.defaultRetries or config). */
  defaultRetries: number;
  /** Resolved retry backoff base in ms. */
  retryBackoff: number;
  /** The original executeDAG options (used for profile resolution, etc.). */
  options: ExecuteDAGOptions;
  /** Request a TUI re-render (debounced by executeDAG). */
  notify: () => void;
  /** Adapter lookup: receives the adapter type + current node id. */
  getAdapter: (type?: string, nodeId?: string) => AgentAdapter;
}

// ─── Pure helpers ─────────────────────────────────────────────────

/** Resolve `ms` later. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the agent type for a node. Plain `node`s and `reduce` nodes carry an
 * optional `agentType`; every structural kind defaults to {@link DEFAULT_AGENT_TYPE}.
 */
export function resolveAgentType(node: IRNode): string {
  if (node.kind === "node" || node.kind === "reduce") return node.agentType ?? DEFAULT_AGENT_TYPE;
  return DEFAULT_AGENT_TYPE;
}

/** Outcome of a completed node run, classified from its event stream. */
export interface NodeOutcome {
  succeeded: boolean;
  errorMessage?: string;
  retryable: boolean;
}

/**
 * Determine the outcome of a completed node run from its event stream.
 *
 * The last `error` event (if any) makes the run fail (with its retryability);
 * otherwise a `done` event (or any benign stream) is a success.
 */
export function determineOutcome(events: NormalizedEvent[]): NodeOutcome {
  let lastError: { message: string; retryable: boolean } | undefined;
  for (const e of events) {
    if (e.type === "error") {
      lastError = { message: e.message, retryable: e.retryable };
    }
  }
  if (lastError) {
    return { succeeded: false, errorMessage: lastError.message, retryable: lastError.retryable };
  }
  return { succeeded: true, retryable: false };
}

/** Result of {@link validateNodeOutput}. */
export type NodeOutputValidation = { ok: true; parsed: unknown } | { ok: false; error: string };

/**
 * JSON-parse a node's final text and validate it against an output schema using
 * the canonical TypeBox post-hoc validator. Returns the parsed output on success
 * or a descriptive error string on failure. Never throws.
 */
export function validateNodeOutput(
  finalText: string | undefined,
  schema: unknown,
): NodeOutputValidation {
  if (!finalText) {
    return { ok: false, error: "Node produced no output text to validate against the schema" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalText);
  } catch {
    return { ok: false, error: "Output is not valid JSON; cannot validate against the schema" };
  }
  const result = validateOutputAgainstSchema(parsed, schema as TSchema);
  if (result.ok) return { ok: true, parsed };
  return { ok: false, error: `Schema validation failed: ${result.errors.join("; ")}` };
}
