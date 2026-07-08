// ═══════════════════════════════════════════════════════════════════════════
// RED tests — run-workflow-helpers extracted module (refactor: split run-workflow.ts).
//
// These tests import the error/result helper functions from the NEW module
// `src/tools/run-workflow-helpers.js`. That module does not exist yet, so the
// imports FAIL until the green team extracts the helpers. Each test then pins
// the EXACT observable behavior of the extracted function so the refactor is
// provably behavior-preserving.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

import type { IREdge, WispError } from "../../types.js";
import type { RunSuccess, RunFailure } from "../../engine/run.js";
import type { RunSummaryNode, RunSummary } from "../../engine/events.js";

import {
  wispErrorToDetails,
  paramValidationError,
  augmentEdgesWithFanOutChildren,
  findTerminalNode,
  extractSynthesizedOutput,
  buildSuccessResult,
  buildFailureWithSummary,
  buildFailureResult,
  VALIDATION_PATTERNS,
  isValidationError,
} from "../../tools/run-workflow-helpers.js";
// Importing the type asserts it is exported from the new module.
import type { ErrorDetails } from "../../tools/run-workflow-helpers.js";

// ─── Builders ──────────────────────────────────────────────────────

/** Build a RunSummaryNode with sensible defaults. */
function node(id: string, over: Partial<RunSummaryNode> = {}): RunSummaryNode {
  return { id, status: "completed", toolCount: 0, retries: 0, ...over };
}

function edge(from: string, to: string, kind: IREdge["kind"] = "dep"): IREdge {
  return { from, to, kind };
}

// ─── wispErrorToDetails ───────────────────────────────────────────

describe("wispErrorToDetails", () => {
  it("copies kind + message for a compile error", () => {
    const err: WispError = { kind: "compile", message: "syntax error near token" };
    const d = wispErrorToDetails(err);
    expect(d.kind).toBe("compile");
    expect(d.message).toBe("syntax error near token");
    expect(d.nodeId).toBeUndefined();
    expect(d.errors).toBeUndefined();
    expect(d.line).toBeUndefined();
  });

  it("copies nodeId when present", () => {
    const err: WispError = { kind: "runtime", message: "boom", nodeId: "fix-0" };
    expect(wispErrorToDetails(err).nodeId).toBe("fix-0");
  });

  it("copies errors array from a validation error", () => {
    const sub = { kind: "compile", message: "sub" } as WispError;
    const err: WispError = { kind: "validation", message: "many", errors: [sub] };
    const d = wispErrorToDetails(err);
    expect(d.errors).toEqual([sub]);
  });

  it("does not set errors when absent", () => {
    const err: WispError = { kind: "validation", message: "x" };
    expect(wispErrorToDetails(err).errors).toBeUndefined();
  });

  it("parses a line number from a file:line:col location", () => {
    const err: WispError = {
      kind: "compile",
      message: "x",
      location: "workflow.ts:42:5",
    };
    expect(wispErrorToDetails(err).line).toBe(42);
  });

  it("does not set line when location has no colon", () => {
    const err: WispError = { kind: "compile", message: "x", location: "nocolon" };
    expect(wispErrorToDetails(err).line).toBeUndefined();
  });

  it("does not set line when the line segment is non-numeric", () => {
    const err: WispError = { kind: "compile", message: "x", location: "a:b:c" };
    expect(wispErrorToDetails(err).line).toBeUndefined();
  });

  it("returns an object assignable to ErrorDetails", () => {
    const d: ErrorDetails = wispErrorToDetails({ kind: "runtime", message: "x" });
    expect(d.kind).toBe("runtime");
  });
});

// ─── paramValidationError ─────────────────────────────────────────

describe("paramValidationError", () => {
  it("wraps the message in a validation error result", () => {
    const r = paramValidationError("bad input");
    expect(r.details).toEqual({ kind: "validation", message: "bad input" });
    expect(r.content).toHaveLength(1);
    expect(r.content[0]!.type).toBe("text");
    expect(r.content[0]!.text).toBe("Validation error: bad input");
  });
});

// ─── findTerminalNode ─────────────────────────────────────────────

describe("findTerminalNode", () => {
  it("returns undefined when edges is undefined", () => {
    expect(findTerminalNode([node("a")], [node("a")], undefined)).toBeUndefined();
  });

  it("returns undefined when edges is empty", () => {
    expect(findTerminalNode([node("a")], [node("a")], [])).toBeUndefined();
  });

  it("returns the unique graph-sink among completed nodes", () => {
    // a -> b (completed), a -> c (pending). Only b has no outgoing dep edge to
    // an incomplete node, so b is the unique terminal.
    const a = node("a");
    const b = node("b");
    const c = node("c", { status: "pending" });
    const edges = [edge("a", "b"), edge("a", "c")];
    expect(findTerminalNode([a, b], [a, b, c], edges)).toBe(b);
  });

  it("returns the true graph-sink of a completed chain", () => {
    // a -> b, both completed. b is the unique node with no outgoing edge
    // (a true sink), so it is the terminal — not ambiguous.
    const a = node("a");
    const b = node("b");
    const edges = [edge("a", "b")];
    expect(findTerminalNode([a, b], [a, b], edges)).toBe(b);
  });

  it("ignores non-dep edges when finding a true sink (falls back to dep)", () => {
    // a has a fanOut edge to an incomplete node c, but fanOut is not a dep
    // edge, so a has no outgoing dep edge to an incomplete node and is the
    // fallback terminal.
    const a = node("a");
    const c = node("c", { status: "pending" });
    const edges = [edge("a", "c", "fanOut")];
    expect(findTerminalNode([a], [a, c], edges)).toBe(a);
  });

  it("prefers a true sink with output over an empty placeholder sink", () => {
    // Two completed nodes with no outgoing edges: an empty placeholder
    // (e.g. a `parallel` grouping node) and a real result node. A producer
    // feeds both (so edges are non-empty) but neither has outgoing edges. The
    // sink with output wins.
    const producer = node("gen", { finalText: "{}" });
    const placeholder = node("grp"); // no finalText
    const result = node("synth", { finalText: "PRIMER" });
    const all = [producer, placeholder, result];
    const edges = [edge("gen", "grp", "dep"), edge("gen", "synth", "dep")];
    expect(findTerminalNode(all, all, edges)).toBe(result);
  });

  it("identifies a reduce over a fan-out as the sink (children wired to it)", () => {
    // gen -> answer(fanOut) -> synth(reduce). The dynamic children answer-0..2
    // are wired to synth (as augmentEdgesWithFanOutChildren does), so synth is
    // the unique true sink and the children are not.
    const gen = node("gen", { finalText: "{}" });
    const fan = node("answer", { finalText: "" });
    const c0 = node("answer-0", { finalText: "A0" });
    const c1 = node("answer-1", { finalText: "A1" });
    const c2 = node("answer-2", { finalText: "A2" });
    const synth = node("synth", { finalText: '{"primer":"..."}' });
    const all = [gen, fan, c0, c1, c2, synth];
    const edges = [
      edge("gen", "answer", "fanOut"),
      edge("answer", "synth", "dep"),
      // children wired to synth (reconstructed at runtime):
      edge("answer-0", "synth", "dep"),
      edge("answer-1", "synth", "dep"),
      edge("answer-2", "synth", "dep"),
    ];
    expect(findTerminalNode(all, all, edges)).toBe(synth);
  });
});

// ─── augmentEdgesWithFanOutChildren ─────────────────────────────

describe("augmentEdgesWithFanOutChildren", () => {
  it("adds a dep edge from each expanded child to the fan-out's consumers", () => {
    const irNodes = [
      { id: "gen", kind: "node" },
      { id: "answer", kind: "fanOut" },
      { id: "synth", kind: "reduce" },
    ];
    const edges = [edge("gen", "answer", "fanOut"), edge("answer", "synth", "dep")];
    const summaryIds = new Set(["gen", "answer", "synth", "answer-0", "answer-1", "answer-2"]);
    const out = augmentEdgesWithFanOutChildren(edges, irNodes, summaryIds);
    expect(out).toContainEqual(edge("answer-0", "synth", "dep"));
    expect(out).toContainEqual(edge("answer-2", "synth", "dep"));
    // Original edges preserved.
    expect(out).toHaveLength(5);
  });

  it("returns the edges unchanged when there are no fan-out nodes", () => {
    const irNodes = [
      { id: "a", kind: "node" },
      { id: "b", kind: "node" },
    ];
    const edges = [edge("a", "b", "dep")];
    const out = augmentEdgesWithFanOutChildren(edges, irNodes, new Set(["a", "b"]));
    expect(out).toEqual(edges);
  });

  it("only wires children actually present in the summary", () => {
    const irNodes = [
      { id: "answer", kind: "fanOut" },
      { id: "r", kind: "reduce" },
    ];
    const edges = [edge("answer", "r", "dep")];
    // Only answer-0 expanded (answer-1 absent).
    const out = augmentEdgesWithFanOutChildren(
      edges,
      irNodes,
      new Set(["answer", "r", "answer-0"]),
    );
    expect(out).toContainEqual(edge("answer-0", "r", "dep"));
    expect(out.some((e) => e.from === "answer-1")).toBe(false);
  });
});

// ─── extractSynthesizedOutput ─────────────────────────────────────

describe("extractSynthesizedOutput", () => {
  it("returns a 'no synthesized output' message when no node completed", () => {
    const summary = {
      nodes: [node("a", { status: "failed" })],
      totals: { completed: 0, nodes: 1 },
    };
    expect(extractSynthesizedOutput(summary)).toBe(
      "Workflow completed with no synthesized output (0/1 nodes succeeded).",
    );
  });

  it("returns the completed node's finalText (last completed, no edges)", () => {
    const summary = {
      nodes: [node("a", { finalText: "RESULT" })],
      totals: { completed: 1, nodes: 1 },
    };
    expect(extractSynthesizedOutput(summary)).toBe("RESULT");
  });

  it("prefers the DAG terminal node's finalText when a unique terminal exists", () => {
    const a = node("a", { finalText: "A-OUT" });
    const b = node("b", { finalText: "B-OUT" });
    const c = node("c", { status: "pending" });
    const summary = {
      nodes: [a, b, c],
      totals: { completed: 2, nodes: 3 },
    };
    const edges = [edge("a", "b"), edge("a", "c")];
    // b is the unique terminal → "B-OUT", NOT the last-in-order completed node.
    expect(extractSynthesizedOutput(summary, edges)).toBe("B-OUT");
  });

  it("falls back to a summary message when the target node has no finalText", () => {
    const summary = {
      nodes: [node("a")], // completed but no finalText
      totals: { completed: 1, nodes: 1 },
    };
    expect(extractSynthesizedOutput(summary)).toBe("Workflow completed: 1 of 1 nodes succeeded.");
  });
});

// ─── buildSuccessResult ───────────────────────────────────────────

describe("buildSuccessResult", () => {
  it("builds a content+details result from a RunSuccess", () => {
    const summary: RunSummary = {
      runId: "run-1",
      nodes: [node("a", { finalText: "done" })],
      totals: {
        nodes: 1,
        completed: 1,
        failed: 0,
        skipped: 0,
        totalCostUsd: 0,
        totalDurationMs: 5,
      },
    };
    const success: RunSuccess = { ok: true, runDir: "/tmp/run-1", summary };

    const r = buildSuccessResult(success);
    expect(r.content[0]!.text).toBe("done");
    const details = r.details as Record<string, unknown>;
    expect(details.runId).toBe("run-1");
    expect(details.runPath).toBe("/tmp/run-1");
    expect(details.nodes).toEqual(summary.nodes);
    expect(details.totals).toEqual(summary.totals);
    expect(details.failed).toEqual([]); // no failed nodes
    expect(details.kind).toBeUndefined(); // success has no error kind
  });
});

// ─── buildFailureWithSummary ──────────────────────────────────────

describe("buildFailureWithSummary", () => {
  function failSummary(nodeList: RunSummaryNode[]): RunSummary {
    return {
      runId: "run-1",
      nodes: nodeList,
      totals: {
        nodes: nodeList.length,
        completed: 0,
        failed: nodeList.filter((n) => n.status === "failed").length,
        skipped: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
      },
    };
  }

  it("uses the error message verbatim when only one node failed", () => {
    const failure: RunFailure = {
      ok: false,
      error: { kind: "runtime", message: "Workflow completed with 1 failed node." },
      runDir: "/tmp/run-1",
      summary: failSummary([node("a", { status: "failed", error: "boom" })]),
    };
    const r = buildFailureWithSummary(failure);
    expect(r.content[0]!.text).toBe("Workflow completed with 1 failed node.");
    const details = r.details as Record<string, unknown>;
    expect(details.kind).toBe("runtime");
    expect(details.runPath).toBe("/tmp/run-1");
    expect(details.runId).toBe("run-1");
    expect(Array.isArray(details.nodes)).toBe(true);
    expect(Array.isArray(details.failed)).toBe(true);
    expect((details.failed as unknown[]).length).toBe(1);
  });

  it("appends a multi-failure list when more than one node failed", () => {
    const failure: RunFailure = {
      ok: false,
      error: { kind: "runtime", message: "base message" },
      runDir: "/tmp/run-1",
      summary: failSummary([
        node("a", { status: "failed", error: "boom" }),
        node("b", { status: "failed", error: "kaboom" }),
      ]),
    };
    const text = buildFailureWithSummary(failure).content[0]!.text;
    expect(text.startsWith("base message")).toBe(true);
    expect(text).toContain("\u2717 a: boom");
    expect(text).toContain("\u2717 b: kaboom");
  });

  it("uses 'unknown error' for a failed node missing an error string", () => {
    const failure: RunFailure = {
      ok: false,
      error: { kind: "runtime", message: "base message" },
      runDir: "/tmp/run-1",
      summary: failSummary([
        node("a", { status: "failed" }), // no error field
        node("b", { status: "failed", error: "kaboom" }),
      ]),
    };
    const text = buildFailureWithSummary(failure).content[0]!.text;
    expect(text).toContain("\u2717 a: unknown error");
  });
});

// ─── buildFailureResult ───────────────────────────────────────────

describe("buildFailureResult", () => {
  it("delegates to the summary path when a summary is present", () => {
    const failure: RunFailure = {
      ok: false,
      error: { kind: "runtime", message: "runtime boom" },
      runDir: "/tmp/run-1",
      summary: {
        runId: "run-1",
        nodes: [node("a", { status: "failed", error: "boom" })],
        totals: {
          nodes: 1,
          completed: 0,
          failed: 1,
          skipped: 0,
          totalCostUsd: 0,
          totalDurationMs: 0,
        },
      },
    };
    const r = buildFailureResult(failure);
    const details = r.details as Record<string, unknown>;
    expect(details.runPath).toBe("/tmp/run-1"); // only the summary path sets runPath
    expect(details.nodes).toBeDefined();
  });

  it("returns a plain message+details result when no summary exists", () => {
    const failure: RunFailure = {
      ok: false,
      error: { kind: "compile", message: "syntax error" },
    };
    const r = buildFailureResult(failure);
    expect(r.content[0]!.text).toBe("syntax error");
    const details = r.details as Record<string, unknown>;
    expect(details).toEqual({ kind: "compile", message: "syntax error" });
    expect(details.nodes).toBeUndefined();
    expect(details.runPath).toBeUndefined();
  });
});

// ─── VALIDATION_PATTERNS ──────────────────────────────────────────

describe("VALIDATION_PATTERNS", () => {
  it("is a non-empty array of RegExp", () => {
    expect(Array.isArray(VALIDATION_PATTERNS)).toBe(true);
    expect(VALIDATION_PATTERNS.length).toBeGreaterThan(0);
    for (const p of VALIDATION_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });

  it("contains patterns matching duplicate-node and not-found messages", () => {
    const joined = VALIDATION_PATTERNS.map((r) => r.source).join("|");
    expect(joined).toMatch(/duplicate node id/i);
    expect(joined).toMatch(/not found/i);
  });
});

// ─── isValidationError ────────────────────────────────────────────

describe("isValidationError", () => {
  it("returns false for a compile error even when its message matches a pattern", () => {
    const err: WispError = { kind: "compile", message: "Workflow script not found" };
    expect(isValidationError(err)).toBe(false);
  });

  it("returns true for a runtime error matching a validation pattern", () => {
    const err: WispError = { kind: "runtime", message: "duplicate node id 'x'" };
    expect(isValidationError(err)).toBe(true);
  });

  it("returns true for a runtime error whose message contains 'not found'", () => {
    const err: WispError = { kind: "runtime", message: "node 'x' not found" };
    expect(isValidationError(err)).toBe(true);
  });

  it("returns false for a runtime error that matches no pattern", () => {
    const err: WispError = { kind: "runtime", message: "something totally unrelated" };
    expect(isValidationError(err)).toBe(false);
  });
});
