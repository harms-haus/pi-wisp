// ═══════════════════════════════════════════════════════════════════════════
// Module-split characterization — ir.ts decomposed into focused modules.
//
// The refactor moves cycle detection → cycle-detection.ts and validation →
// validate.ts, leaving ir.ts with ONLY the builder type definitions + `live`.
// These tests pin the resulting module boundary so the split is provably
// complete (nothing validation-related leaks out of ir.ts) and the public
// entry points land in their new homes.
//
// They are RED until validate.ts and cycle-detection.ts exist.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

// New focused modules (RED until they exist):
import { validateIR } from "../../dsl/validate.js";
import { detectCycles } from "../../dsl/cycle-detection.js";

// ir.ts must RETAIN the builder definitions + live():
import * as irModule from "../../dsl/ir.js";

// Cast the namespace to a string-keyed record so we can probe which symbols
// are / are not exported at runtime (the module's public surface).
const irExports = irModule as unknown as Record<string, unknown>;

// ─── ir.ts retains its builder role ───────────────────────────────

describe("module split — ir.ts retains builder definitions", () => {
  it("still exports `live` as a function", () => {
    expect(typeof irExports.live).toBe("function");
  });

  it("`live()` wraps a function + kind into a LiveFn", () => {
    const fn = (() => 1) as (...args: never[]) => unknown;
    const wrapped = irModule.live(fn, "prompt");
    expect(wrapped.fn).toBe(fn);
    expect(wrapped.kind).toBe("prompt");
  });
});

// ─── ir.ts gives up validation / cycle detection ──────────────────

describe("module split — ir.ts no longer owns validation or cycle detection", () => {
  it("does NOT export validateIR (moved to validate.ts)", () => {
    expect(irExports.validateIR).toBeUndefined();
  });

  it("does NOT export detectCycles (moved to cycle-detection.ts)", () => {
    expect(irExports.detectCycles).toBeUndefined();
  });
});

// ─── validate.ts owns validateIR ──────────────────────────────────

describe("module split — validate.ts owns validateIR", () => {
  it("exports validateIR as a function", () => {
    expect(typeof validateIR).toBe("function");
  });
});

// ─── cycle-detection.ts owns detectCycles ─────────────────────────

describe("module split — cycle-detection.ts owns detectCycles", () => {
  it("exports detectCycles as a function", () => {
    expect(typeof detectCycles).toBe("function");
  });
});
