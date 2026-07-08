// ═══════════════════════════════════════════════════════════════════════════
// In-memory builder IR (S11).
//
// This module defines the mutable builder IR used during DSL construction:
// the live function reference ({@link LiveFn}), the builder node/condition/IR
// shapes, and the `live()` wrapper. Validation (S13) lives in `validate.ts`
// and cycle detection in `cycle-detection.ts`; the serializable {@link GraphIR}
// is produced by `toIR()` and defined in `../types.js`.
// ═══════════════════════════════════════════════════════════════════════════

import type { FnKind, IREdge, IRNodeBase, NodeSpec } from "../types.js";

// ─── Builder IR (mutable in-memory shape during DSL construction) ──

/**
 * A live (un-serialized) function reference held by the builder IR during DSL
 * construction. At `toIR()` time each {@link LiveFn} is converted to a
 * transportable `FnDescriptor` via `serializeFn` (S17). Holding the live
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
 * The builder-internal analogue of `IRCondition`: holds the predicate as
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
