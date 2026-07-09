// ═══════════════════════════════════════════════════════════════════════════
// DSL composite macros — reviewLoop, council, reviewFix.
//
// Each macro expands to a subgraph of atoms (nodes + edges + conditions) and
// is added to a {@link WorkflowBuilder} via builder methods that delegate to
// the expanders in this module. The expanded nodes carry {@link PrimitiveMeta}
// recording the macro kind for stage labeling (S14) and TUI grouping (S33).
//
// The expanders produce **builder-level** nodes ({@link BuilderNode} with *live*
// function references), edges ({@link IREdge}), and conditions
// ({@link BuilderCondition}). A builder method splices these into its internal
// state; `toIR()` then serializes the live fns to {@link FnDescriptor}s.
// ═══════════════════════════════════════════════════════════════════════════

import type { IREdge, NodeSpec } from "../types.js";
import { compact } from "../utils.js";
import { live } from "./ir.js";
import type { BuilderCondition, BuilderNode, LiveFn } from "./ir.js";

// ─── Shared helpers ───────────────────────────────────────────────

/**
 * The structural result of a macro expansion: builder-level nodes, edges, and
 * conditions ready to be spliced into a {@link BuilderIR}.
 */
export interface MacroExpansion {
  nodes: BuilderNode[];
  edges: IREdge[];
  conditions: BuilderCondition[];
}

/**
 * Materialize a builder node from a `string | NodeSpec` reference.
 *
 * When `ref` is a **string** the node is treated as an externally-defined
 * reference: a minimal marker node is produced (carrying only the id + primitive
 * metadata) so downstream consumers (builder merge, executor) can track it.
 * When `ref` is a **NodeSpec** a full node is created from the spec with the
 * given `fallbackId`.
 */
export function materializeNode(
  ref: string | NodeSpec,
  fallbackId: string,
  primitiveKind: string,
  primitiveMeta?: Record<string, unknown>,
): BuilderNode {
  if (typeof ref === "string") {
    return {
      id: ref,
      kind: "node",
      primitive: { kind: primitiveKind, ...(primitiveMeta ? { meta: primitiveMeta } : {}) },
    };
  }
  const spec = ref;
  const node: BuilderNode = {
    id: fallbackId,
    kind: "node",
    ...compact({
      agentType: spec.agentType,
      profileRef: spec.profileRef,
      prompt: spec.prompt,
      outputSchema: spec.outputSchema,
      dependsOn: spec.dependsOn ? [...spec.dependsOn] : undefined,
      stage: spec.stage,
      retries: spec.retries,
      timeoutSec: spec.timeoutSec,
      cwd: spec.cwd,
    }),
    primitive: { kind: primitiveKind, ...(primitiveMeta ? { meta: primitiveMeta } : {}) },
  };
  return node;
}

// ─── reviewLoop options ───────────────────────────────────────────

export interface ReviewLoopOptions {
  /** Node id (or inline spec) for the worker (the agent doing the task). */
  worker: string | NodeSpec;
  /** Node id (or inline spec) for the gate (reviewer). */
  gate: string | NodeSpec;
  /** Maximum number of review rounds before forcing termination. */
  maxRounds: number;
  /**
   * External node ids the loop must wait for before starting. Loop edges are
   * not gating, so a reviewLoop sequenced after upstream nodes MUST declare
   * them here (or it will start immediately at run start).
   */
  dependsOn?: string[];
  /**
   * Optional accept predicate: called after each gate review.
   * Receives ctx with gate output; returns true to accept / break the loop.
   * When absent the loop runs until `maxRounds` (the default `until` is
   * `() => false`, so the gate's verdict alone does not break the loop).
   */
  acceptOn?: (ctx: unknown) => boolean;
}

/**
 * Expand a reviewLoop macro into atoms.
 *
 * Structure (IMPLEMENTATION §4.3):
 *   loop(id, {
 *     body: worker → gate,
 *     until: acceptOn? || (() => false),
 *     maxIterations: maxRounds
 *   })
 *
 * The worker node receives transcript-replay via `buildResumePrompt` (D4) on
 * subsequent iterations via the loop's resume mechanism. The expansion records
 * the worker's primitive kind as `"reviewLoopWorker"` so the executor knows to
 * apply transcript-replay (rather than a fresh session) on loop re-entry.
 *
 * When no `acceptOn` predicate is supplied the loop's `until` defaults to
 * `() => false`, so the loop runs until `maxRounds` is reached — the gate's
 * verdict alone does not short-circuit it.
 *
 * @param id    The base id for the loop node.
 * @param opts  Worker, gate, maxRounds, optional acceptOn predicate.
 * @returns     Builder-level nodes, edges, and conditions.
 * @throws      When `maxRounds` is less than 1.
 */
export function expandReviewLoop(id: string, opts: ReviewLoopOptions): MacroExpansion {
  if (opts.maxRounds < 1) {
    throw new Error(
      `reviewLoop "${id}": maxRounds (maxIterations) must be at least 1, got ${opts.maxRounds}.`,
    );
  }

  const workerId = typeof opts.worker === "string" ? opts.worker : `${id}:worker`;
  const gateId = typeof opts.gate === "string" ? opts.gate : `${id}:gate`;

  // Worker node (or external-reference marker).
  const workerNode = materializeNode(opts.worker, workerId, "reviewLoopWorker", {
    macro: "reviewLoop",
    role: "worker",
  });

  // Gate / reviewer node — depends on the worker.
  const gateNode = materializeNode(opts.gate, gateId, "reviewLoop", {
    macro: "reviewLoop",
    role: "gate",
  });
  gateNode.dependsOn = [...(gateNode.dependsOn ?? []), workerId];

  // Until fn: acceptOn when provided, else a default that never auto-accepts
  // (the loop runs until maxRounds).
  const untilFn: LiveFn = opts.acceptOn
    ? live(opts.acceptOn, "acceptOn")
    : live(() => false, "until");

  // Loop node wrapping the worker → gate body.
  const loopNode: BuilderNode = {
    id,
    kind: "loop",
    body: workerId,
    until: untilFn,
    maxIterations: opts.maxRounds,
    primitive: { kind: "reviewLoop" },
    ...(opts.dependsOn ? { dependsOn: [...opts.dependsOn] } : {}),
  };

  const nodes: BuilderNode[] = [workerNode, gateNode, loopNode];
  const edges: IREdge[] = [
    { from: workerId, to: gateId, kind: "dep" },
    // Gate the worker (loop body) on the loop via loop→body so it is NOT
    // scheduled as an independent free node (it must run via the loop handler)
    // and so skip propagates loop → worker → gate. No `loop`-kind edge (it is
    // non-gating and would falsely cycle with this dep edge in detectCycles).
    { from: id, to: workerId, kind: "dep" },
    // dependsOn gates the LOOP on upstream nodes (loop edges are not gating).
    ...(opts.dependsOn
      ? opts.dependsOn.map((dep) => ({ from: dep, to: id, kind: "dep" as const }))
      : []),
  ];
  const conditions: BuilderCondition[] = [{ id: `${id}:accept`, on: gateId, fn: untilFn }];

  return { nodes, edges, conditions };
}

// ─── council options ──────────────────────────────────────────────

export interface CouncilOptions {
  /** Array of member node specs (ids are auto-generated). */
  members: NodeSpec[];
  /**
   * Synthesizer node spec: receives all member outputs and produces a
   * consolidated result (agent-run synthesis via `profile`).
   */
  synthesize: NodeSpec & { profile: string };
}

/**
 * Expand a council macro into atoms.
 *
 * Structure (IMPLEMENTATION §4.3):
 *   parallel(members) → reduce(synthesize)
 *
 * All members run concurrently; their outputs are fed to the synthesizer
 * which produces the consolidated result. The synthesizer's prompt is stored in
 * `primitive.meta.prompt` for the executor to build the synthesis instruction.
 *
 * @param id    The base id for the council grouping.
 * @param opts  Members + synthesizer spec.
 * @returns     Builder-level nodes, edges, and conditions.
 * @throws      When `members` is empty.
 */
export function expandCouncil(id: string, opts: CouncilOptions): MacroExpansion {
  if (opts.members.length === 0) {
    throw new Error(`council "${id}": members must contain at least one member (got empty array).`);
  }

  // Materialize member nodes with generated ids.
  const memberNodes: BuilderNode[] = opts.members.map((spec, i) =>
    materializeNode(spec, `${id}:member:${i}`, "council", {
      macro: "council",
      role: "member",
      index: i,
    }),
  );
  const memberIds = memberNodes.map((n) => n.id);

  // Parallel grouping node.
  const parallelNode: BuilderNode = {
    id: `${id}:parallel`,
    kind: "parallel",
    primitive: { kind: "council", meta: { macro: "council", role: "parallel" } },
  };

  // Reduce / synthesize node — merges all member outputs.
  const synthesizeNode: BuilderNode = {
    id: `${id}:synthesize`,
    kind: "reduce",
    from: [...memberIds],
    profileRef: opts.synthesize.profile,
    ...compact({ agentType: opts.synthesize.agentType }),
    primitive: {
      kind: "council",
      meta: {
        macro: "council",
        role: "synthesize",
        ...compact({ prompt: opts.synthesize.prompt }),
      },
    },
  };

  const nodes: BuilderNode[] = [...memberNodes, parallelNode, synthesizeNode];
  const edges: IREdge[] = [
    // Members feed into the parallel grouping.
    ...memberIds.map((mid) => ({ from: mid, to: parallelNode.id, kind: "dep" as const })),
    // Members feed into the synthesizer (reduce.from lists them).
    ...memberIds.map((mid) => ({ from: mid, to: synthesizeNode.id, kind: "dep" as const })),
  ];
  const conditions: BuilderCondition[] = [];

  return { nodes, edges, conditions };
}

// ─── reviewFix options ───────────────────────────────────────────

export interface ReviewFixOptions {
  /** Reviewer node spec (identifies problems to fix). */
  reviewer: string | NodeSpec;
  /**
   * Function that receives the reviewer's output and returns an array of
   * per-fix NodeSpecs (one per identified problem).
   */
  workers: (ctx: unknown) => NodeSpec[];
  /**
   * Optional merge node spec. When present, all fix results are merged back
   * into a single output (agent-run synthesis via `profile`).
   */
  merge?: NodeSpec & { profile: string };
}

/**
 * Expand a reviewFix macro into atoms.
 *
 * Structure (IMPLEMENTATION §4.3):
 *   reviewer → fanOut(workers from reviewer findings) → merge?
 *
 * The reviewer identifies problems; one worker is spawned per problem; their
 * fixes are optionally merged by a synthesis node. The `workers` fn doubles as
 * the fanOut's `iterate` fn (returning per-fix NodeSpecs); the `each` fn is the
 * identity (each item is already a NodeSpec).
 *
 * A best-effort static guard calls `workers()` at expansion time: if it
 * *returns* an empty array the expansion is rejected early (before execution).
 * If `workers()` *throws* (typically because it needs the reviewer output that
 * is only available at runtime), the guard is skipped and the empty/non-empty
 * decision is deferred to the executor.
 *
 * @param id    The base id for the reviewFix grouping.
 * @param opts  Reviewer, workers fn, optional merge spec.
 * @returns     Builder-level nodes, edges, and conditions.
 * @throws      When `workers()` returns (without throwing) an empty array.
 */
export function expandReviewFix(id: string, opts: ReviewFixOptions): MacroExpansion {
  const reviewerId = typeof opts.reviewer === "string" ? opts.reviewer : `${id}:reviewer`;

  // Reviewer node (or external-reference marker).
  const reviewerNode = materializeNode(opts.reviewer, reviewerId, "reviewFix", {
    macro: "reviewFix",
    role: "reviewer",
  });

  // Best-effort static guard: call workers() to verify at least one fix is
  // produced. If workers() throws (it likely needs the reviewer output that is
  // only available at runtime), defer the check to the executor rather than
  // raising a misleading 'empty array' error.
  let workerSpecs: NodeSpec[] | undefined;
  try {
    workerSpecs = opts.workers(undefined);
  } catch {
    workerSpecs = undefined;
  }
  if (workerSpecs !== undefined && workerSpecs.length === 0) {
    throw new Error(
      `reviewFix "${id}": workers returned an empty array; at least one fix worker is required.`,
    );
  }

  // fanOut node: iterates over reviewer findings to spawn per-fix workers.
  const fanOutId = `${id}:fix`;
  const fanOutNode: BuilderNode = {
    id: fanOutId,
    kind: "fanOut",
    from: reviewerId,
    iterate: live(opts.workers, "iterate"),
    each: live((item: unknown) => item, "each"),
    primitive: { kind: "reviewFix", meta: { macro: "reviewFix", role: "fanOut" } },
  };

  const nodes: BuilderNode[] = [reviewerNode, fanOutNode];
  const edges: IREdge[] = [{ from: reviewerId, to: fanOutId, kind: "fanOut" }];
  const conditions: BuilderCondition[] = [];

  // Optional merge node.
  if (opts.merge) {
    const mergeId = `${id}:merge`;
    const mergeNode: BuilderNode = {
      id: mergeId,
      kind: "reduce",
      from: [fanOutId],
      profileRef: opts.merge.profile,
      ...compact({ agentType: opts.merge.agentType }),
      primitive: {
        kind: "reviewFix",
        meta: {
          macro: "reviewFix",
          role: "merge",
          ...compact({ prompt: opts.merge.prompt }),
        },
      },
    };
    nodes.push(mergeNode);
    edges.push({ from: fanOutId, to: mergeId, kind: "dep" });
  }

  return { nodes, edges, conditions };
}
