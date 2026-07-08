/**
 * Engine — Retry & skip policy.
 *
 * Determines whether a node should be retried based on `node.retries` or
 * `config.defaultRetries`, computes exponential backoff durations, and
 * propagates skip status (reason "dep-failed") to transitive dependents while
 * leaving independent branches untouched (no fail-fast).
 *
 * Per D4, every general retry uses a FRESH session (only .loop / .reviewLoop
 * reuse sessions via transcript-replay). This module only computes policy; the
 * executor assigns fresh sessionIds.
 */

import type { IREdge, IRNode, RunState } from "../types.js";

/** A serialisable policy object produced from a node's spec + config defaults. */
export interface RetryPolicy {
  /** Maximum number of retry attempts before the node is marked failed. */
  maxRetries: number;
  /** Base backoff duration in milliseconds. */
  backoffMs: number;
}

/** Reason codes for why a node was skipped. */
export type SkipReason = "dep-failed" | "cond-not-taken" | "max-iterations" | "resume-skip";

/**
 * Named constant map for skip reasons.
 * Use instead of raw string literals to stay linked to the type definition.
 */
export const SKIP_REASONS = {
  DEP_FAILED: "dep-failed",
  COND_NOT_TAKEN: "cond-not-taken",
  MAX_ITERATIONS: "max-iterations",
  RESUME_SKIP: "resume-skip",
} as const;

/**
 * Derive the RetryPolicy for a node, falling back to config defaults.
 *
 * A node with `retries` set (including `0` = no retries) overrides the default;
 * an absent `retries` falls back to `defaultRetries`.
 *
 * @param node           - The IR node (may carry `retries`).
 * @param defaultRetries - The config-level default (e.g. 3).
 * @param retryBackoffMs - The config-level base backoff (e.g. 2000).
 * @returns A resolved RetryPolicy.
 */
export function resolvePolicy(
  node: IRNode,
  defaultRetries: number,
  retryBackoffMs: number,
): RetryPolicy {
  return {
    maxRetries: node.retries !== undefined ? node.retries : defaultRetries,
    backoffMs: retryBackoffMs,
  };
}

/**
 * Determine whether a node should be retried given its current attempt count.
 *
 * @param policy  - The resolved RetryPolicy.
 * @param attempt - The zero-based attempt number (0 = first attempt).
 * @returns `true` if the node should be retried (attempt < maxRetries).
 */
export function shouldRetry(policy: RetryPolicy, attempt: number): boolean {
  return attempt < policy.maxRetries;
}

/**
 * Compute the backoff duration for a given attempt.
 *
 * The delay is `retryBackoffMs * 2^(attempt - 1)` so that:
 *   attempt 0 → 0 (first try, no backoff)
 *   attempt 1 → backoffMs
 *   attempt 2 → 2 * backoffMs
 *   attempt 3 → 4 * backoffMs
 *   ...
 *
 * @param policy  - The resolved RetryPolicy.
 * @param attempt - The zero-based attempt number.
 * @returns Delay in milliseconds.
 */
export function backoffMs(policy: RetryPolicy, attempt: number): number {
  if (attempt <= 0) return 0;
  return policy.backoffMs * 2 ** (attempt - 1);
}

/**
 * Build a forward adjacency map (nodeId → successorIds) from IR edges.
 * Follows `dep` + `fanOut` + `cond:branch` edge kinds so ALL dependents
 * of a failed node can be marked skipped.
 */
export function buildSuccessorsMap(edges: IREdge[]): Map<string, string[]> {
  const successors = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind === "dep" || edge.kind === "fanOut" || edge.kind === "cond:branch") {
      let list = successors.get(edge.from);
      if (!list) {
        list = [];
        successors.set(edge.from, list);
      }
      list.push(edge.to);
    }
  }
  return successors;
}

/**
 * Build a reverse adjacency map (nodeId → predecessorIds) from IR edges.
 * Follows the same edge kinds as {@link buildSuccessorsMap}.
 */
export function buildPredecessorsMap(edges: IREdge[]): Map<string, string[]> {
  const predecessors = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind === "dep" || edge.kind === "fanOut" || edge.kind === "cond:branch") {
      let list = predecessors.get(edge.to);
      if (!list) {
        list = [];
        predecessors.set(edge.to, list);
      }
      list.push(edge.from);
    }
  }
  return predecessors;
}

/** Resolve the set of direct successor node ids for `id` from the forward adjacency map. */
function successorsOf(successors: Map<string, string[]>, id: string): string[] {
  return successors.get(id) ?? [];
}

/**
 * Mark a node as failed and propagate skip status to its transitive dependents.
 *
 * Direct and transitive dependents of the failed node (reachable via `dep`
 * edges) are marked `"skipped"` with the given reason, EXCEPT nodes already
 * `"completed"` (which succeeded and whose own dependents remain runnable).
 * Independent branches — nodes that do not transitively depend on the failed
 * node — are NOT affected (no fail-fast). This function mutates
 * `runState.nodes` in place.
 *
 * @param nodeId   - The id of the node that failed.
 * @param runState - The current run state (mutated in place).
 * @param reason   - The skip reason to assign to dependents.
 * @param successors - Forward adjacency map built from IR edges.
 */
export function propagateSkip(
  nodeId: string,
  runState: RunState,
  reason: SkipReason,
  successors: Map<string, string[]>,
  /** Optional callback invoked for each node that gets marked as skipped. */
  onSkip?: (skippedNodeId: string, skipReason: SkipReason) => void,
): void {
  const failedNode = runState.nodes.get(nodeId);
  if (failedNode) {
    failedNode.status = "failed";
  }

  const visited = new Set<string>([nodeId]);
  const queue: string[] = successorsOf(successors, nodeId);

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (visited.has(current)) continue;
    visited.add(current);

    const rt = runState.nodes.get(current);
    if (rt) {
      // A completed node succeeded: leave it (and its dependents) untouched.
      if (rt.status === "completed") continue;
      rt.status = "skipped";
      rt.error = reason;
      onSkip?.(current, reason);
    }

    queue.push(...successorsOf(successors, current));
  }
}
