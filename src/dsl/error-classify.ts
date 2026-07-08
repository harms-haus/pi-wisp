// ═══════════════════════════════════════════════════════════════════════════
// DSL error-classify — classify captured subprocess stderr into a structured
// compile/runtime error.
//
// Extracted from compile.ts. Heuristics are checked in order
// (WEB_RESEARCH §2a): esbuild transform errors first (1), then other compile
// markers (2), then runtime exceptions (3), then a generic fallback (4).
// esbuild markers precede runtime markers because a syntax error surfaces as
// an `Error: Transform failed …` wrapper that would otherwise match the
// runtime `<ErrorType>: <message>` pattern.
// ═══════════════════════════════════════════════════════════════════════════

import { compact } from "../utils.js";

export interface Classified {
  kind: "compile" | "runtime";
  message: string;
  location?: string;
}

/**
 * Extract a location string (`<file>:<line>:<col>`) from a regex match that
 * captured the three components in groups 1–3, or `undefined` when any group
 * is absent.
 */
export function locationFromMatch(match: RegExpMatchArray | null): string | undefined {
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
export function matchEsbuildError(stderr: string): Classified | undefined {
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
export function matchCompileMarker(stderr: string): Classified | undefined {
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
    ...compact({ location }),
  };
}

/**
 * (3) Runtime exception: a line `<ErrorType>: <message>` (e.g. `Error: …`,
 * `TypeError: …`, `ReferenceError: …`). The bare words `Error` and `Exception`
 * are matched explicitly — a plain `throw new Error(...)` surfaces as
 * `Error: <msg>`, which the prefixed `[A-Z]\w*(?:Error|Exception)` branch alone
 * would miss. Returns `undefined` when no such line is present.
 */
export function matchRuntimeError(stderr: string): Classified | undefined {
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
export function genericFallback(stderr: string, exitCode: number | null): Classified {
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
export function classifyStderr(stderr: string, exitCode: number | null): Classified {
  return (
    matchEsbuildError(stderr) ??
    matchCompileMarker(stderr) ??
    matchRuntimeError(stderr) ??
    genericFallback(stderr, exitCode)
  );
}
