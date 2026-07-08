// ═══════════════════════════════════════════════════════════════════════════
// IR validation (S13).
//
// Validates a compiled GraphIR and returns a list of structured errors.
// Empty array = valid. Each error is
// `{ kind: "validation", nodeId?, message, location? }`
// (SCOUTING C5 — structured, agent-actionable errors).
//
// Checks: unique node ids (2); dependsOn/from/on references (3); outputSchema
// well-formedness (4); concurrency sanity (5); mutual exclusivity (6); path
// traversal (7); edge consistency (8); cycle detection (1).
//
// Node-level checks are emitted before edge-consistency errors so that tests
// using `.find()` on a message regex resolve to the node-specific error (which
// carries the expected `nodeId`).
// ═══════════════════════════════════════════════════════════════════════════

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, dirname } from "node:path";
import { homedir } from "node:os";

import { Type } from "typebox";
import { Value } from "typebox/value";

import type { GraphIR, WispError } from "../types.js";
import { detectCycles } from "./cycle-detection.js";

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
export function isCwdWithinRoot(cwd: string): boolean {
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
 * Empty array = valid.
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
