// ═══════════════════════════════════════════════════════════════════════════
// TUI format helpers — tests (kb-18 / PLAN S32).
//
// Tests every public export of src/tui/format.ts:
//   statusGlyph, stageLabel, formatTime, formatToolCount, formatFiles,
//   poolUsageString
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import type { NodeState, PoolUsage } from "../../types.js";
import type { PrimitiveMeta } from "../../types.js";

// ── Module under test ──────────────────────────────────────────
import {
  statusGlyph,
  stageLabel,
  formatTime,
  formatToolCount,
  formatFiles,
  poolUsageString,
} from "../../tui/format.js";

// ══════════════════════════════════════════════════════════════════════════
// statusGlyph — maps NodeState → display glyph
// ══════════════════════════════════════════════════════════════════════════

describe("statusGlyph", () => {
  it('returns "✓" for completed', () => {
    expect(statusGlyph("completed")).toBe("✓");
  });

  it('returns "⏳" for running', () => {
    expect(statusGlyph("running")).toBe("⏳");
  });

  it('returns "✗" for failed', () => {
    expect(statusGlyph("failed")).toBe("✗");
  });

  it('returns "○" for pending (dep-not-met)', () => {
    expect(statusGlyph("pending")).toBe("○");
  });

  it('returns "·" for ready (queued for scheduling)', () => {
    // ready is distinct from pending: pending renders as hollow circle,
    // ready as middle dot, giving a visual cue about queue depth.
    expect(statusGlyph("ready")).toBe("·");
  });

  it('returns "◇" for skipped', () => {
    expect(statusGlyph("skipped")).toBe("◇");
  });

  it("returns ? for unknown state", () => {
    // Exhaustive switch guards: any unrecognised value maps to "?".
    expect(statusGlyph("bogus" as NodeState)).toBe("?");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// stageLabel — derives a human-readable stage string from primitive meta
// ══════════════════════════════════════════════════════════════════════════

/**
 * Helper to build a minimal node-like object that stageLabel accepts.
 */
function nodeWith(primitive?: PrimitiveMeta, stageOverride?: string) {
  return { primitive, stage: stageOverride };
}

describe("stageLabel", () => {
  it('defaults to "do-work" when no primitive metadata and no override', () => {
    expect(stageLabel(nodeWith())).toBe("do-work");
  });

  it('returns "do-work" for a plain node (primitive.kind === "node")', () => {
    expect(stageLabel(nodeWith({ kind: "node" }))).toBe("do-work");
  });

  it('returns "review" for a review-loop gate node', () => {
    // The gate node inside a reviewLoop has primitive kind "reviewLoop-gate".
    expect(stageLabel(nodeWith({ kind: "reviewLoop-gate" }))).toBe("review");
  });

  it('returns "review" when primitive kind is "reviewLoop" and meta indicates gate role', () => {
    // Some implementations encode the gate role in meta.role.
    expect(stageLabel(nodeWith({ kind: "reviewLoop", meta: { role: "gate" } }))).toBe("review");
  });

  it('returns "council-synthesis" for a council synthesize node', () => {
    expect(stageLabel(nodeWith({ kind: "council-synthesis" }))).toBe("council-synthesis");
  });

  it('returns "council-synthesis" when primitive kind is "council" and meta indicates synthesis', () => {
    expect(stageLabel(nodeWith({ kind: "council", meta: { role: "synthesize" } }))).toBe(
      "council-synthesis",
    );
  });

  it('returns "merge" for a review-fix merge node', () => {
    expect(stageLabel(nodeWith({ kind: "reviewFix-merge" }))).toBe("merge");
  });

  it('returns "merge" when primitive kind is "reviewFix" and meta indicates merge', () => {
    expect(stageLabel(nodeWith({ kind: "reviewFix", meta: { role: "merge" } }))).toBe("merge");
  });

  it("uses per-node stage override when provided", () => {
    expect(stageLabel(nodeWith({ kind: "node" }, "custom-stage"))).toBe("custom-stage");
  });

  it("treats empty-string stage override as absent (falls back)", () => {
    expect(stageLabel(nodeWith({ kind: "reviewLoop-gate" }, ""))).toBe("review");
  });

  it('returns "do-work" for a review-loop worker node', () => {
    // The worker inside a reviewLoop has primitive kind "reviewLoopWorker".
    expect(stageLabel(nodeWith({ kind: "reviewLoopWorker" }))).toBe("do-work");
  });

  it('falls back to "do-work" for an unknown primitive kind', () => {
    // An unrecognised kind gracefully defaults (same as missing primitive).
    expect(stageLabel(nodeWith({ kind: "custom-macro" }))).toBe("do-work");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// formatTime — milliseconds → human-readable time string
// ══════════════════════════════════════════════════════════════════════════

describe("formatTime", () => {
  it('formats 0ms as "0.0s"', () => {
    expect(formatTime(0)).toBe("0.0s");
  });

  it('formats 100ms as "0.1s"', () => {
    expect(formatTime(100)).toBe("0.1s");
  });

  it('formats 4200ms as "4.2s"', () => {
    expect(formatTime(4200)).toBe("4.2s");
  });

  it('formats 1100ms as "1.1s"', () => {
    expect(formatTime(1100)).toBe("1.1s");
  });

  it('formats 60000ms as "60.0s"', () => {
    expect(formatTime(60_000)).toBe("60.0s");
  });

  it("rounds to one decimal place", () => {
    expect(formatTime(123_456)).toBe("123.5s");
  });

  it("handles negative values as 0", () => {
    // Defensive — elapsed time should never be negative, but guard anyway.
    expect(formatTime(-1)).toBe("0.0s");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// formatToolCount — integer → "N tools" / "1 tool"
// ══════════════════════════════════════════════════════════════════════════

describe("formatToolCount", () => {
  it('returns "0 tools" for 0', () => {
    expect(formatToolCount(0)).toBe("0 tools");
  });

  it('returns "1 tool" for 1 (singular)', () => {
    expect(formatToolCount(1)).toBe("1 tool");
  });

  it('returns "11 tools" for 11 (plural)', () => {
    expect(formatToolCount(11)).toBe("11 tools");
  });

  it("handles large numbers", () => {
    expect(formatToolCount(999)).toBe("999 tools");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// formatFiles — file-edit array → display suffix
// ══════════════════════════════════════════════════════════════════════════

describe("formatFiles", () => {
  it("returns empty string for empty array", () => {
    expect(formatFiles([])).toBe("");
  });

  it('returns " · 1 file" for one file', () => {
    expect(formatFiles(["foo.ts"])).toBe(" · 1 file");
  });

  it('returns " · 2 files" for two files', () => {
    expect(formatFiles(["foo.ts", "bar.ts"])).toBe(" · 2 files");
  });

  it('returns " · 3 files" for three files', () => {
    expect(formatFiles(["a.ts", "b.ts", "c.ts"])).toBe(" · 3 files");
  });

  it("handles undefined/null gracefully (defensive)", () => {
    // The executor should always pass an array, but a defensive implementation
    // handles undefined.
    expect(formatFiles(undefined as any)).toBe("");
    expect(formatFiles(null as any)).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// poolUsageString — PoolUsage → footer string
// ══════════════════════════════════════════════════════════════════════════

/**
 * Build a PoolUsage for testing. All pools default to { used: 0, cap: 0 }
 * (meaning "not configured / never touched"). Shown pools are those whose
 * cap > 0 (they have a configured limit) or whose used > 0.
 */
function usage(overrides?: Partial<PoolUsage>): PoolUsage {
  return {
    global: { used: 0, cap: 0 },
    byAgentType: {},
    byProvider: {},
    byModel: {},
    ...overrides,
  };
}

describe("poolUsageString", () => {
  it("returns only the global pool when it is the only one with cap>0 or used>0", () => {
    const u = usage({ global: { used: 4, cap: 12 } });
    expect(poolUsageString(u)).toBe("global 4/12");
  });

  it("includes byAgentType pools with cap>0 or used>0 (prefixed with agent:)", () => {
    const u = usage({
      global: { used: 4, cap: 12 },
      byAgentType: { zai: { used: 5, cap: 7 } },
    });
    // The string should show "global 4/12 · agent:zai 5/7"
    expect(poolUsageString(u)).toBe("global 4/12 · agent:zai 5/7");
  });

  it("includes byProvider pools when busy (prefixed with provider:)", () => {
    const u = usage({
      global: { used: 4, cap: 12 },
      byProvider: { anthropic: { used: 3, cap: 5 } },
    });
    expect(poolUsageString(u)).toBe("global 4/12 · provider:anthropic 3/5");
  });

  it("includes byModel pools when busy (prefixed with model:)", () => {
    const u = usage({
      global: { used: 4, cap: 12 },
      byModel: { "anthropic/claude-sonnet-4-20250514": { used: 3, cap: 5 } },
    });
    expect(poolUsageString(u)).toBe("global 4/12 · model:anthropic/claude-sonnet-4-20250514 3/5");
  });

  it("only shows busy pools (omits pools with used=0 and cap=0)", () => {
    const u = usage({
      global: { used: 2, cap: 12 },
      byAgentType: { pi: { used: 0, cap: 0 } }, // not busy + no cap → hidden
      byProvider: { openai: { used: 0, cap: 10 } }, // not busy but has cap → shown? Or only busy?
      byModel: { "gpt-4": { used: 0, cap: 0 } }, // not busy + no cap → hidden
    });
    // The test is ambiguous — let's pin the contract: only pools where
    // cap > 0 OR used > 0 are shown. openai has cap=10 but used=0 → shown.
    const result = poolUsageString(u);
    expect(result).toContain("global 2/12");
    expect(result).toContain("openai 0/10");
    expect(result).not.toContain("pi");
    expect(result).not.toContain("gpt-4");
  });

  it("returns empty string when no pool has any configured cap or usage", () => {
    const u = usage(); // all zeros
    expect(poolUsageString(u)).toBe("");
  });

  it("separates multiple pools with · (middle dot) and prefixes non-global pools", () => {
    const u = usage({
      global: { used: 3, cap: 12 },
      byAgentType: { zai: { used: 2, cap: 5 }, pi: { used: 1, cap: 10 } },
    });
    const result = poolUsageString(u);
    // Must contain both agent-type pools (prefixed)
    expect(result).toContain("global 3/12");
    expect(result).toContain("agent:zai 2/5");
    expect(result).toContain("agent:pi 1/10");
    // Must use · as separator between each pool segment
    const segments = result.split(" · ");
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe("global 3/12");
  });
});
