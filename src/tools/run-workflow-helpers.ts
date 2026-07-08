// ═══════════════════════════════════════════════════════════════════════════
// run-workflow error/result helpers (extracted from run-workflow.ts).
//
// Pure, ctx-free utilities that classify WispErrors, locate the DAG terminal
// node, and assemble the uniform `{ content, details }` shape returned by the
// run_workflow tool. Kept in a focused module so the tool definition and the
// execution paths stay small.
// ═══════════════════════════════════════════════════════════════════════════

import type { IREdge, WispError } from "../types.js";
import type { RunFailure, RunSuccess } from "../engine/run.js";
import type { RunSummaryNode } from "../engine/events.js";

// ─── Result shape ─────────────────────────────────────────────────

/** Uniform tool result: a `content` array plus structured `details`. */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

// ─── Error details ───────────────────────────────────────────────

/** Shape returned as `details` for classified errors. */
export interface ErrorDetails {
  kind: string;
  message: string;
  line?: number;
  nodeId?: string;
  errors?: unknown[];
}

/** Build a structured error response from a WispError. */
export function wispErrorToDetails(err: WispError): ErrorDetails {
  const details: ErrorDetails = {
    kind: err.kind,
    message: err.message,
  };
  if (err.nodeId) details.nodeId = err.nodeId;
  if ("errors" in err && err.errors) {
    details.errors = err.errors;
  }
  // Parse location for line number hint.
  if (err.location) {
    const parts = err.location.split(":");
    if (parts.length >= 2) {
      const line = Number(parts[1]);
      if (!Number.isNaN(line)) details.line = line;
    }
  }
  return details;
}

/** Build a validation error result when params are invalid. */
export function paramValidationError(message: string): {
  content: Array<{ type: "text"; text: string }>;
  details: ErrorDetails;
} {
  return {
    content: [{ type: "text", text: `Validation error: ${message}` }],
    details: { kind: "validation", message },
  };
}

// ─── Terminal-node synthesis ─────────────────────────────────────

/**
 * Reconstruct the dynamic fan-out child -> consumer `dep` edges that the engine
 * wires at expansion time (see `expandFanOut`), so sink detection below can see
 * them.
 *
 * The static `graph.json` edges only record the fan-out parent -> consumer
 * relationship; the expanded children (`<fanOutId>-<index>`) are created at
 * runtime and are absent from the stored IR. For each static `dep` edge whose
 * source is a `fanOut` node, this adds a `dep` edge from every expanded child
 * present in `summaryNodeIds` to that edge's target. Returns a copy of the
 * input edges (unchanged) when there are no fan-out nodes.
 */
export function augmentEdgesWithFanOutChildren(
  edges: readonly IREdge[],
  irNodes: readonly { id: string; kind?: string }[],
  summaryNodeIds: ReadonlySet<string>,
): IREdge[] {
  const fanOutIds = new Set(irNodes.filter((n) => n.kind === "fanOut").map((n) => n.id));
  if (fanOutIds.size === 0) return [...edges];
  const augmented = [...edges];
  for (const e of edges) {
    if (e.kind !== "dep" || !fanOutIds.has(e.from)) continue;
    let i = 0;
    for (;;) {
      const childId = `${e.from}-${i}`;
      if (!summaryNodeIds.has(childId)) break;
      augmented.push({ from: childId, to: e.to, kind: "dep" });
      i++;
    }
  }
  return augmented;
}

/**
 * Find the DAG terminal (graph-sink) node among completed nodes.
 *
 * Preference order:
 *   1. A completed node with NO outgoing edge of any kind to any known node —
 *      a true graph sink (nothing consumes it), i.e. the workflow's final
 *      result. When several exist, prefer the one with non-empty output (this
 *      drops grouping/placeholder nodes like `parallel`/`sequence` and fan-out
 *      parents, which complete with no output).
 *   2. Otherwise, a completed node with no outgoing `dep` edge to an incomplete
 *      node (every consumer is also completed) — the looser "no pending
 *      consumer" definition.
 *
 * Returns `undefined` when the terminal is ambiguous (no edges, or multiple
 * candidates with no tie-breaker). Dynamic fan-out children must be surfaced
 * via {@link augmentEdgesWithFanOutChildren} first, so a `reduce` over a
 * fan-out is identified as the sink instead of the (edgeless-in-the-IR)
 * children.
 */
export function findTerminalNode(
  completed: RunSummaryNode[],
  allNodes: RunSummaryNode[],
  edges: IREdge[] | undefined,
): RunSummaryNode | undefined {
  if (!edges || edges.length === 0) return undefined;
  const allIds = new Set(allNodes.map((n) => n.id));

  // 1. True sinks: completed nodes with no outgoing edge (any kind).
  const trueSinks = completed.filter(
    (n) => !edges.some((e) => e.from === n.id && allIds.has(e.to)),
  );
  if (trueSinks.length >= 1) {
    if (trueSinks.length === 1) return trueSinks[0];
    const withOutput = trueSinks.filter((n) => (n.finalText ?? "").length > 0);
    if (withOutput.length === 1) return withOutput[0];
  }

  // 2. Fallback: completed nodes with no outgoing dep edge to an incomplete node.
  const completedIds = new Set(completed.map((n) => n.id));
  const relevantDepEdges = edges.filter(
    (e) => e.kind === "dep" && allIds.has(e.from) && allIds.has(e.to),
  );
  const depTerminals = completed.filter((completedNode) => {
    const outgoingDepEdges = relevantDepEdges.filter((e) => e.from === completedNode.id);
    return !outgoingDepEdges.some((e) => !completedIds.has(e.to));
  });
  return depTerminals.length === 1 ? depTerminals[0] : undefined;
}

/** Extract the synthesized result text from a successful run. */
export function extractSynthesizedOutput(
  summary: {
    nodes: RunSummaryNode[];
    totals: { completed: number; nodes: number };
  },
  edges?: IREdge[],
): string {
  const completed = summary.nodes.filter((n) => n.status === "completed");
  if (completed.length === 0) {
    return `Workflow completed with no synthesized output (${summary.totals.completed}/${summary.totals.nodes} nodes succeeded).`;
  }

  // Prefer the DAG terminal node (unique graph sink) over the arbitrary
  // last-in-iteration-order node.
  const terminal = findTerminalNode(completed, summary.nodes, edges);
  const targetNode = terminal ?? completed[completed.length - 1];

  if (targetNode?.finalText) {
    return targetNode.finalText;
  }
  return `Workflow completed: ${summary.totals.completed} of ${summary.totals.nodes} nodes succeeded.`;
}

/** Build a tool result from a successful run workflow result. */
export function buildSuccessResult(success: RunSuccess, edges?: IREdge[]): ToolResult {
  return {
    content: [{ type: "text", text: extractSynthesizedOutput(success.summary, edges) }],
    details: {
      runId: success.summary.runId,
      runPath: success.runDir,
      nodes: success.summary.nodes,
      totals: success.summary.totals,
      failed: success.summary.nodes.filter((n) => n.status === "failed"),
    },
  };
}

/** Build a tool result from a failed run workflow result that has a summary. */
export function buildFailureWithSummary(failure: RunFailure): ToolResult {
  const errorDetails = wispErrorToDetails(failure.error);
  // When multiple nodes failed, append a brief multi-failure list so the
  // caller sees all failures at a glance.
  const failedNodes = failure.summary?.nodes.filter((n) => n.status === "failed") ?? [];
  let text = failure.error.message;
  if (failedNodes.length > 1) {
    const failureList = failedNodes
      .map((n) => `  \u2717 ${n.id}: ${n.error ?? "unknown error"}`)
      .join("\n");
    text += `\n${failureList}`;
  }
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    details: {
      ...errorDetails,
      runPath: failure.runDir,
      runId: failure.summary?.runId,
      ...(failure.summary
        ? {
            nodes: failure.summary.nodes,
            totals: failure.summary.totals,
            failed: failure.summary.nodes.filter((n) => n.status === "failed"),
          }
        : {}),
    },
  };
}

/** Build a tool result from a run workflow failure (compile/validation/runtime). */
export function buildFailureResult(failure: RunFailure): ToolResult {
  if (failure.summary) {
    return buildFailureWithSummary(failure);
  }
  return {
    content: [{ type: "text", text: failure.error.message }],
    details: wispErrorToDetails(failure.error),
  };
}

// ─── Validation classification ───────────────────────────────────

/**
 * Keywords in compile/runtime error messages that indicate a VALIDATION
 * (graph-structure) error rather than a true compilation or runtime failure.
 * When the compile step returns one of these, the tool reclassifies the result
 * as a validation error with the appropriate sub-errors array.
 */
export const VALIDATION_PATTERNS = [
  /duplicate node id/i,
  /a node with this id already exists/i,
  /dependsOn/i,
  /not found/i,
  /outputSchema/i,
];

/**
 * Whether a WispError's message indicates a validation (graph-structure)
 * error. Compile errors are never reclassified — a genuine compile failure
 * (e.g. "Workflow script not found") must stay "compile" even when its message
 * coincidentally matches a pattern.
 */
export function isValidationError(err: WispError): boolean {
  if (err.kind === "compile") return false;
  return VALIDATION_PATTERNS.some((re) => re.test(err.message));
}
