// ═══════════════════════════════════════════════════════════════════════════
// DSL compile — tsx subprocess orchestration (S16, ⚠️ RISK).
//
// Orchestrates the Layer-1 compile step:
//   1. Read the user's workflow source (from `scriptPath` or `scriptSource`).
//   2. Rewrite `from "pi-wisp"` → `from "<file:// builderPath>"` via
//      {@link rewriteImport} (the tsx subprocess cannot resolve the package by
//      name; see WEB_RESEARCH §2a).
//   3. Write the rewritten source to a temp `.ts` in the script's directory
//      (preserves relative imports).
//   4. Spawn `node --import tsx --no-warnings <harnessPath> <tempScript>`
//      via {@link runSubprocess}.
//   5. Capture stdout (the IR JSON) + stderr + exit code.
//   6. Classify failures into structured {@link WispError}s via
//      {@link classifyStderr}.
//   7. On success, parse stdout → {@link GraphIR} and run `validateIR` (S13).
//
// The import-specifier rewriter, the stderr→structured-error classifier, and
// the subprocess runner live in their own focused modules (import-rewrite.ts,
// error-classify.ts, subprocess.ts); this module wires them into the compile
// pipeline.
//
// Exports:
//   compileWorkflow(input) — the main compile entrypoint
// ═══════════════════════════════════════════════════════════════════════════

import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { GraphIR, WispError } from "../types.js";
import { classifyStderr, genericFallback } from "./error-classify.js";
import { rewriteImport } from "./import-rewrite.js";
import { runSubprocess } from "./subprocess.js";
import type { SubprocessResult } from "./subprocess.js";
import { validateIR } from "./validate.js";

// ─── Input shape ───────────────────────────────────────────────────

export interface CompileInput {
  /** Workflow source text (alternative to scriptPath — writes to a temp file). */
  scriptSource?: string;
  /** Path to the workflow script (alternative to scriptSource). */
  scriptPath?: string;
  /** Absolute path to the shipped builder.ts (for import rewriting). */
  builderPath: string;
  /** Absolute path to the shipped compile-harness.ts (tsx entrypoint). */
  harnessPath: string;
}

// ─── Result shape ──────────────────────────────────────────────────

export type CompileResult = { ir: GraphIR } | { error: WispError };

/** Hard cap on a single compile subprocess (matches PLAN S16 / WEB §2a). */
const COMPILE_TIMEOUT_MS = 30_000;

// ─── Input + source helpers ────────────────────────────────────────

/** Read the workflow source + the directory to place the temp file in, or a structured error. */
type ReadSourceResult = { source: string; originDir: string } | { error: WispError };

function readWorkflowSource(input: CompileInput): ReadSourceResult {
  if (input.scriptSource !== undefined) {
    // Inline source has no filesystem context — use the OS tmpdir.
    return { source: input.scriptSource, originDir: tmpdir() };
  }
  if (input.scriptPath !== undefined) {
    // Write the temp file next to the original so relative imports resolve.
    try {
      return {
        source: readFileSync(input.scriptPath, "utf8"),
        originDir: dirname(input.scriptPath),
      };
    } catch (err) {
      // A missing script is a user-facing compile failure — surface it as a
      // structured error instead of letting the raw ENOENT reject the promise.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        return {
          error: { kind: "compile", message: `Workflow script not found: ${input.scriptPath}` },
        };
      }
      throw err;
    }
  }
  // Unreachable: validateCompileInput rejects when both are absent.
  throw new Error("compileWorkflow: either scriptPath or scriptSource must be provided.");
}

/** Parse the captured stdout into a validated GraphIR, or a structured error. */
function parseAndValidate(stdout: string): CompileResult {
  let ir: GraphIR;
  try {
    ir = JSON.parse(stdout) as GraphIR;
  } catch {
    return {
      error: {
        kind: "compile",
        message: "The workflow compiled but produced output that could not be parsed as JSON.",
      },
    };
  }

  const errors = validateIR(ir);
  if (errors.length > 0) {
    const validationError: WispError = {
      kind: "validation",
      message: `Workflow validation failed with ${errors.length} error${
        errors.length === 1 ? "" : "s"
      }.`,
      errors,
    };
    return { error: validationError };
  }

  return { ir };
}

/** Map a finished subprocess result into a {@link CompileResult}. */
function resultFromSubprocess(result: SubprocessResult): CompileResult {
  if (result.timedOut) {
    return {
      error: {
        kind: "compile",
        message: `Workflow compilation timed out after ${COMPILE_TIMEOUT_MS / 1000}s.`,
      },
    };
  }

  if (result.exitCode !== 0) {
    const classified =
      result.stderr.trim().length > 0
        ? classifyStderr(result.stderr, result.exitCode)
        : genericFallback(result.stderr, result.exitCode);
    const error: WispError = {
      kind: classified.kind,
      message: classified.message,
      ...(classified.location !== undefined ? { location: classified.location } : {}),
    };
    return { error };
  }

  return parseAndValidate(result.stdout);
}

// ─── Main compile entrypoint ───────────────────────────────────────

/** Throw synchronously when the {@link CompileInput} is structurally invalid. */
function validateCompileInput(input: CompileInput): void {
  if (!input.builderPath || input.builderPath.trim() === "") {
    throw new Error("compileWorkflow: builderPath is required and must be non-empty.");
  }
  if (!input.harnessPath || input.harnessPath.trim() === "") {
    throw new Error("compileWorkflow: harnessPath is required and must be non-empty.");
  }
  if (input.scriptPath === undefined && input.scriptSource === undefined) {
    throw new Error("compileWorkflow: either scriptPath or scriptSource must be provided.");
  }
}

/**
 * Compile a workflow script into a validated {@link GraphIR}.
 *
 * Steps (from PLAN.md S16 / WEB_RESEARCH §2a):
 * 1. Validate inputs (builderPath / harnessPath non-empty; one of
 *    scriptPath / scriptSource provided) — throws synchronously on bad input.
 * 2. Read the workflow source (from `scriptPath` or `scriptSource`).
 * 3. Rewrite `from "pi-wisp"` → `from "<file:// builderPath>"` via
 *    {@link rewriteImport}.
 * 4. Write the rewritten source to a temp `.ts` in the script's directory
 *    (so relative imports still resolve); cleaned up in `finally`.
 * 5. Spawn `node --import tsx --no-warnings <harnessPath> <tempScript>`.
 * 6. On timeout → `{ kind: "compile" }`. On non-zero exit → classify stderr
 *    (compile ∘ runtime). On unparseable stdout → `{ kind: "compile" }`.
 * 7. On success, parse stdout → {@link GraphIR} and run `validateIR` (S13);
 *    validation failures → `{ kind: "validation", errors }`.
 *
 * @returns `{ ir }` on success, or `{ error: WispError }` on a classified
 *          compile/validation/runtime failure.
 * @throws  on invalid `CompileInput` (missing/empty builderPath, harnessPath,
 *          or both scriptPath and scriptSource).
 */
export async function compileWorkflow(input: CompileInput): Promise<CompileResult> {
  validateCompileInput(input);

  // Enforce absolute builder/harness paths → a structured compile error rather
  // than an opaque downstream spawn / module-resolution ENOENT. (Empty/blank
  // paths are still a structural invalidity and throw synchronously in
  // validateCompileInput above; a non-empty relative path is a user-facing
  // compile failure surfaced as a structured result.)
  if (!isAbsolute(input.builderPath)) {
    return {
      error: { kind: "compile", message: "compileWorkflow: builderPath must be absolute." },
    };
  }
  if (!isAbsolute(input.harnessPath)) {
    return {
      error: { kind: "compile", message: "compileWorkflow: harnessPath must be absolute." },
    };
  }

  const read = readWorkflowSource(input);
  if ("error" in read) {
    return { error: read.error };
  }
  const { source, originDir } = read;

  // Rewrite the bare `pi-wisp` specifier to an absolute file:// URL.
  const builderUrl = pathToFileURL(input.builderPath).href;
  const rewritten = rewriteImport(source, builderUrl);

  // Write the rewritten source to a temp .ts file (same dir → relative imports).
  const tempScriptPath = join(originDir, `.wisp-compile-${randomBytes(8).toString("hex")}.ts`);
  writeFileSync(tempScriptPath, rewritten, "utf8");

  try {
    const result = await runSubprocess(
      process.execPath,
      ["--import", "tsx", "--no-warnings", input.harnessPath, tempScriptPath],
      COMPILE_TIMEOUT_MS,
    );
    return resultFromSubprocess(result);
  } finally {
    // Best-effort cleanup of the temp script.
    try {
      unlinkSync(tempScriptPath);
    } catch {
      // Already removed or inaccessible — ignore.
    }
  }
}
