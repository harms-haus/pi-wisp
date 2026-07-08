// ═══════════════════════════════════════════════════════════════════════════
// Cycle detection for the dependency graph.
//
// Iterative 3-color DFS (WHITE=unvisited, GRAY=on-stack, BLACK=done) over the
// adjacency list derived from IR edges (`from → to`). Adjacency is built only
// from nodes that exist, so phantom edges never produce spurious cycles.
// Ported from `pi-workflows/src/config/validation.ts`.
// ═══════════════════════════════════════════════════════════════════════════

import type { IREdge, IRNode } from "../types.js";

/** A detected cycle: a human-readable message plus the ordered node ids. */
export interface Cycle {
  message: string;
  cycleKeys: string[];
}

/** Reconstruct the cycle path from a back edge. */
export function reconstructCycle(
  startKey: string,
  neighbor: string,
  parent: Map<string, string>,
): string[] {
  const cycleKeys: string[] = [startKey];
  let cur: string = startKey;
  while (cur !== neighbor) {
    const p = parent.get(cur);
    if (p === undefined) break;
    cur = p;
    cycleKeys.push(cur);
  }
  cycleKeys.reverse();
  return cycleKeys;
}

/** Build an adjacency list (from → [to...]) from IR nodes + edges. */
export function buildAdjacency(nodes: IRNode[], edges: IREdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const edge of edges) {
    adj.get(edge.from)?.push(edge.to);
  }
  return adj;
}

/** 3-color DFS constants. */
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

interface DfsFrame {
  key: string;
  neighborIdx: number;
  phase: "enter" | "exit";
}

/**
 * Process a single neighbor during DFS traversal. Returns a {@link Cycle} when
 * a back-edge (GRAY neighbor) is detected, otherwise returns `undefined`.
 */
function processNeighbor(
  neighbor: string | undefined,
  color: Map<string, number>,
  parent: Map<string, string>,
  topKey: string,
  stack: DfsFrame[],
): Cycle | undefined {
  if (neighbor === undefined) return undefined;
  const neighborColor = color.get(neighbor) ?? WHITE;
  if (neighborColor === GRAY) {
    parent.set(neighbor, topKey);
    const cycleKeys = reconstructCycle(topKey, neighbor, parent);
    return {
      message: `Cycle detected: ${cycleKeys.join(" → ")} → ${cycleKeys[0] ?? neighbor}`,
      cycleKeys,
    };
  }
  if (neighborColor === WHITE) {
    parent.set(neighbor, topKey);
    stack.push({ key: neighbor, neighborIdx: 0, phase: "enter" });
  }
  return undefined;
}

/**
 * Detect cycles in the dependency graph using iterative DFS with 3-color
 * marking. Returns every cycle found, each with its reconstructed node path.
 */
export function detectCycles(nodes: IRNode[], edges: IREdge[]): Cycle[] {
  const errors: Cycle[] = [];
  const ids = nodes.map((n) => n.id);
  const adj = buildAdjacency(nodes, edges);
  const color = new Map<string, number>();
  for (const id of ids) color.set(id, WHITE);

  for (const startKey of ids) {
    if (color.get(startKey) !== WHITE) continue;

    const parent = new Map<string, string>();
    const stack: DfsFrame[] = [{ key: startKey, neighborIdx: 0, phase: "enter" }];

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;

      if (top.phase === "enter") {
        color.set(top.key, GRAY);
        top.phase = "exit";
        top.neighborIdx = 0;
        continue;
      }

      const neighbors = adj.get(top.key) ?? [];
      if (top.neighborIdx < neighbors.length) {
        const neighbor = neighbors[top.neighborIdx];
        top.neighborIdx++;
        const cycle = processNeighbor(neighbor, color, parent, top.key, stack);
        if (cycle) errors.push(cycle);
        continue;
      }

      color.set(top.key, BLACK);
      stack.pop();
    }
  }

  return errors;
}
