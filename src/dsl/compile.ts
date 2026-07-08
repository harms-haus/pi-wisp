// ═══════════════════════════════════════════════════════════════════════════
// DSL compile — tsx subprocess orchestration (S16, ⚠️ RISK).
//
// Orchestrates the Layer-1 compile step:
//   1. Read the user's workflow source (from `scriptPath` or `scriptSource`).
//   2. Rewrite `from "pi-wisp"` → `from "<file:// builderPath>"` (the tsx
//      subprocess cannot resolve the package by name; see WEB_RESEARCH §2a).
//   3. Write the rewritten source to a temp `.ts` in the script's directory
//      (preserves relative imports).
//   4. Spawn `node --import tsx --no-warnings <harnessPath> <tempScript>`.
//   5. Capture stdout (the IR JSON) + stderr + exit code.
//   6. Classify failures into structured {@link WispError}s.
//   7. On success, parse stdout → {@link GraphIR} and run `validateIR` (S13).
//
// Exports:
//   compileWorkflow(input) — the main compile entrypoint
//   rewriteImport(source)  — the import specifier rewriter (testable in isolation)
// ═══════════════════════════════════════════════════════════════════════════

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { GraphIR, WispError } from "../types.js";
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

// ─── Import-rewrite helper ─────────────────────────────────────────

/**
 * Rewrite `from "pi-wisp"` (and all variants) to a `file://` URL pointing at
 * the shipped builder.
 *
 * The tsx subprocess runs the user's workflow script under the user's project
 * cwd, where `pi-wisp` is NOT resolvable as a package (it is a sibling
 * extension, not an installed dependency). `NODE_PATH` does not work for ESM
 * and editing the user's tsconfig `paths` is not viable, so the most robust
 * fix is to rewrite the bare specifier in-place to an absolute `file://` URL
 * of the shipped builder module (whose absolute path is known at extension
 * registration time; see `src/index.ts`).
 *
 * Handles both quote styles and all four import forms:
 *   default import:    `import wf from "pi-wisp"`
 *   named import:      `import { wf } from "pi-wisp"`
 *   namespace import:  `import * as wisp from "pi-wisp"`
 *   dynamic import:    `import("pi-wisp")`
 *
 * The rewriter anchors on REAL import positions only — a `from <quote>` or
 * `import(<quote>` immediately followed by the `pi-wisp` specifier — so
 * `pi-wisp` appearing inside comments or a non-import string literal (e.g.
 * `const pkg = "pi-wisp"`) is NEVER touched. Subpath specifiers
 * (`pi-wisp/macros`, `pi-wisp/sub`) are likewise rewritten wholesale to
 * `builderUrl`: the shipped builder resolves the entire module regardless of
 * the requested subpath. The matched specifier (including any subpath) is
 * replaced with `builderUrl`, preserving the original quote style and the
 * surrounding `from` / `import(` / `)` syntax. When the source contains no
 * `pi-wisp` import it is returned unchanged.
 *
 * @param source     - The raw workflow script source text.
 * @param builderUrl - The absolute `file://` URL of the shipped builder.ts
 *                     (e.g. `pathToFileURL(builderPath).href`).
 * @returns The source with every `pi-wisp` specifier rewritten.
 */
export function rewriteImport(source: string, builderUrl: string): string {
  // Anchor on REAL import positions so `pi-wisp` inside comments or a
  // non-import string literal is never rewritten. Two forms:
  //   static  — `from <quote>pi-wisp[/sub]<quote>`
  //   dynamic — `import(<quote>pi-wisp[/sub]<quote>)`
  // The opening quote is captured (group 2) and back-referenced so the closing
  // quote matches; the `from\s*` / `import(\s*` prefix (group 1) and the
  // dynamic `\s*)` suffix (group 3) are captured and re-emitted to preserve
  // surrounding whitespace exactly. A subpath (`pi-wisp/macros`) is part of the
  // matched specifier and is replaced wholesale with `builderUrl`.
  const staticRe = /(from\s*)(["'`])pi-wisp[^"'`\n]*\2/g;
  const dynamicRe = /(import\s*\(\s*)(["'`])pi-wisp[^"'`\n]*\2(\s*\))/g;
  return source
    .replace(
      staticRe,
      (_match, prefix: string, quote: string) => `${prefix}${quote}${builderUrl}${quote}`,
    )
    .replace(
      dynamicRe,
      (_match, prefix: string, quote: string, suffix: string) =>
        `${prefix}${quote}${builderUrl}${quote}${suffix}`,
    );
}

// ─── Error classification ──────────────────────────────────────────

interface Classified {
  kind: "compile" | "runtime";
  message: string;
  location?: string;
}

/**
 * Extract a location string (`<file>:<line>:<col>`) from a regex match that
 * captured the three components in groups 1–3, or `undefined` when any group
 * is absent.
 */
function locationFromMatch(match: RegExpMatchArray | null): string | undefined {
  if (match && match[1] && match[2] && match[3]) {
    return `${match[1]}:${match[2]}:${match[3]}`;
  }
  return undefined;
}

/**
 * (1) esbuild transform error: a line of the form
 * `<path>:<line>:<col>: ERROR: <message>`. Returns `undefined` when stderr
 * carries no such line.
 */
function matchEsbuildError(stderr: string): Classified | undefined {
  const esbuildLine = stderr.split("\n").find((line) => /:\d+:\d+:\s*ERROR:/.test(line));
  if (esbuildLine === undefined) return undefined;
  const match = esbuildLine.match(/^(.+?):(\d+):(\d+):\s*ERROR:\s*(.+)$/);
  if (match && match[1] && match[2] && match[3] && match[4]) {
    return {
      kind: "compile",
      message: match[4],
      location: `${match[1]}:${match[2]}:${match[3]}`,
    };
  }
  return { kind: "compile", message: esbuildLine };
}

/**
 * (2) Other recognised compile markers (`Transform failed with N error`,
 * `✘ [ERROR]`, `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, `error TSxxxx`). Returns
 * `undefined` when none are present.
 */
function matchCompileMarker(stderr: string): Classified | undefined {
  const markerRe =
    /Transform failed with \d+ error|✘\s*\[ERROR\]|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|\berror TS\d+/i;
  // Use the FIRST diagnostic line carrying a recognised compile marker as the
  // message (instead of a generic 'Failed to compile the workflow script.') and
  // scope the location search to that same line, so an unrelated file:line:col
  // elsewhere in stderr is not surfaced.
  const markerLine = stderr.split("\n").find((line) => markerRe.test(line));
  if (markerLine === undefined) return undefined;
  const location = locationFromMatch(markerLine.match(/^(.+?):(\d+):(\d+)/));
  return {
    kind: "compile",
    message: markerLine.trim(),
    ...(location !== undefined ? { location } : {}),
  };
}

/**
 * (3) Runtime exception: a line `<ErrorType>: <message>` (e.g. `Error: …`,
 * `TypeError: …`, `ReferenceError: …`). The bare words `Error` and `Exception`
 * are matched explicitly — a plain `throw new Error(...)` surfaces as
 * `Error: <msg>`, which the prefixed `[A-Z]\w*(?:Error|Exception)` branch alone
 * would miss. Returns `undefined` when no such line is present.
 */
function matchRuntimeError(stderr: string): Classified | undefined {
  const runtimeMatch = stderr.match(/^\s*([A-Z]\w*(?:Error|Exception)|Error|Exception):\s*(.+)$/m);
  if (!runtimeMatch) return undefined;
  const messagePart = runtimeMatch[2] ?? "Runtime error during module evaluation.";
  const stackLoc = stderr.match(/at [^\n]*\((.+?):(\d+):(\d+)\)/);
  return {
    kind: "runtime",
    message: messagePart,
    ...(locationFromMatch(stackLoc) ? { location: locationFromMatch(stackLoc) } : {}),
  };
}

/** (4) Generic fallback for unrecognised / empty stderr. */
function genericFallback(stderr: string, exitCode: number | null): Classified {
  const firstLine = stderr.trim().split("\n")[0];
  if (firstLine) {
    return { kind: "compile", message: `Workflow script execution failed: ${firstLine}` };
  }
  return {
    kind: "compile",
    message: `Workflow script exited with code ${exitCode ?? "null"} and produced no diagnostic output.`,
  };
}

/**
 * Classify captured subprocess stderr into a structured compile/runtime error.
 *
 * Heuristics are checked in order (WEB_RESEARCH §2a): esbuild transform errors
 * first (1), then other compile markers (2), then runtime exceptions (3), then
 * a generic fallback (4). esbuild markers precede runtime markers because a
 * syntax error surfaces as an `Error: Transform failed …` wrapper that would
 * otherwise match the runtime `<ErrorType>: <message>` pattern.
 */
function classifyStderr(stderr: string, exitCode: number | null): Classified {
  return (
    matchEsbuildError(stderr) ??
    matchCompileMarker(stderr) ??
    matchRuntimeError(stderr) ??
    genericFallback(stderr, exitCode)
  );
}

// ─── Subprocess runner ─────────────────────────────────────────────

interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Spawn a node subprocess, accumulate stdout/stderr, and resolve on close with
 * the captured buffers + exit code + a timeout flag.
 *
 * A {@link COMPILE_TIMEOUT_MS} guard aborts the child via the spawn `signal`
 * option (Node 22 kills the direct child on abort); the resulting close/error
 * event is resolved with `timedOut: true`.
 */
function runSubprocess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    // `const`: the timer is set once and cleared from `finish`. `finish` is
    // only ever invoked from async callbacks that fire after this synchronous
    // body completes, so the const is always initialised before use.
    const timer = setTimeout(() => {
      ac.abort();
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: SubprocessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args, {
        // A compile subprocess must NOT outlive the host: keep it in the
        // parent's process group (no `detached: true`) so it is reaped with
        // the extension host; the AbortSignal below still enforces the timeout.
        stdio: ["pipe", "pipe", "pipe"],
        signal: ac.signal,
      });
    } catch (error) {
      finish({
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}spawn failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        exitCode: null,
        timedOut: false,
      });
      return;
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err: Error) => {
      // On abort the signal emits an AbortError here; otherwise it's a spawn
      // failure (e.g. ENOENT).
      finish({
        stdout,
        stderr: ac.signal.aborted ? stderr : `${stderr}${stderr ? "\n" : ""}${err.message}`,
        exitCode: null,
        timedOut: ac.signal.aborted,
      });
    });

    proc.on("close", (code: number | null) => {
      finish({ stdout, stderr, exitCode: code, timedOut: ac.signal.aborted });
    });
  });
}

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
