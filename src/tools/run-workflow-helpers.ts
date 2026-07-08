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
 * Find the DAG terminal (graph-sink) node among completed nodes.
 *
 * A terminal node is a completed node with no outgoing `dep` edge to an
 * incomplete node — i.e. every node that depends on it is also completed.
 * Returns `undefined` when the terminal cannot be unambiguously identified
 * (no edges available, zero or multiple candidates).
 */
export function findTerminalNode(
  completed: RunSummaryNode[],
  allNodes: RunSummaryNode[],
  edges: IREdge[] | undefined,
): RunSummaryNode | undefined {
  if (!edges || edges.length === 0) return undefined;

  const completedIds = new Set(completed.map((n) => n.id));
  const allIds = new Set(allNodes.map((n) => n.id));

  // Filter dep edges that are within our graph.
  const relevantDepEdges = edges.filter(
    (e) => e.kind === "dep" && allIds.has(e.from) && allIds.has(e.to),
  );

  // Find completed nodes that have NO outgoing dep edge to an incomplete node.
  const terminals = completed.filter((completedNode) => {
    const outgoingDepEdges = relevantDepEdges.filter((e) => e.from === completedNode.id);
    return !outgoingDepEdges.some((e) => !completedIds.has(e.to));
  });

  return terminals.length === 1 ? terminals[0] : undefined;
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
