// ═══════════════════════════════════════════════════════════════════════════
// TUI format helpers (PLAN S32 / kb-18).
//
// Pure formatting utilities consumed by the live widget (S33), the
// run_workflow renderers (S34), and the audit/TUI layer. No I/O, no side
// effects, no `any`.
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeState, PoolSlot, PoolUsage, PrimitiveMeta } from "../types.js";

// ─── Status glyphs ─────────────────────────────────────────────

/**
 * Map a NodeState to its display glyph:
 *   ✓ completed, ⏳ running, ✗ failed, ○ pending, · ready, ◇ skipped.
 *
 * `pending` (dep-not-met) renders as a hollow circle, `ready` (queued for
 * scheduling) as a middle dot, giving the user a visual cue about queue depth.
 *
 * Any unrecognised value maps to "?" so an exhaustive switch guards new states.
 */
export function statusGlyph(state: NodeState): string {
  switch (state) {
    case "completed":
      return "✓";
    case "running":
      return "⏳";
    case "failed":
      return "✗";
    case "pending":
      return "○";
    case "ready":
      return "·";
    case "skipped":
      return "◇";
    default:
      return "?";
  }
}

// ─── Stage labels ──────────────────────────────────────────────

/** Direct kind → stage lookup for simple (non-compound) cases. */
const STAGE_KIND: Record<string, string> = {
  "reviewLoop-gate": "review",
  reviewLoopWorker: "do-work",
  "council-synthesis": "council-synthesis",
  "reviewFix-merge": "merge",
};

/**
 * Derive a human-readable stage label from a node's primitive metadata and an
 * optional per-node stage override (PLAN §14).
 *
 * A non-empty per-node `stage` override always wins. Otherwise the stage is
 * derived from the macro provenance recorded in {@link PrimitiveMeta}:
 *
 *   plain node / "node"             → "do-work"
 *   review-loop gate                → "review"
 *   council synthesis               → "council-synthesis"
 *   review-fix merge                → "merge"
 *
 * @param node - Object with optional `primitive` and `stage` fields.
 * @returns The resolved stage label string.
 */
export function stageLabel(node: { primitive?: PrimitiveMeta; stage?: string }): string {
  if (node.stage) return node.stage;
  const kind = node.primitive?.kind;
  if (kind) {
    const direct = STAGE_KIND[kind];
    if (direct !== undefined) return direct;
  }
  const role = node.primitive?.meta?.role;
  if (kind === "reviewLoop" && role === "gate") return "review";
  if (kind === "council" && role === "synthesize") return "council-synthesis";
  if (kind === "reviewFix" && role === "merge") return "merge";
  return "do-work";
}

// ─── Time formatting ───────────────────────────────────────────

/**
 * Format milliseconds as a human-readable time string with one decimal place,
 * e.g. 4200 → "4.2s". Negative values are clamped to 0 defensively.
 */
export function formatTime(ms: number): string {
  const clamped = ms < 0 ? 0 : ms;
  return `${(clamped / 1000).toFixed(1)}s`;
}

// ─── Tool-count formatting ─────────────────────────────────────

/** Format a tool count with singular/plural, e.g. 1 → "1 tool", 11 → "11 tools". */
export function formatToolCount(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`;
}

// ─── File-count formatting ─────────────────────────────────────

/**
 * Format a list of edited files as a display suffix: empty → "", one →
 * " · 1 file", multiple → " · N files". Handles undefined/null defensively.
 */
export function formatFiles(files: string[] | undefined | null): string {
  if (!files || files.length === 0) return "";
  const n = files.length;
  return ` · ${n} file${n === 1 ? "" : "s"}`;
}

// ─── Pool-usage string ─────────────────────────────────────────

/** A pool slot is "shown" in the footer when it has a configured cap or is in use. */
function poolActive(slot: PoolSlot): boolean {
  return slot.cap > 0 || slot.used > 0;
}

/**
 * Format a PoolUsage snapshot into a compact footer string.
 *
 * Only pools with cap > 0 OR used > 0 are shown, in the order: global, then
 * byAgentType, byProvider, byModel (each preserving insertion order). Pools are
 * separated by " · " (middle dot). Non-global pools are prefixed with a short
 * category disambiguator to prevent key collisions (e.g. an agent type `zai`
 * and a provider `zai` would otherwise be ambiguous). When nothing is
 * configured/active, returns an empty string.
 *
 * @param usage - Current pool-usage snapshot from the scheduler.
 * @returns E.g. "global 4/12 · agent:zai 5/7 · provider:anthropic 3/5" or "".
 */
export function poolUsageString(usage: PoolUsage): string {
  const segments: string[] = [];
  const push = (label: string, slot: PoolSlot): void => {
    if (poolActive(slot)) segments.push(`${label} ${slot.used}/${slot.cap}`);
  };
  push("global", usage.global);
  for (const [key, slot] of Object.entries(usage.byAgentType)) push(`agent:${key}`, slot);
  for (const [key, slot] of Object.entries(usage.byProvider)) push(`provider:${key}`, slot);
  for (const [key, slot] of Object.entries(usage.byModel)) push(`model:${key}`, slot);
  return segments.join(" · ");
}
