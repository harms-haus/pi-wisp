/**
 * Engine — Synthesis (S30 / PLAN.md §7.3).
 *
 * Handles reduce/merge nodes:
 *   - WITH profile + agent → agent-run synthesis: builds a merge prompt
 *     that uses ctx.output() for each member id in `from`, invokes the
 *     adapter, and returns the synthesized output.
 *   - WITHOUT profile → pure-JS merge: rehydrates the merge fn and calls it.
 *
 * Member outputs are accessed via `ctx.output(from[i])` regardless of whether
 * the reduce originated from a council macro or a manual reduce — the `from`
 * array already holds the fully-qualified node ids.
 *
 * @module
 */

import type { NodeCtx, NormalizedEvent, WispError } from "../types.js";
import type { AgentAdapter } from "../adapters/types.js";
import { DEFAULT_AGENT_TYPE } from "../constants.js";
import { finalTextFromEvents, invokeAdapter } from "./events.js";

// ─── Public types ─────────────────────────────────────────────────

/** Options for {@link executeSynthesis}. */
export interface SynthesisOptions {
  /** Context with access to member outputs. */
  ctx: NodeCtx;
  /**
   * The member node ids being merged.
   *
   * Each id is accessed directly via `ctx.output(nodeId)` — the `from` array
   * already holds the fully-qualified node ids (e.g. `"council1:member:0"`).
   * This avoids the suffix-search collision that `ctx.member(i)` would have
   * when multiple councils exist.
   */
  from: string[];
  /**
   * Adapter for agent-run synthesis. When provided, a merge prompt is built
   * referencing all member outputs and dispatched to the agent. The agent's
   * output becomes the synthesized result. When absent, pure-JS merge is used.
   */
  adapter?: AgentAdapter;
  /** Optional abort signal for the agent run. */
  signal?: AbortSignal;
  /** Agent type identifier (passed to buildInvocation; default "pi"). */
  agentType?: string;
  /**
   * Custom instruction prompt from the council's synthesize spec.
   * When set, it is prepended to (or replaces the generic header of) the
   * merge prompt sent to the synthesis agent.
   */
  instructionPrompt?: string;
}

/** Result of a synthesis step. */
export interface SynthesisResult {
  /** The synthesized output (parsed JSON or raw text). */
  output: unknown;
  /** Structured error when the synthesis fails (agent run fails, schema fails). */
  error?: WispError;
}

// ─── Implementation ──────────────────────────────────────────────

/**
 * Execute a synthesis (reduce / merge) step for a given set of member nodes.
 *
 * When `options.adapter` is provided, an agent-run synthesis is performed:
 * a merge prompt referencing all member outputs is built and dispatched to
 * the adapter. The adapter's output becomes the synthesized result.
 *
 * Without an adapter, a pure-JS merge is performed by gathering member
 * outputs into a merged result object (recursive deep-merge for plain objects,
 * last-writer-wins for scalars).
 *
 * Member outputs are accessed via `ctx.output(from[i])` regardless of whether
 * the reduce originated from a council macro or a manual reduce — the `from`
 * array already holds the fully-qualified node ids. This avoids the
 * suffix-search collision that `ctx.member(i)` would have when multiple
 * councils exist.
 *
 * @param options - Synthesis options (ctx, from, optional adapter).
 * @returns The synthesized output, or an error when the step fails.
 */
export async function executeSynthesis(options: SynthesisOptions): Promise<SynthesisResult> {
  const { ctx, from } = options;

  // ── Gather member outputs ─────────────────────────────────
  const outputs: unknown[] = [];
  let firstError: WispError | undefined;

  for (let i = 0; i < from.length; i++) {
    try {
      // Access each member by its fully-qualified node id from the `from`
      // array (e.g. "council1:member:0" or "member-0").
      const nodeId = from[i];
      if (nodeId === undefined) {
        firstError = {
          kind: "runtime",
          message: `from[${i}] is undefined in the from array.`,
        };
        break;
      }
      const output = ctx.output(nodeId);
      outputs.push(output);
    } catch (err) {
      // A missing / incomplete member is a runtime error.
      const memberId = from[i] ?? `from[${i}]`;
      firstError = {
        kind: "runtime",
        nodeId: memberId,
        message: err instanceof Error ? err.message : String(err),
      };
      break;
    }
  }

  // ── On first error, return it immediately ──────────────────
  if (firstError) {
    return { output: undefined, error: firstError };
  }

  // ── Agent-run or pure-JS merge ────────────────────────────
  if (options.adapter) {
    return runAgentSynthesis(options.adapter, options, outputs);
  }

  const merged = mergeOutputs(outputs);
  return { output: merged, error: undefined };
}

// ─── Merge helpers ───────────────────────────────────────────────

/**
 * Merge an array of member outputs into a single synthesized result.
 *
 * Strategy:
 *   1. If every output is a plain object, deep-merge them into one object
 *      (last-writer-wins for conflicting keys).
 *   2. Otherwise wrap all outputs into an object `{ merged, count }`.
 */
function mergeOutputs(outputs: unknown[]): unknown {
  if (outputs.length === 0) {
    return { merged: [], count: 0 };
  }

  const allObjects = outputs.every(
    (o) => o !== null && o !== undefined && typeof o === "object" && !Array.isArray(o),
  );

  if (allObjects) {
    // Recursive deep-merge: recurse when both values are plain objects
    // (last-writer-wins for non-object values). Unlike a shallow
    // Object.assign, this preserves nested keys from earlier members
    // whose sub-keys are not overwritten by later members.
    const merged: Record<string, unknown> = {};
    for (const obj of outputs) {
      deepMergeInto(merged, obj as Record<string, unknown>);
    }
    return merged;
  }

  // Mixed / scalar outputs: wrap into a container.
  return { merged: outputs, count: outputs.length };
}

/**
 * Recursively merge `source` properties into `target`.
 *
 * When both `target[key]` and `source[key]` are plain objects, the merge
 * recurses into the nested object. Otherwise `source[key]` overwrites
 * `target[key]` (last-writer-wins). The mutation is safe because `target` is
 * a freshly created accumulator, not a member-output object.
 */
function deepMergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    // Guard against prototype pollution via __proto__, constructor, or prototype.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      srcVal !== undefined &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      tgtVal !== undefined &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      deepMergeInto(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      target[key] = srcVal;
    }
  }
}

// ─── Agent-run synthesis ─────────────────────────────────────────

/**
 * Run an agent-run synthesis: build a merge prompt referencing all member
 * outputs, dispatch to the adapter (via emitEvents for fake adapters, or
 * buildInvocation+runAgent for real ones), and extract the agent's output.
 */
async function runAgentSynthesis(
  adapter: AgentAdapter,
  options: SynthesisOptions,
  outputs: unknown[],
): Promise<SynthesisResult> {
  const agentType = options.agentType ?? DEFAULT_AGENT_TYPE;

  // Build the merge prompt referencing each member output.
  // When an instructionPrompt is provided, it augments or replaces the
  // generic synthesis header (Gap 4 fix).
  const mergePrompt = buildMergePrompt(outputs, options.instructionPrompt);

  const events: NormalizedEvent[] = [];
  const onEvent = (event: NormalizedEvent | null): void => {
    if (event === null) return;
    events.push(event);
  };

  await invokeAdapter(adapter, {
    prompt: mergePrompt,
    nodeId: "synthesis",
    attempt: 1,
    signal: options.signal,
    onEvent,
    agentType,
  });

  // Extract final text from the event stream.
  const finalText = finalTextFromEvents(events);
  if (finalText.length === 0) {
    return {
      output: undefined,
      error: {
        kind: "runtime",
        message: "Agent synthesis produced no output text",
      },
    };
  }

  // Try to JSON-parse the agent's output.
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalText);
  } catch {
    // Return raw text when not valid JSON.
    return { output: finalText };
  }

  return { output: parsed };
}

/**
 * Build a merge prompt that includes all member outputs, asking the agent
 * to merge them into a single consolidated result.
 *
 * When an `instructionPrompt` is provided (from the council's synthesize
 * spec), it is inserted as a custom instruction block after the generic
 * header and before the member outputs, so the agent's behaviour can be
 * tailored per-council.
 */
function buildMergePrompt(outputs: unknown[], instructionPrompt?: string): string {
  const parts: string[] = [
    "You are a synthesis agent. Merge the following member outputs into a single",
    "consolidated result. Combine and reconcile the information from all members.",
    "",
  ];

  // Custom instruction from the council definition (Gap 4).
  if (instructionPrompt !== undefined && instructionPrompt.length > 0) {
    parts.push("--- Custom instructions ---");
    parts.push(instructionPrompt);
    parts.push("");
    parts.push("--- End of custom instructions ---");
    parts.push("");
  }

  parts.push("--- Member outputs ---");
  parts.push("");

  for (let i = 0; i < outputs.length; i++) {
    parts.push(`--- Member ${i} ---`);
    parts.push(formatOutputForPrompt(outputs[i]));
    parts.push("");
  }

  parts.push(
    "--- End of member outputs ---",
    "",
    "Return the consolidated result as a single JSON object with no text outside",
    "the object. If the members are prose or free-form text, combine and reconcile",
    'them into {"result": "<your consolidated text>"}. If the members are',
    "structured objects, merge their fields into one object (later members win on conflicts).",
  );

  return parts.join("\n");
}

/**
 * Format an output value for inclusion in a merge prompt.
 */
function formatOutputForPrompt(value: unknown): string {
  if (value === undefined || value === null) {
    return "(empty)";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // Fallback: the value is something JSON.stringify cannot handle
    // (circular reference, BigInt, etc.). Coerce to string via the Object
    // prototype's toString as a last-resort diagnostic.
    return Object.prototype.toString.call(value);
  }
}
