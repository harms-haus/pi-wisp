// ═══════════════════════════════════════════════════════════════════════════
// cycle-detection module — detectCycles() + adjacency / cycle reconstruction.
//
// This module is extracted out of ir.ts (Step 1 of the refactor). These tests
// pin the cycle-detection behavior that validateIR depends on, exercised
// directly against the new module path (../../dsl/cycle-detection.js). Until
// that module exists the tests are RED — encoding the target split.
//
// Behavior is ported verbatim from pi-workflows' iterative 3-color DFS, so the
// assertions describe exact reconstructed cycle paths.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

import { detectCycles, buildAdjacency, reconstructCycle } from "../../dsl/cycle-detection.js";
import type { IRNode, IREdge } from "../../types.js";

// ─── Fixtures ─────────────────────────────────────────────────────

function node(id: string): IRNode {
  return { id, kind: "node", prompt: id };
}

function edge(from: string, to: string): IREdge {
  return { from, to, kind: "dep" };
}

// ─── detectCycles — acyclic graphs ────────────────────────────────

describe("detectCycles — acyclic graphs return no cycles", () => {
  it("returns [] for an empty graph (no nodes, no edges)", () => {
    expect(detectCycles([], [])).toEqual([]);
  });

  it("returns [] for a single isolated node", () => {
    expect(detectCycles([node("a")], [])).toEqual([]);
  });

  it("returns [] for a linear DAG (a → b → c)", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("a", "b"), edge("b", "c")];
    expect(detectCycles(nodes, edges)).toEqual([]);
  });

  it("returns [] for a diamond DAG (a → {b, c} → d)", () => {
    const nodes = [node("a"), node("b"), node("c"), node("d")];
    const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")];
    expect(detectCycles(nodes, edges)).toEqual([]);
  });
});

// ─── detectCycles — cyclic graphs ─────────────────────────────────

describe("detectCycles — cyclic graphs", () => {
  it("detects a self-loop (a → a) and reports a single-node cycle", () => {
    const cycles = detectCycles([node("a")], [edge("a", "a")]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.cycleKeys).toEqual(["a"]);
    expect(cycles[0]!.message).toMatch(/cycle/i);
    expect(cycles[0]!.message).toContain("a → a");
  });

  it("detects a 2-node cycle (a → b → a) and reconstructs the path", () => {
    const cycles = detectCycles([node("a"), node("b")], [edge("a", "b"), edge("b", "a")]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.cycleKeys).toEqual(["a", "b"]);
    expect(cycles[0]!.message).toContain("a → b → a");
  });

  it("detects a 3-node cycle (a → b → c → a)", () => {
    const cycles = detectCycles(
      [node("a"), node("b"), node("c")],
      [edge("a", "b"), edge("b", "c"), edge("c", "a")],
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.cycleKeys).toEqual(["a", "b", "c"]);
    expect(cycles[0]!.message).toContain("a → b → c → a");
  });

  it("detects multiple independent cycles in one graph", () => {
    const cycles = detectCycles(
      [node("a"), node("b"), node("c"), node("d")],
      [
        edge("a", "b"),
        edge("b", "a"), // cycle 1: a ↔ b
        edge("c", "d"),
        edge("d", "c"), // cycle 2: c ↔ d
      ],
    );
    expect(cycles).toHaveLength(2);
    const keySets = cycles.map((c) => [...c.cycleKeys].sort().join(","));
    expect(keySets).toContain("a,b");
    expect(keySets).toContain("c,d");
  });

  it("ignores edges whose 'from' node is absent from the node set (no crash, no cycle)", () => {
    expect(detectCycles([node("a")], [edge("ghost", "a")])).toEqual([]);
  });

  it("every returned cycle has a non-empty message and cycleKeys array", () => {
    const cycles = detectCycles([node("a"), node("b")], [edge("a", "b"), edge("b", "a")]);
    for (const c of cycles) {
      expect(typeof c.message).toBe("string");
      expect(c.message.length).toBeGreaterThan(0);
      expect(Array.isArray(c.cycleKeys)).toBe(true);
      expect(c.cycleKeys.length).toBeGreaterThan(0);
    }
  });
});

// ─── buildAdjacency ───────────────────────────────────────────────

describe("buildAdjacency — adjacency list construction", () => {
  it("returns an empty map when there are no nodes", () => {
    expect(buildAdjacency([], []).size).toBe(0);
  });

  it("initializes every node id with an empty neighbor list", () => {
    const adj = buildAdjacency([node("a"), node("b")], []);
    expect(adj.get("a")).toEqual([]);
    expect(adj.get("b")).toEqual([]);
    expect(adj.size).toBe(2);
  });

  it("groups edges by 'from' into ordered neighbor lists", () => {
    const adj = buildAdjacency(
      [node("a"), node("b"), node("c")],
      [edge("a", "b"), edge("a", "c"), edge("b", "c")],
    );
    expect(adj.get("a")).toEqual(["b", "c"]);
    expect(adj.get("b")).toEqual(["c"]);
    expect(adj.get("c")).toEqual([]);
  });

  it("drops edges whose 'from' is not a known node id", () => {
    const adj = buildAdjacency([node("a")], [edge("ghost", "a")]);
    expect(adj.has("ghost")).toBe(false);
    expect(adj.get("a")).toEqual([]);
  });
});

// ─── reconstructCycle ─────────────────────────────────────────────

describe("reconstructCycle — back-edge path reconstruction", () => {
  it("walks parent links from startKey back to the neighbor", () => {
    // parent chain: b → a (b's parent is a)
    const parent = new Map<string, string>([["b", "a"]]);
    expect(reconstructCycle("b", "a", parent)).toEqual(["a", "b"]);
  });

  it("walks a longer chain (c → b → a)", () => {
    const parent = new Map<string, string>([
      ["c", "b"],
      ["b", "a"],
    ]);
    expect(reconstructCycle("c", "a", parent)).toEqual(["a", "b", "c"]);
  });

  it("returns a single-element path when startKey === neighbor (self-loop)", () => {
    expect(reconstructCycle("a", "a", new Map<string, string>())).toEqual(["a"]);
  });

  it("stops gracefully when a parent link is missing", () => {
    // parent has no entry for "b"; traversal should terminate without throwing.
    const parent = new Map<string, string>([["c", "b"]]);
    const path = reconstructCycle("c", "a", parent);
    expect(path).toContain("c");
    expect(path).toContain("b");
  });
});
