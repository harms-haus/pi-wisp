// ═══════════════════════════════════════════════════════════════════════════
// Module-split boundary — compile.ts decomposed into focused modules.
//
// The refactor extracts three concerns out of compile.ts:
//   rewriteImport                 → import-rewrite.ts
//   Classified + classifyStderr + → error-classify.ts
//     locationFromMatch/match*/genericFallback
//   SubprocessResult + runSubprocess → subprocess.ts
//
// compile.ts RETAINS: CompileInput, CompileResult, COMPILE_TIMEOUT_MS,
//   validateCompileInput, readWorkflowSource, parseAndValidate,
//   resultFromSubprocess, compileWorkflow.
//
// These tests pin the resulting module boundary so the split is provably
// complete: the moved symbols land in their new homes, compile.ts keeps its
// public entrypoint, and the exported rewriter no longer leaks out of
// compile.ts (it was the only currently-exported mover).
//
// They are RED until the three new modules exist. (Mirrors the precedent set
// by ir-module-split.test.ts for the ir.ts → validate.ts/cycle-detection.ts
// split.)
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

// New focused modules (RED until they exist):
import { rewriteImport } from "../../dsl/import-rewrite.js";
import { classifyStderr } from "../../dsl/error-classify.js";
import { runSubprocess } from "../../dsl/subprocess.js";
import type { SubprocessResult } from "../../dsl/subprocess.js";

// compile.ts must RETAIN the public entrypoint + its I/O types:
import { compileWorkflow } from "../../dsl/compile.js";
import type { CompileInput, CompileResult } from "../../dsl/compile.js";
import type { GraphIR } from "../../types.js";
import * as compileModule from "../../dsl/compile.js";

// Cast the namespace to a string-keyed record so we can probe which symbols
// are / are not exported at runtime (the module's public surface).
const compileExports = compileModule as unknown as Record<string, unknown>;

// ─── import-rewrite.ts owns rewriteImport ──────────────────────────

describe("module split — import-rewrite.ts owns rewriteImport", () => {
  it("exports rewriteImport as a function", () => {
    expect(typeof rewriteImport).toBe("function");
  });

  it("rewrites a pi-wisp import to the builder URL (behavior intact in the new home)", () => {
    const out = rewriteImport(`import { wf } from "pi-wisp";`, "file:///b.ts");
    expect(out).toBe(`import { wf } from "file:///b.ts";`);
  });
});

// ─── error-classify.ts owns classifyStderr ─────────────────────────

describe("module split — error-classify.ts owns classifyStderr", () => {
  it("exports classifyStderr as a function", () => {
    expect(typeof classifyStderr).toBe("function");
  });

  it("classifies an esbuild line (behavior intact in the new home)", () => {
    const result = classifyStderr("/a.ts:1:2: ERROR: boom\n", 1);
    expect(result).toEqual({
      kind: "compile",
      message: "boom",
      location: "/a.ts:1:2",
    });
  });
});

// ─── subprocess.ts owns runSubprocess ──────────────────────────────

describe("module split — subprocess.ts owns runSubprocess", () => {
  it("exports runSubprocess as a function", () => {
    expect(typeof runSubprocess).toBe("function");
  });

  it("exports the SubprocessResult type with its captured-fields shape", () => {
    // If SubprocessResult is exported from the new module AND retains its shape,
    // this assignment type-checks. (A behavioral mirror of the moved interface.)
    const sample = { stdout: "out", stderr: "err", exitCode: 0, timedOut: false };
    const checked: SubprocessResult = sample;
    expect(checked.stdout).toBe("out");
    expect(checked.timedOut).toBe(false);
  });
});

// ─── compile.ts retains its public entrypoint ─────────────────────

describe("module split — compile.ts retains compileWorkflow + I/O types", () => {
  it("still exports compileWorkflow as a function", () => {
    expect(typeof compileExports.compileWorkflow).toBe("function");
    expect(typeof compileWorkflow).toBe("function");
  });

  it("still exports the CompileInput / CompileResult types", () => {
    // Structural usage: the types must still be importable and shaped right.
    const input: CompileInput = {
      builderPath: "/abs/builder.ts",
      harnessPath: "/abs/harness.ts",
      scriptSource: "export default 1",
    };
    expect(input.scriptSource).toBe("export default 1");

    const ok: CompileResult = { ir: { title: "t", slug: "t" } as GraphIR };
    expect(ok).toHaveProperty("ir");
  });
});

// ─── compile.ts gives up the moved rewriter ───────────────────────

describe("module split — compile.ts no longer owns rewriteImport", () => {
  // rewriteImport was the ONLY currently-exported symbol among the movers
  // (classifyStderr / runSubprocess were already module-private). Asserting
  // it leaves compile.ts enforces the task's "keep in compile.ts" list, which
  // excludes rewriteImport.
  it("does NOT export rewriteImport (moved to import-rewrite.ts)", () => {
    expect(compileExports.rewriteImport).toBeUndefined();
  });
});
