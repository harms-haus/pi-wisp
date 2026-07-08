// ═══════════════════════════════════════════════════════════════════════════
// In-memory builder IR + serialized GraphIR + validation + stage derivation.
//
// This module defines the mutable builder IR used during DSL construction
// (S11), the serializable GraphIR produced by `toIR()` (S15), IR validation
// (S13), and stage-label derivation from primitive metadata (S14).
// ═══════════════════════════════════════════════════════════════════════════

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, dirname } from "node:path";
import { homedir } from "node:os";

import { Type } from "typebox";
import { Value } from "typebox/value";

import type {
  FnDescriptor,
  FnKind,
  GraphIR,
  IRCondition,
  IREdge,
  IRNode,
  IRNodeBase,
  NodeSpec,
  PrimitiveMeta,
  WispError,
} from "../types.js";

// ─── Builder IR (mutable in-memory shape during DSL construction) ──

/**
 * A live (un-serialized) function reference held by the builder IR during DSL
 * construction. At `toIR()` time each {@link LiveFn} is converted to a
 * transportable {@link FnDescriptor} via `serializeFn` (S17). Holding the live
 * reference (rather than calling `Function.toString` eagerly) keeps the builder
 * a pure structural accumulator and centralises serialization in one place.
 */
export interface LiveFn {
  fn: (...args: never[]) => unknown;
  kind: FnKind;
}

/** Wrap a live function + its semantic kind into a {@link LiveFn}. */
export function live(fn: (...args: never[]) => unknown, kind: LiveFn["kind"]): LiveFn {
  return { fn, kind };
}

/** Discriminator for builder-internal nodes (mirrors {@link IRNode}). */
export type BuilderNodeKind = IRNode["kind"];

/**
 * The builder-internal node shape. Identical in structure to {@link IRNode}
 * except that function references are held *live* (as {@link LiveFn}) rather
 * than pre-serialized. `toIR()` maps each `BuilderNode` to an {@link IRNode}.
 */
export type BuilderNode = IRNodeBase &
  (
    | {
        kind: "node";
        agentType?: string;
        profileRef?: string;
        prompt?: string;
        promptFn?: LiveFn;
      }
    | {
        kind: "fanOut";
        from: string;
        iterate: LiveFn;
        each: LiveFn;
      }
    | {
        kind: "cond";
        on: string;
        when: LiveFn;
        then: string | NodeSpec;
        else?: string | NodeSpec;
      }
    | {
        kind: "loop";
        body: string;
        until: LiveFn;
        maxIterations?: number;
      }
    | {
        kind: "reduce";
        from: string[];
        merge?: LiveFn;
        profileRef?: string;
        agentType?: string;
      }
    | { kind: "parallel" }
    | { kind: "sequence"; steps: string[] }
  );

/**
 * The builder-internal analogue of {@link IRCondition}: holds the predicate as
 * a live {@link LiveFn} until serialization.
 */
export interface BuilderCondition {
  id: string;
  on: string;
  fn: LiveFn;
}

/**
 * The mutable builder IR that accumulates nodes, edges, conditions, inline
 * profiles, and workflow options as the DSL is constructed via the fluent API.
 * Converted to an immutable {@link GraphIR} by `toIR()`.
 */
export interface BuilderIR {
  title: string;
  slug: string;
  options: { maxConcurrency?: number; defaultRetries?: number; title?: string };
  nodes: BuilderNode[];
  edges: IREdge[];
  conditions: BuilderCondition[];
  /** Inline profiles registered via `.profile(name, {...})`. */
  inlineProfiles: Map<string, Record<string, unknown>>;
}

// ─── IR validation ────────────────────────────────────────────────

/**
 * Permissive TypeBox meta-schema for `outputSchema`: it must be a plain JSON
 * object (arrays, primitives, and `null` are rejected). Deeper JSON-Schema
 * structural validation can be layered in later; v1 only rejects non-object
 * schemas so a numeric/string `outputSchema` is caught early.
 */
const OUTPUT_SCHEMA_META = Type.Object({}, { additionalProperties: true });

/**
 * Default project root used by the path-traversal guard: the directory that
 * contains all user homes (`dirname(homedir())`, e.g. `/home`). A node `cwd`
 * must resolve to a path *within* this root. This is a guardrail against
 * obvious escapes into system directories (e.g. `/etc`); it is not a security
 * boundary (the orchestrating agent authored the DSL).
 */
function projectRoot(): string {
  try {
    return realpathSync(resolve(dirname(homedir())));
  } catch {
    return resolve(dirname(homedir()));
  }
}

/** Return true when `cwd` resolves to a path inside the project root. */
function isCwdWithinRoot(cwd: string): boolean {
  const root = projectRoot();
  const resolvedTarget = resolve(cwd);
  let canonical: string;
  try {
    canonical = realpathSync(resolvedTarget);
  } catch {
    // Path does not exist yet (will be created at run time): fall back to the
    // resolved path, mirroring pi-workflows' `checkPathSafety` fallback.
    canonical = resolvedTarget;
  }
  const rel = relative(root, canonical);
  // Safe iff strictly nested under the root (not the root itself, not escaping
  // via "..", and not an unrelated absolute path on another drive).
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

interface Cycle {
  message: string;
  cycleKeys: string[];
}

/** Reconstruct the cycle path from a back edge (ported from pi-workflows). */
function reconstructCycle(
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
function buildAdjacency(nodes: IRNode[], edges: IREdge[]): Map<string, string[]> {
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
 * marking (WHITE=unvisited, GRAY=on-stack, BLACK=done). Adjacency is derived
 * from the IR edges (`from → to`). Ported from
 * `pi-workflows/src/config/validation.ts`.
 */
function detectCycles(nodes: IRNode[], edges: IREdge[]): Cycle[] {
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

// ─── Individual validation checks (each returns a standalone error list) ──

/** (2) Unique node ids. */
function checkUniqueIds(idCounts: Map<string, number>): WispError[] {
  const errors: WispError[] = [];
  for (const [id, count] of idCounts) {
    if (count > 1) {
      errors.push({
        kind: "validation",
        nodeId: id,
        message: `Duplicate node id "${id}" (${count} occurrences); node ids must be unique.`,
      });
    }
  }
  return errors;
}

/** (3) Per-node reference checks: dependsOn, fanOut from, cond on. */
function checkNodeReferences(ir: GraphIR, nodeIds: Set<string>): WispError[] {
  const errors: WispError[] = [];
  for (const node of ir.nodes) {
    if (node.dependsOn) {
      for (const dep of node.dependsOn) {
        if (!nodeIds.has(dep)) {
          errors.push({
            kind: "validation",
            nodeId: node.id,
            message: `Node "${node.id}" dependsOn "${dep}" which was not found in the graph.`,
          });
        }
      }
    }
    if (node.kind === "fanOut" && !nodeIds.has(node.from)) {
      errors.push({
        kind: "validation",
        nodeId: node.id,
        message: `Node "${node.id}" fanOut 'from' "${node.from}" was not found in the graph.`,
      });
    }
    if (node.kind === "cond" && !nodeIds.has(node.on)) {
      errors.push({
        kind: "validation",
        nodeId: node.id,
        message: `Node "${node.id}" cond 'on' "${node.on}" was not found in the graph.`,
      });
    }
  }
  return errors;
}

/** (4)+(6)+(7) Per-node property checks: outputSchema, mutual exclusivity, path traversal. */
function checkNodeProperties(ir: GraphIR): WispError[] {
  const errors: WispError[] = [];
  for (const node of ir.nodes) {
    if (node.outputSchema !== undefined && !Value.Check(OUTPUT_SCHEMA_META, node.outputSchema)) {
      errors.push({
        kind: "validation",
        nodeId: node.id,
        message: `Node "${node.id}" has a malformed outputSchema: expected a JSON-Schema object (got ${typeof node.outputSchema}).`,
      });
    }
    if (node.kind === "node" && node.prompt !== undefined && node.promptFnRef !== undefined) {
      errors.push({
        kind: "validation",
        nodeId: node.id,
        message: `Node "${node.id}" has both 'prompt' and 'promptFnRef' set; they are mutually exclusive.`,
      });
    }
    if (node.cwd !== undefined && !isCwdWithinRoot(node.cwd)) {
      errors.push({
        kind: "validation",
        nodeId: node.id,
        message: `Node "${node.id}" cwd "${node.cwd}" escapes the project root (path traversal).`,
      });
    }
  }
  return errors;
}

/** (8) Edge reference consistency (every edge from/to resolves to a node). */
function checkEdges(ir: GraphIR, nodeIds: Set<string>): WispError[] {
  const errors: WispError[] = [];
  for (const edge of ir.edges) {
    if (!nodeIds.has(edge.from)) {
      errors.push({
        kind: "validation",
        message: `Edge ${edge.from} → ${edge.to}: 'from' node "${edge.from}" not found.`,
      });
    }
    if (!nodeIds.has(edge.to)) {
      errors.push({
        kind: "validation",
        nodeId: edge.to,
        message: `Edge ${edge.from} → ${edge.to}: 'to' node "${edge.to}" not found.`,
      });
    }
  }
  return errors;
}

/** (5) Concurrency-pool sanity (maxConcurrency >= 1 when set). */
function checkConcurrency(ir: GraphIR): WispError[] {
  const mc = ir.options.maxConcurrency;
  if (mc !== undefined && mc < 1) {
    return [
      {
        kind: "validation",
        message: `Invalid concurrency limit: maxConcurrency=${mc}; concurrency pool limits must be >= 1.`,
      },
    ];
  }
  return [];
}

/** (1) Cycle detection → structured errors. */
function checkCycles(ir: GraphIR): WispError[] {
  return detectCycles(ir.nodes, ir.edges).map((cycle) => ({
    kind: "validation" as const,
    nodeId: cycle.cycleKeys[0],
    message: cycle.message,
  }));
}

/**
 * Validate a compiled GraphIR and return a list of structured errors.
 * Empty array = valid. Each error is `{ kind: "validation", nodeId?, message,
 * location? }` (SCOUTING C5 — structured, agent-actionable errors).
 *
 * Checks: unique node ids (2); dependsOn/from/on references (3); outputSchema
 * well-formedness (4); concurrency sanity (5); mutual exclusivity (6); path
 * traversal (7); edge consistency (8); cycle detection (1).
 *
 * Node-level checks are emitted before edge-consistency errors so that tests
 * using `.find()` on a message regex resolve to the node-specific error (which
 * carries the expected `nodeId`).
 */
export function validateIR(ir: GraphIR): WispError[] {
  const nodeIds = new Set<string>();
  const idCounts = new Map<string, number>();
  for (const node of ir.nodes) {
    idCounts.set(node.id, (idCounts.get(node.id) ?? 0) + 1);
    nodeIds.add(node.id);
  }
  return [
    ...checkUniqueIds(idCounts),
    ...checkNodeReferences(ir, nodeIds),
    ...checkNodeProperties(ir),
    ...checkEdges(ir, nodeIds),
    ...checkConcurrency(ir),
    ...checkCycles(ir),
  ];
}

// re-export shared types for builder/macros convenience
export type { FnDescriptor, GraphIR, IRCondition, IREdge, IRNode, NodeSpec, PrimitiveMeta };
