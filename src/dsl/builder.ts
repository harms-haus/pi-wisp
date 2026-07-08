// ═══════════════════════════════════════════════════════════════════════════
// DSL builder — wf() entry point + WorkflowBuilder fluent API.
//
// Exposes atoms (node, fanOut, cond, loop, reduce/merge, parallel, sequence)
// and inline-profile registration. Each method appends to an internal
// {@link BuilderIR} (holding *live* function references) and returns `this`
// for chaining. Call `toIR()` to obtain a serialisable {@link GraphIR}; fns are
// serialized to {@link FnDescriptor}s at that point via `serializeFn` (S17).
// ═══════════════════════════════════════════════════════════════════════════

import type {
  FnDescriptor,
  GraphIR,
  IRCondition,
  IREdge,
  IRNode,
  IRNodeBase,
  NodeSpec,
  PrimitiveMeta,
} from "../types.js";
import type { WispProfile } from "../profiles/types.js";
import { inlineProfile } from "../profiles/inline.js";
import { compact, kebabCase } from "../utils.js";
import { serializeFn } from "./fn-serialize.js";
import { live } from "./ir.js";
import type { BuilderIR, BuilderNode } from "./ir.js";
import { expandReviewLoop, expandCouncil, expandReviewFix, materializeNode } from "./macros.js";
import type {
  ReviewLoopOptions,
  CouncilOptions,
  ReviewFixOptions,
  MacroExpansion,
} from "./macros.js";

// ─── WfOptions ────────────────────────────────────────────────────

export interface WfOptions {
  maxConcurrency?: number;
  defaultRetries?: number;
  title?: string;
}

/** Shared option shape for reduce/merge. */
export interface ReduceOpts {
  from: string[];
  merge?: (ctx: unknown) => unknown;
  profile?: string;
  agentType?: string;
}

export interface WorkflowBuilder {
  // ── Atoms ────────────────────────────────────────────────────

  /**
   * Add a plain agent node.
   * @param id   Unique node identifier.
   * @param spec Profile ref, prompt, outputSchema, dependsOn, etc.
   */
  node(id: string, spec: NodeSpec): WorkflowBuilder;

  /**
   * Add a fan-out node: given a producer's output, iterate over items
   * and spawn a child node per item.
   */
  fanOut(
    id: string,
    opts: {
      from: string;
      iterate: (ctx: unknown) => unknown[];
      each: (item: unknown, ctx: unknown) => NodeSpec;
    },
  ): WorkflowBuilder;

  /**
   * Add a conditional branch node.
   * @param opts.on  The upstream node id whose completion triggers the check.
   * @param opts.when Predicate fn (returns boolean or branch key).
   * @param opts.then Target node id or inline spec when truthy.
   * @param opts.else Target node id or inline spec when falsy (optional).
   */
  cond(
    id: string,
    opts: {
      on: string;
      when: (ctx: unknown) => boolean | string;
      then: string | NodeSpec;
      else?: string | NodeSpec;
    },
  ): WorkflowBuilder;

  /**
   * Add a loop node (runs body until `until` returns true).
   * @param opts.body      Node id (or spec) for the loop body.
   * @param opts.until     Predicate fn (receives ctx, returns boolean).
   * @param opts.maxIterations  Hard cap on loop iterations.
   */
  loop(
    id: string,
    opts: {
      body: string;
      until: (ctx: unknown) => boolean;
      maxIterations?: number;
    },
  ): WorkflowBuilder;

  /**
   * Add a reduce / merge node. Combines outputs from multiple upstream nodes.
   * @param opts.from   Upstream node ids whose outputs are merged.
   * @param opts.merge  Optional JS merge fn (if absent, agent-run synthesis).
   * @param opts.profile Profile ref for agent-run synthesis.
   * @param opts.agentType Adapter type (default "pi").
   */
  reduce(id: string, opts: ReduceOpts): WorkflowBuilder;

  /**
   * Alias for `reduce(id, opts)`. Syntactic sugar for the merge pattern.
   */
  merge(id: string, opts: ReduceOpts): WorkflowBuilder;

  /**
   * Add a parallel grouping (nodes run concurrently).
   * @param opts.nodes Child node ids or specs.
   */
  parallel(id: string, opts: { nodes: (string | NodeSpec)[] }): WorkflowBuilder;

  /**
   * Add a sequence grouping (nodes run in order).
   * @param opts.steps Child node ids or specs.
   */
  sequence(id: string, opts: { steps: (string | NodeSpec)[] }): WorkflowBuilder;

  // ── Composite macros ─────────────────────────────────────────

  /**
   * Review-loop macro: worker does the task, gate reviews it, and the loop
   * repeats until `acceptOn` returns `true` or `maxRounds` is reached.
   * The worker receives transcript-replay for continuity across rounds.
   * Expands to a loop node + worker + gate nodes + condition.
   */
  reviewLoop(id: string, opts: ReviewLoopOptions): WorkflowBuilder;

  /**
   * Council macro: multiple members run concurrently; a synthesizer merges
   * their outputs into a single result. Expands to parallel + reduce.
   */
  council(id: string, opts: CouncilOptions): WorkflowBuilder;

  /**
   * Review-fix macro: a reviewer identifies problems, one worker is spawned
   * per problem via fanOut, and results are optionally merged.
   * Expands to reviewer → fanOut(workers) → merge?.
   */
  reviewFix(id: string, opts: ReviewFixOptions): WorkflowBuilder;

  // ── Inline profiles ──────────────────────────────────────────

  /**
   * Register an inline profile (in-workflow only).
   * @param name   Profile name (must be unique within this workflow).
   * @param config Profile fields (e.g. model, provider, systemPrompt, etc.).
   */
  profile(name: string, config: Record<string, unknown>): WorkflowBuilder;

  // ── IR serialisation ─────────────────────────────────────────

  /**
   * Compile the builder's accumulated state into a serializable GraphIR.
   * Live function references are serialized to {@link FnDescriptor}s. Each
   * call returns an independent structural copy.
   */
  toIR(): GraphIR;
}

// ─── Internal implementation ──────────────────────────────────────

/** Fields shared by every builder node, copied verbatim from a NodeSpec/base. */
interface NodeBaseFields {
  stage?: string;
  retries?: number;
  timeoutSec?: number;
  cwd?: string;
  outputSchema?: unknown;
  dependsOn?: string[];
}

/** Extract the common base fields from a NodeSpec-like object. */
function pickBaseFields(spec: NodeSpec): NodeBaseFields {
  const out: NodeBaseFields = {};
  if (spec.stage !== undefined) out.stage = spec.stage;
  if (spec.retries !== undefined) out.retries = spec.retries;
  if (spec.timeoutSec !== undefined) out.timeoutSec = spec.timeoutSec;
  if (spec.cwd !== undefined) out.cwd = spec.cwd;
  if (spec.outputSchema !== undefined) out.outputSchema = spec.outputSchema;
  if (spec.dependsOn !== undefined) out.dependsOn = [...spec.dependsOn];
  return out;
}

/** Build the common {@link IRNodeBase} fields (minus `kind`) from a builder node. */
function extractNodeBase(bn: BuilderNode): Omit<IRNodeBase, "kind"> {
  return {
    id: bn.id,
    ...compact({
      dependsOn: bn.dependsOn ? [...bn.dependsOn] : undefined,
      stage: bn.stage,
      retries: bn.retries,
      timeoutSec: bn.timeoutSec,
      cwd: bn.cwd,
      outputSchema: bn.outputSchema,
      primitive: bn.primitive ? { ...bn.primitive } : undefined,
    }),
  };
}

/** Serialize a plain-node builder node into an IRNode. */
function serializePlainNode(
  bn: Extract<BuilderNode, { kind: "node" }>,
  base: Omit<IRNodeBase, "kind">,
): IRNode {
  return {
    ...base,
    kind: "node",
    ...compact({
      agentType: bn.agentType,
      profileRef: bn.profileRef,
      prompt: bn.prompt,
      promptFnRef: bn.promptFn ? serializeFn(bn.promptFn.fn, bn.promptFn.kind) : undefined,
    }),
  };
}

/** Serialize a fanOut builder node into an IRNode. */
function serializeFanOutNode(
  bn: Extract<BuilderNode, { kind: "fanOut" }>,
  base: Omit<IRNodeBase, "kind">,
): IRNode {
  return {
    ...base,
    kind: "fanOut",
    from: bn.from,
    iterateFnRef: serializeFn(bn.iterate.fn, bn.iterate.kind),
    eachFnRef: serializeFn(bn.each.fn, bn.each.kind),
  };
}

/** Serialize a cond builder node into an IRNode. */
function serializeCondNode(
  bn: Extract<BuilderNode, { kind: "cond" }>,
  base: Omit<IRNodeBase, "kind">,
): IRNode {
  return {
    ...base,
    kind: "cond",
    on: bn.on,
    whenFnRef: serializeFn(bn.when.fn, bn.when.kind),
    then: bn.then,
    ...compact({ else: bn.else }),
  };
}

/** Serialize a loop builder node into an IRNode. */
function serializeLoopNode(
  bn: Extract<BuilderNode, { kind: "loop" }>,
  base: Omit<IRNodeBase, "kind">,
): IRNode {
  return {
    ...base,
    kind: "loop",
    body: bn.body,
    untilFnRef: serializeFn(bn.until.fn, bn.until.kind),
    ...compact({ maxIterations: bn.maxIterations }),
  };
}

/** Serialize a reduce builder node into an IRNode. */
function serializeReduceNode(
  bn: Extract<BuilderNode, { kind: "reduce" }>,
  base: Omit<IRNodeBase, "kind">,
): IRNode {
  return {
    ...base,
    kind: "reduce",
    from: [...bn.from],
    ...compact({
      mergeFnRef: bn.merge ? serializeFn(bn.merge.fn, bn.merge.kind) : undefined,
      profileRef: bn.profileRef,
      agentType: bn.agentType,
    }),
  };
}

/** Serialize a single builder node (with live fns) into an IRNode (with FnDescriptors). */
function serializeNode(bn: BuilderNode): IRNode {
  const base = extractNodeBase(bn);
  switch (bn.kind) {
    case "node":
      return serializePlainNode(bn, base);
    case "fanOut":
      return serializeFanOutNode(bn, base);
    case "cond":
      return serializeCondNode(bn, base);
    case "loop":
      return serializeLoopNode(bn, base);
    case "reduce":
      return serializeReduceNode(bn, base);
    case "parallel":
      return { ...base, kind: "parallel" };
    case "sequence":
      return { ...base, kind: "sequence", steps: [...bn.steps] };
  }
}

/**
 * Concrete {@link WorkflowBuilder} implementation backed by a mutable
 * {@link BuilderIR}. State (nodes, edges, conditions, known ids) is held as
 * private instance fields; each fluent method validates immediate invariants,
 * appends to the IR, and returns `this` for chaining.
 */
class WorkflowBuilderImpl implements WorkflowBuilder {
  private readonly state: BuilderIR;
  private readonly knownIds = new Set<string>();
  private readonly profileNames = new Set<string>();

  constructor(name: string, options?: WfOptions) {
    const resolvedTitle = options?.title ?? name;
    this.state = {
      title: resolvedTitle,
      slug: kebabCase(resolvedTitle),
      options: {
        maxConcurrency: options?.maxConcurrency,
        defaultRetries: options?.defaultRetries,
      },
      nodes: [],
      edges: [],
      conditions: [],
      inlineProfiles: new Map(),
    };
  }

  /** Throw if `id` is already registered as a node. */
  private assertUniqueId(id: string): void {
    if (this.knownIds.has(id)) {
      throw new Error(`Duplicate node id "${id}": a node with this id already exists.`);
    }
  }

  /** Throw if `ref` is not a registered node id. */
  private assertNodeExists(ref: string, context: string, nodeId: string): void {
    if (!this.knownIds.has(ref)) {
      throw new Error(
        `Node "${nodeId}" references unknown node "${ref}" in ${context}; node not found.`,
      );
    }
  }

  /** Register a builder node + its id. */
  private addNode(node: BuilderNode): void {
    this.state.nodes.push(node);
    this.knownIds.add(node.id);
  }

  node(id: string, spec: NodeSpec): WorkflowBuilder {
    this.assertUniqueId(id);
    if (spec.dependsOn) {
      for (const dep of spec.dependsOn) this.assertNodeExists(dep, "dependsOn", id);
    }
    const node: BuilderNode = {
      id,
      kind: "node",
      ...pickBaseFields(spec),
      ...compact({
        agentType: spec.agentType,
        profileRef: spec.profileRef,
        prompt: spec.prompt,
      }),
    };
    this.addNode(node);
    if (spec.dependsOn) {
      for (const dep of spec.dependsOn) this.state.edges.push({ from: dep, to: id, kind: "dep" });
    }
    return this;
  }

  fanOut(
    id: string,
    opts: {
      from: string;
      iterate: (ctx: unknown) => unknown[];
      each: (item: unknown, ctx: unknown) => NodeSpec;
    },
  ): WorkflowBuilder {
    this.assertUniqueId(id);
    this.assertNodeExists(opts.from, "fanOut 'from'", id);
    this.addNode({
      id,
      kind: "fanOut",
      from: opts.from,
      iterate: live(opts.iterate, "iterate"),
      each: live(opts.each, "each"),
    });
    this.state.edges.push({ from: opts.from, to: id, kind: "fanOut" });
    return this;
  }

  cond(
    id: string,
    opts: {
      on: string;
      when: (ctx: unknown) => boolean | string;
      then: string | NodeSpec;
      else?: string | NodeSpec;
    },
  ): WorkflowBuilder {
    this.assertUniqueId(id);
    this.assertNodeExists(opts.on, "cond 'on'", id);
    this.addNode({
      id,
      kind: "cond",
      on: opts.on,
      when: live(opts.when, "cond"),
      then: opts.then,
      ...compact({ else: opts.else }),
    });
    this.state.edges.push({ from: opts.on, to: id, kind: "dep" });
    if (typeof opts.then === "string") {
      this.state.edges.push({ from: id, to: opts.then, kind: "cond:branch" });
    }
    if (opts.else !== undefined && typeof opts.else === "string") {
      this.state.edges.push({ from: id, to: opts.else, kind: "cond:branch" });
    }
    this.state.conditions.push({ id, on: opts.on, fn: live(opts.when, "cond") });
    return this;
  }

  loop(
    id: string,
    opts: { body: string; until: (ctx: unknown) => boolean; maxIterations?: number },
  ): WorkflowBuilder {
    this.assertUniqueId(id);
    this.assertNodeExists(opts.body, "loop 'body'", id);
    this.addNode({
      id,
      kind: "loop",
      body: opts.body,
      until: live(opts.until, "until"),
      ...compact({ maxIterations: opts.maxIterations }),
    });
    this.state.edges.push({ from: opts.body, to: id, kind: "loop" });
    return this;
  }

  reduce(id: string, opts: ReduceOpts): WorkflowBuilder {
    this.assertUniqueId(id);
    for (const member of opts.from) this.assertNodeExists(member, "reduce 'from'", id);
    this.addNode({
      id,
      kind: "reduce",
      from: [...opts.from],
      ...compact({
        merge: opts.merge ? live(opts.merge, "merge") : undefined,
        profileRef: opts.profile,
        agentType: opts.agentType,
      }),
    });
    for (const member of opts.from) this.state.edges.push({ from: member, to: id, kind: "dep" });
    return this;
  }

  merge(id: string, opts: ReduceOpts): WorkflowBuilder {
    return this.reduce(id, opts);
  }

  parallel(id: string, opts: { nodes: (string | NodeSpec)[] }): WorkflowBuilder {
    this.assertUniqueId(id);
    // Resolve each child: a string is a reference to an existing node; a
    // NodeSpec is materialised inline into a fresh node (id `${id}:node:${i}`).
    const childIds: string[] = [];
    let inlineIdx = 0;
    for (const child of opts.nodes) {
      if (typeof child === "string") {
        this.assertNodeExists(child, "parallel 'nodes'", id);
        childIds.push(child);
      } else {
        const childId = `${id}:node:${inlineIdx}`;
        inlineIdx += 1;
        this.assertUniqueId(childId);
        this.addNode(materializeNode(child, childId, "node", { group: "parallel", parent: id }));
        childIds.push(childId);
      }
    }
    this.addNode({ id, kind: "parallel" });
    for (const cid of childIds) this.state.edges.push({ from: cid, to: id, kind: "dep" });
    return this;
  }

  sequence(id: string, opts: { steps: (string | NodeSpec)[] }): WorkflowBuilder {
    this.assertUniqueId(id);
    // Resolve each step in order: a string references an existing node; a
    // NodeSpec is materialised inline into a fresh node (id `${id}:step:${i}`).
    // The ordered list of step ids is preserved on the sequence node.
    const steps: string[] = [];
    let inlineIdx = 0;
    for (const child of opts.steps) {
      if (typeof child === "string") {
        this.assertNodeExists(child, "sequence 'steps'", id);
        steps.push(child);
      } else {
        const childId = `${id}:step:${inlineIdx}`;
        inlineIdx += 1;
        this.assertUniqueId(childId);
        this.addNode(materializeNode(child, childId, "node", { group: "sequence", parent: id }));
        steps.push(childId);
      }
    }
    this.addNode({ id, kind: "sequence", steps: [...steps] });
    for (const sid of steps) this.state.edges.push({ from: sid, to: id, kind: "dep" });
    return this;
  }

  // ── Composite macro methods ─────────────────────────────────

  /**
   * Splice a {@link MacroExpansion} (nodes + edges + conditions) from a macro
   * expander into the builder's internal IR. Handles id-uniqueness, reference
   * validation, and existing-node marker skipping (when a macro option is a
   * string referencing a previously-defined node).
   *
   * For marker nodes that reference an already-registered node id, the marker's
   * {@link PrimitiveMeta} is applied to the existing node so stage-label
   * derivation and the `primitives` record reflect the macro provenance.
   */
  private spliceExpansion(expansion: MacroExpansion): this {
    const existingIds = new Set(this.knownIds);
    const newIds = new Set<string>();

    for (const node of expansion.nodes) {
      if (existingIds.has(node.id)) continue; // marker ref to existing node
      if (newIds.has(node.id)) {
        throw new Error(
          `Duplicate node id "${node.id}" within macro expansion (appears more than once).`,
        );
      }
      newIds.add(node.id);
    }

    // Validate every edge references a known or newly-added node.
    const allIds = new Set([...existingIds, ...newIds]);
    for (const edge of expansion.edges) {
      if (!allIds.has(edge.from)) {
        throw new Error(
          `Macro expansion edge references unknown node "${edge.from}" (not found in graph).`,
        );
      }
      if (!allIds.has(edge.to)) {
        throw new Error(
          `Macro expansion edge references unknown node "${edge.to}" (not found in graph).`,
        );
      }
    }

    // Apply primitive metadata from marker nodes onto existing nodes.
    for (const node of expansion.nodes) {
      if (existingIds.has(node.id) && node.primitive) {
        const existingNode = this.state.nodes.find((n) => n.id === node.id);
        if (existingNode) {
          existingNode.primitive = node.primitive;
        }
      }
    }

    // Add new nodes.
    for (const node of expansion.nodes) {
      if (!existingIds.has(node.id)) {
        this.addNode(node);
      }
    }

    // Append edges and conditions.
    this.state.edges.push(...expansion.edges);
    this.state.conditions.push(...expansion.conditions);

    return this;
  }

  reviewLoop(id: string, opts: ReviewLoopOptions): WorkflowBuilder {
    this.assertUniqueId(id);
    const expansion = expandReviewLoop(id, opts);
    return this.spliceExpansion(expansion);
  }

  council(id: string, opts: CouncilOptions): WorkflowBuilder {
    this.assertUniqueId(id);
    const expansion = expandCouncil(id, opts);
    return this.spliceExpansion(expansion);
  }

  reviewFix(id: string, opts: ReviewFixOptions): WorkflowBuilder {
    this.assertUniqueId(id);
    const expansion = expandReviewFix(id, opts);
    return this.spliceExpansion(expansion);
  }

  profile(name: string, config: Record<string, unknown>): WorkflowBuilder {
    if (this.profileNames.has(name)) {
      throw new Error(`Duplicate profile name "${name}": profile already exists.`);
    }
    this.profileNames.add(name);
    this.state.inlineProfiles.set(name, config);
    return this;
  }

  toIR(): GraphIR {
    const nodes: IRNode[] = this.state.nodes.map((bn) => serializeNode(bn));
    const edges: IREdge[] = this.state.edges.map((e) => ({ ...e }));
    const conditions: IRCondition[] = this.state.conditions.map((bc) => ({
      id: bc.id,
      on: bc.on,
      expr: serializeFn(bc.fn.fn, bc.fn.kind),
    }));
    const schemas: Record<string, unknown> = {};
    const primitives: Record<string, PrimitiveMeta> = {};
    for (const node of nodes) {
      if (node.outputSchema !== undefined) schemas[node.id] = node.outputSchema;
      if (node.primitive) primitives[node.id] = { ...node.primitive };
    }
    // Serialize inline profiles (registered via `.profile(name, {...})`) into a
    // plain Record keyed by name. The loosely-typed config is normalised to a
    // WispProfile (agentType defaults to "pi") via the shared inlineProfile helper.
    const inlineProfiles: Record<string, WispProfile> = {};
    for (const [name, config] of this.state.inlineProfiles) {
      inlineProfiles[name] = inlineProfile({ name, ...(config as Partial<WispProfile>) });
    }
    return {
      title: this.state.title,
      slug: this.state.slug,
      options: { ...this.state.options },
      nodes,
      edges,
      conditions,
      schemas,
      primitives,
      inlineProfiles,
    };
  }
}

// ─── wf entry point ───────────────────────────────────────────────

/**
 * Create a new workflow builder.
 *
 * @param name    The workflow name (slug derived via kebab-case; an explicit
 *                `options.title` overrides both the stored title and slug).
 * @param options Optional maxConcurrency, defaultRetries, title override.
 * @returns A {@link WorkflowBuilder} for chaining.
 */
export function wf(name: string, options?: WfOptions): WorkflowBuilder {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("wf(name): name must be a non-empty string.");
  }
  return new WorkflowBuilderImpl(name, options);
}

// re-export the descriptor type for downstream consumers
export type { FnDescriptor };
