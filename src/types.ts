// ═══════════════════════════════════════════════════════════════════════════
// Core type surface for pi-wisp.
//
// This file defines the full type system shared across the engine, adapters,
// DSL, and run/persistence layers. It is deliberately free of runtime code so
// it can be excluded from coverage and imported everywhere as type-only.
// ═══════════════════════════════════════════════════════════════════════════

import type { WispProfile } from "./profiles/types.js";

// ─── Config slice ────────────────────────────────────────────────

/** Per-type concurrency limits keyed by provider, model, or agent type. */
export interface ConcurrencyLimits {
  byProvider?: Record<string, number>;
  byModel?: Record<string, number>;
  byAgentType?: Record<string, number>;
}

/** Top-level wisp configuration. */
export interface WispConfig {
  /** Maximum number of agents running concurrently across all pools. */
  maxAgentConcurrency: number;
  /** Per-type concurrency limits (AND-semantics: node must have room in all its pools). */
  limits?: ConcurrencyLimits;
  /** Additional directories to search for agent profiles. */
  profilesDirs?: string[];
  /** Directory for run artifacts (supports ~ expansion). */
  runsDir?: string;
  /** Default number of retries for a node when not specified. */
  defaultRetries: number;
  /** Base backoff in ms between retries (exponential). */
  retryBackoffMs: number;
  /** Default adapter options, keyed by adapter type. */
  adapterDefaults?: Record<string, unknown>;
}

// ─── Graph IR (§5) ───────────────────────────────────────────────

/** Kind of a function descriptor captured during DSL compilation. */
export type FnKind =
  "iterate" | "each" | "prompt" | "cond" | "merge" | "until" | "acceptOn" | "synthesize";

/**
 * Serialized form of a DSL function. The source is captured via
 * `Function.prototype.toString()` and rehydrated in the executor inside a
 * restricted context. See `docs/dsl.md` for the closure limitation + threat model.
 */
export interface FnDescriptor {
  __fn: true;
  src: string;
  kind: FnKind;
}

/** Structural kind of an IR node (mirrors the DSL atoms/macros). */
export type IRNodeKind = "node" | "fanOut" | "cond" | "loop" | "reduce" | "parallel" | "sequence";

/** Metadata recording which macro (if any) produced a node — used for stage labels + TUI grouping. */
export interface PrimitiveMeta {
  /** Macro kind, e.g. "reviewLoop" | "council" | "reviewFix"; plain nodes use "node". */
  kind: string;
  meta?: Record<string, unknown>;
}

/**
 * Minimal spec for a node produced by the DSL (full shape added in the builder, S11).
 * Used as the target type for `cond` `then`/`else` branches and fanOut `each` results.
 */
export interface NodeSpec {
  agentType?: string;
  profileRef?: string;
  prompt?: string;
  outputSchema?: unknown;
  dependsOn?: string[];
  stage?: string;
  retries?: number;
  timeoutSec?: number;
  cwd?: string;
}

/** Fields common to every IR node, regardless of kind. */
export interface IRNodeBase {
  id: string;
  /** Discriminator selecting the kind-specific member of the {@link IRNode} union. */
  kind: IRNodeKind;
  /** Node ids this node depends on (dep edges). */
  dependsOn?: string[];
  /** Stage label override (otherwise derived from primitive kind). */
  stage?: string;
  /** Per-node retry count override. */
  retries?: number;
  /** Per-node timeout in seconds. */
  timeoutSec?: number;
  /** Working directory override for the spawned agent. */
  cwd?: string;
  /** JSON Schema describing the expected structured output (post-hoc validated). */
  outputSchema?: unknown;
  /** Primitive metadata (macro provenance) for stage labeling + TUI grouping. */
  primitive?: PrimitiveMeta;
}

/**
 * A flattened node in the compiled graph, including macro-expanded sub-nodes.
 *
 * Discriminated by `kind` so that kind-specific fields (e.g. a `fanOut` node's
 * `from`/`iterateFnRef`, a `loop` node's `body`/`untilFnRef`) are only present
 * on the matching member. Plain `node`s carry `prompt`/`profileRef`; composite
 * kinds carry their structural references.
 */
export type IRNode = IRNodeBase &
  (
    | {
        kind: "node";
        /** Adapter type for this node (default "pi"). */
        agentType?: string;
        /** Reference (name) to a resolved profile. */
        profileRef?: string;
        /** Static prompt text (mutually exclusive with promptFnRef). */
        prompt?: string;
        /** Serialized prompt fn (mutually exclusive with prompt). */
        promptFnRef?: FnDescriptor;
      }
    | {
        kind: "fanOut";
        /** Producer node id whose output is iterated. */
        from: string;
        /** Serialized iterate fn producing the item array. */
        iterateFnRef: FnDescriptor;
        /** Serialized each fn mapping an item to a NodeSpec. */
        eachFnRef: FnDescriptor;
      }
    | {
        kind: "cond";
        /** Node id whose completion triggers branching. */
        on: string;
        /** Serialized when fn (boolean or branch key). */
        whenFnRef: FnDescriptor;
        /** Node id (or spec) taken when the predicate is truthy / matches. */
        then: string | NodeSpec;
        /** Node id (or spec) taken otherwise. */
        else?: string | NodeSpec;
      }
    | {
        kind: "loop";
        /** Body node id/spec reference. */
        body: string;
        /** Serialized until fn. */
        untilFnRef: FnDescriptor;
        /** Maximum iterations before forcing termination. */
        maxIterations?: number;
      }
    | {
        kind: "reduce";
        /** Member node ids being merged. */
        from: string[];
        /** Serialized merge fn (pure-JS merge when no profile). */
        mergeFnRef?: FnDescriptor;
        /** Reference (name) to a resolved profile (agent-run synthesis when set). */
        profileRef?: string;
        /** Adapter type for this node (default "pi"). */
        agentType?: string;
      }
    | { kind: "parallel" }
    | { kind: "sequence"; steps: string[] }
  );

/** Edge kinds in the IR. */
export type EdgeKind = "dep" | "fanOut" | "cond:branch" | "loop";

/** A directed edge between two nodes. */
export interface IREdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

/** A condition attached to a cond primitive (its expr is a serialized fn). */
export interface IRCondition {
  id: string;
  on: string;
  expr: FnDescriptor;
}

/** The serializable, validated, engine-facing graph representation. */
export interface GraphIR {
  title: string;
  slug: string;
  options: { maxConcurrency?: number; defaultRetries?: number };
  nodes: IRNode[];
  edges: IREdge[];
  conditions: IRCondition[];
  /** JSON Schema per node id (nodes declaring outputSchema). */
  schemas: Record<string, unknown>;
  /** Primitive metadata per node id (for stage labeling + TUI grouping). */
  primitives: Record<string, PrimitiveMeta>;
  /** Inline profiles registered via `.profile(name, {...})`, keyed by name. */
  inlineProfiles?: Record<string, WispProfile>;
}

// ─── Node / run runtime state (§7.1 / §12) ───────────────────────

/** Lifecycle state of a single node. */
export type NodeState = "pending" | "ready" | "running" | "completed" | "failed" | "skipped";

/** Per-node runtime state accumulated during execution. */
export interface NodeRuntime {
  status: NodeState;
  sessionId?: string;
  startedAt?: number;
  endedAt?: number;
  attempts: number;
  toolCount: number;
  filesEdited: string[];
  costUsd?: number;
  finalText?: string;
  /** Parsed outputSchema result (or raw text when no schema). */
  parsedOutput?: unknown;
  error?: string;
}

/** Lifecycle status of an entire run. */
export type RunStatus = "running" | "completed" | "failed" | "error";

/** In-memory state for a single workflow run. */
export interface RunState {
  runId: string;
  title: string;
  slug: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  nodes: Map<string, NodeRuntime>;
}

// ─── Concurrency pool usage (§9) ─────────────────────────────────

/** A single pool slot counter (current usage vs configured capacity). */
export interface PoolSlot {
  used: number;
  cap: number;
}

/** Snapshot of all concurrency pools, produced by the scheduler and shown in the TUI footer. */
export interface PoolUsage {
  global: PoolSlot;
  byAgentType: Record<string, PoolSlot>;
  byProvider: Record<string, PoolSlot>;
  byModel: Record<string, PoolSlot>;
}

// ─── Context API (§4.4) ──────────────────────────────────────────

/**
 * Context object passed to all rehydrated node fns at node-ready time.
 * `output`/`fanOut`/`member` return `unknown` (typed as arbitrary JSON); fns
 * narrow as needed. The executor guarantees dependency nodes are completed
 * before a fn runs, so `ctx.output('review')` is always populated for a node
 * that `dependsOn: ['review']`.
 */
export interface NodeCtx {
  /** A prior single node's parsed outputSchema result (or raw text). */
  output(nodeId: string): unknown;
  /** Array of a fanOut node's per-item results. */
  fanOut(nodeId: string): unknown[];
  /** Inside a council synthesize — access a member's output by index. */
  member(index: number): { output: unknown };
  /** Metadata about the current run + this attempt. */
  run: { runId: string; title: string; attempt: number; startedAt: number };
  /** Unstructured fallback: raw text + session id for a prior node. */
  raw(nodeId: string): { text: string; sessionId: string };
}

// ─── Normalized event model (§8.1) ───────────────────────────────

/**
 * The adapter-facing normalized event union. Each adapter translates its
 * native CLI JSONL into these events; the engine consumes them uniformly.
 */
export type NormalizedEvent =
  | { type: "session"; id: string }
  | { type: "text_delta"; delta: string }
  | { type: "message_complete"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; isError: boolean; content: string }
  | { type: "turn_end" }
  | { type: "error"; message: string; retryable: boolean }
  | {
      type: "done";
      sessionId: string;
      finalText: string;
      costUsd?: number;
      durationMs: number;
      toolCallCount: number;
    };

// ─── Structured errors (§3 / §13) ────────────────────────────────

/** Discriminator for the structured error union. */
export type WispErrorKind = "compile" | "validation" | "runtime";

/** A compile error (tsx/syntax + IR build). `location` is file:line:col when available. */
export interface CompileError {
  kind: "compile";
  nodeId?: string;
  message: string;
  location?: string;
}

/** A runtime error (agent failures during execution). */
export interface RuntimeError {
  kind: "runtime";
  nodeId?: string;
  message: string;
  location?: string;
}

/** A validation error (graph/profile/concurrency checks); may carry multiple sub-errors. */
export interface ValidationError {
  kind: "validation";
  nodeId?: string;
  message: string;
  location?: string;
  errors?: WispError[];
}

/** Structured, agent-actionable error union (always includes message + optional nodeId/location). */
export type WispError = CompileError | RuntimeError | ValidationError;
