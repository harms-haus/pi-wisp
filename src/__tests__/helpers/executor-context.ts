// ═══════════════════════════════════════════════════════════════════════════
// Test helper: build an ExecutorContext for the extracted executor modules.
//
// This is the RED-team specification for the `ExecutorContext` interface that
// the green team will define in `src/engine/executor-types.ts`. It bundles the
// mutable shared state that the closures in `executeDAG` currently close over
// (nodeMap, runState, ir, scheduler, signal, successors, predecessors,
// promptOverrides, inFlight, audit, defaultRetries, retryBackoff, options,
// notify, getAdapter) so the extracted functions (`expandFanOut`, `runNode`,
// `buildPrompt`, `failNode`, `depsMet`, `executeReduceNode`) can receive it as
// a single argument instead of closing over executeDAG locals.
//
// Every helper here constructs a context from in-memory fixtures + a real
// Scheduler + a FakeAgentAdapter, mirroring how executeDAG wires its own
// internals. Tests override individual fields as needed.
// ═══════════════════════════════════════════════════════════════════════════

import { vi } from "vitest";

import type { ExecutorContext } from "../../engine/executor-types.js";
import type { ExecuteDAGOptions } from "../../engine/executor.js";
import type { GraphIR, IRNode, RunState } from "../../types.js";
import type { AgentAdapter } from "../../adapters/types.js";
import type { AuditLogger } from "../../run/audit.js";
import type { Scheduler } from "../../engine/scheduler.js";

import { CONFIG_DEFAULTS } from "../../constants.js";
import { createScheduler } from "../../engine/scheduler.js";
import { buildSuccessorsMap, buildPredecessorsMap } from "../../engine/retry.js";
import { createFakeAdapter } from "./fake-adapter.js";
import type { ResolveOptions } from "../../profiles/resolve.js";

/** Options for {@link makeExecutorContext}. */
export interface MakeCtxOptions {
  ir: GraphIR;
  runState: RunState;
  /** Adapter lookup (defaults to a fresh FakeAgentAdapter for every node). */
  getAdapter?: (type?: string, nodeId?: string) => AgentAdapter;
  /** Scheduler (defaults to a real `createScheduler()`). */
  scheduler?: Scheduler;
  /** Abort signal (defaults to none). */
  signal?: AbortSignal;
  /** Audit logger (defaults to none). */
  audit?: AuditLogger;
  /** defaultRetries (defaults to {@link CONFIG_DEFAULTS.defaultRetries}). */
  defaultRetries?: number;
  /** retryBackoff base in ms (defaults to {@link CONFIG_DEFAULTS.retryBackoffMs}). */
  retryBackoff?: number;
  /** notify callback (defaults to a no-op). */
  notify?: () => void;
  /** Profile resolution options stashed on ctx.options.profiles. */
  profiles?: ResolveOptions;
}

/**
 * Build an `ExecutorContext` from a graph + run state, seeded exactly as
 * `executeDAG` seeds its own closure state:
 *   - nodeMap from ir.nodes (mutable, extended by fanOut)
 *   - successors / predecessors from ir.edges
 *   - promptOverrides / inFlight as fresh empty maps
 *   - scheduler / getAdapter / notify / audit / signal as provided
 */
export function makeExecutorContext(opts: MakeCtxOptions): ExecutorContext {
  const nodeMap = new Map<string, IRNode>();
  for (const n of opts.ir.nodes) nodeMap.set(n.id, n);

  const successors = buildSuccessorsMap(opts.ir.edges);
  const predecessors = buildPredecessorsMap(opts.ir.edges);
  const promptOverrides = new Map<string, string>();
  const inFlight = new Map<string, Promise<void>>();

  const scheduler = opts.scheduler ?? createScheduler();
  const defaultAdapter = createFakeAdapter();
  const getAdapter =
    opts.getAdapter ?? ((_type?: string, _nodeId?: string): AgentAdapter => defaultAdapter);

  const options: ExecuteDAGOptions = {
    ir: opts.ir,
    runState: opts.runState,
    getAdapter,
    scheduler,
    signal: opts.signal,
    profiles: opts.profiles,
  };

  return {
    ir: opts.ir,
    runState: opts.runState,
    nodeMap,
    successors,
    predecessors,
    promptOverrides,
    inFlight,
    scheduler,
    signal: opts.signal,
    audit: opts.audit,
    defaultRetries: opts.defaultRetries ?? CONFIG_DEFAULTS.defaultRetries,
    retryBackoff: opts.retryBackoff ?? CONFIG_DEFAULTS.retryBackoffMs,
    options,
    getAdapter,
    notify: opts.notify ?? (() => {}),
  };
}

/**
 * A structurally-compatible fake {@link AuditLogger} whose node-level methods
 * are vitest spies. Cast through `unknown` because AuditLogger carries private
 * fields that prevent a plain-object structural assignment.
 */
export function makeFakeAudit(): AuditLogger & {
  nodeStart: ReturnType<typeof vi.fn>;
  nodeTool: ReturnType<typeof vi.fn>;
  nodeRetry: ReturnType<typeof vi.fn>;
  nodeComplete: ReturnType<typeof vi.fn>;
  nodeFail: ReturnType<typeof vi.fn>;
  nodeSkip: ReturnType<typeof vi.fn>;
} {
  return {
    nodeStart: vi.fn(),
    nodeTool: vi.fn(),
    nodeRetry: vi.fn(),
    nodeComplete: vi.fn(),
    nodeFail: vi.fn(),
    nodeSkip: vi.fn(),
    runStart: vi.fn(),
    runComplete: vi.fn(),
    runFail: vi.fn(),
    close: vi.fn(),
  } as unknown as AuditLogger & {
    nodeStart: ReturnType<typeof vi.fn>;
    nodeTool: ReturnType<typeof vi.fn>;
    nodeRetry: ReturnType<typeof vi.fn>;
    nodeComplete: ReturnType<typeof vi.fn>;
    nodeFail: ReturnType<typeof vi.fn>;
    nodeSkip: ReturnType<typeof vi.fn>;
  };
}
