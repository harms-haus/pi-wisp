// ═══════════════════════════════════════════════════════════════════════════
// In-memory graph + run-state fixtures (S25 / IMPLEMENTATION_PROMPT §19).
//
// Small, hand-built `GraphIR` + `RunState` pairs covering the structural cases
// the executor / scheduler / widget tests exercise:
//
//   linearGraph()       A → B → C
//   diamondGraph()      A → {B, C} → D
//   failThenSkipGraph() A → B(fails) → C(skipped); D independent (succeeds)
//
// Each builder returns `{ ir, runState }` with every node starting `pending`
// (the executor mutates `runState` as it runs). Tests configure a FakeAgentAdapter
// to produce the desired per-node behavior.
// ═══════════════════════════════════════════════════════════════════════════

import type {
  FnDescriptor,
  FnKind,
  GraphIR,
  IREdge,
  IRNode,
  NodeRuntime,
  RunState,
} from "../../types.js";

// ─── Fixture return type ────────────────────────────────────────────

/** A built graph fixture: the IR plus a fresh `RunState` with all nodes pending. */
export interface GraphFixture {
  ir: GraphIR;
  runState: RunState;
}

// ─── Small builders ─────────────────────────────────────────────────

/**
 * Wrap a function source string as a serialized {@link FnDescriptor}. Mirrors
 * what the DSL fn-serializer (S17) produces; fixtures use these directly so the
 * IR is executable once the executor rehydrates them.
 */
export function fn(src: string, kind: FnKind): FnDescriptor {
  return { __fn: true, src, kind };
}

/** A plain agent node with a prompt, depending on `dependsOn`. */
function node(id: string, prompt: string, dependsOn: string[] = []): IRNode {
  return {
    id,
    kind: "node",
    dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    profileRef: "default",
    prompt,
  };
}

/** Assemble a `GraphIR` with empty conditions/schemas/primitives by default. */
function makeGraphIR(
  nodes: IRNode[],
  edges: IREdge[],
  extra?: { title?: string; slug?: string; options?: GraphIR["options"] },
): GraphIR {
  return {
    title: extra?.title ?? "test-workflow",
    slug: extra?.slug ?? "test-workflow",
    options: extra?.options ?? {},
    nodes,
    edges,
    conditions: [],
    schemas: {},
    primitives: {},
  };
}

// ─── RunState factory ───────────────────────────────────────────────

/**
 * Build a fresh `RunState` for a graph: every node starts `pending` unless
 * overridden via `nodeStatus[id]`. This is the starting point the executor
 * receives (it mutates statuses as nodes run).
 *
 * @param ir - The graph whose nodes seed the run state.
 * @param overrides - Optional `runId` + per-node runtime overrides.
 */
export function makeRunState(
  ir: GraphIR,
  overrides?: {
    runId?: string;
    nodeStatus?: Record<string, Partial<NodeRuntime>>;
  },
): RunState {
  const nodes = new Map<string, NodeRuntime>();
  for (const n of ir.nodes) {
    const partial = overrides?.nodeStatus?.[n.id];
    nodes.set(n.id, {
      status: "pending",
      attempts: 0,
      toolCount: 0,
      filesEdited: [],
      ...partial,
    });
  }
  return {
    runId: overrides?.runId ?? "run-test",
    title: ir.title,
    slug: ir.slug,
    startedAt: 0,
    status: "running",
    nodes,
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────

/**
 * Linear chain A → B → C (all dep edges). Used to verify sequential scheduling
 * and in-order execution.
 */
export function linearGraph(): GraphFixture {
  const ir = makeGraphIR(
    [node("a", "Do step A"), node("b", "Do step B", ["a"]), node("c", "Do step C", ["b"])],
    [
      { from: "a", to: "b", kind: "dep" },
      { from: "b", to: "c", kind: "dep" },
    ],
  );
  return { ir, runState: makeRunState(ir) };
}

/**
 * Diamond A → {B, C} → D (B and C fan out from A and fan in to D). Used to
 * verify fan-in correctness and that independent branches run concurrently when
 * pools allow.
 */
export function diamondGraph(): GraphFixture {
  const ir = makeGraphIR(
    [
      node("a", "Prepare inputs"),
      node("b", "Left branch", ["a"]),
      node("c", "Right branch", ["a"]),
      node("d", "Merge branches", ["b", "c"]),
    ],
    [
      { from: "a", to: "b", kind: "dep" },
      { from: "a", to: "c", kind: "dep" },
      { from: "b", to: "d", kind: "dep" },
      { from: "c", to: "d", kind: "dep" },
    ],
  );
  return { ir, runState: makeRunState(ir) };
}

/**
 * Failure + skip propagation: A (succeeds) → B (fails) → C (skipped because its
 * dep B failed); D is independent and still runs/succeeds. Used to verify the
 * retry-then-skip policy and no-fail-fast behavior. The IR is plain structure;
 * tests configure a FakeAgentAdapter to make node `b` fail.
 */
export function failThenSkipGraph(): GraphFixture {
  const ir = makeGraphIR(
    [
      node("a", "Task A (succeeds)"),
      node("b", "Task B (fails)", ["a"]),
      node("c", "Task C (should be skipped)", ["b"]),
      node("d", "Task D (independent, succeeds)"),
    ],
    [
      { from: "a", to: "b", kind: "dep" },
      { from: "b", to: "c", kind: "dep" },
    ],
  );
  return { ir, runState: makeRunState(ir) };
}
