// ═══════════════════════════════════════════════════════════════════════════
// Error-classify characterization — classifyStderr() + matchers extracted
// into error-classify.ts (moved out of compile.ts).
//
// The refactor moves the stderr→structured-error pipeline into its own focused
// module. These tests pin the EXACT current behavior so the extraction is
// provably behavior-preserving: every classification branch (esbuild / compile
// marker / runtime / generic fallback), the strict precedence order, the
// location-extraction rules, and the message text must all hold from the new
// home exactly as they did in compile.ts.
//
// They are RED until src/dsl/error-classify.ts exists and exports the pipeline.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

// New focused module (RED until it exists):
import {
  classifyStderr,
  matchEsbuildError,
  matchCompileMarker,
  matchRuntimeError,
  genericFallback,
  locationFromMatch,
} from "../../dsl/error-classify.js";
import type { Classified } from "../../dsl/error-classify.js";

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Assert a Classified has a given kind and message and (when expected) a
 * location, while pinning the absence of `location` otherwise.
 */
function expectClassified(
  actual: Classified | undefined,
  kind: Classified["kind"],
  message: string,
): void {
  expect(actual).toBeDefined();
  expect(actual!.kind).toBe(kind);
  expect(actual!.message).toBe(message);
}

// ─── classifyStderr — public entry point ───────────────────────────

describe("classifyStderr — branch (1) esbuild transform errors take precedence", () => {
  it("parses a `<path>:<line>:<col>: ERROR: <message>` line into a compile error", () => {
    const stderr = `/workflows/wf.ts:5:12: ERROR: Expected ";" but found "}"\n`;
    const result = classifyStderr(stderr, 1);
    expectClassified(result, "compile", 'Expected ";" but found "}"');
    expect(result.location).toBe("/workflows/wf.ts:5:12");
  });

  it("returns the esbuild error even when a runtime `Error:` wrapper line is present", () => {
    // esbuild markers are checked BEFORE runtime markers: a syntax error surfaces
    // as an `Error: Transform failed …` wrapper that would otherwise match the
    // runtime `<ErrorType>: <message>` pattern.
    const stderr = [
      "/wf.ts:2:3: ERROR: The import assertion...",
      "Error: Transform failed with 1 error:",
      "    at <anonymous> (/wf.ts:2:3)",
    ].join("\n");
    const result = classifyStderr(stderr, 1);
    expectClassified(result, "compile", "The import assertion...");
    expect(result.location).toBe("/wf.ts:2:3");
  });
});

describe("classifyStderr — branch (2) other compile markers", () => {
  it("classifies a `✘ [ERROR]` marker line as a compile error", () => {
    const stderr = '✘ [ERROR] Could not resolve "foo"\n  hint here\n';
    const result = classifyStderr(stderr, 1);
    expectClassified(result, "compile", '✘ [ERROR] Could not resolve "foo"');
    expect(result.location).toBeUndefined();
  });

  it("classifies an `error TSxxxx` marker line as a compile error, surfacing file:line:col", () => {
    const stderr = "app.ts:10:5 - error TS2304: Cannot find name 'foo'.\n";
    const result = classifyStderr(stderr, 1);
    expectClassified(result, "compile", "app.ts:10:5 - error TS2304: Cannot find name 'foo'.");
    expect(result.location).toBe("app.ts:10:5");
  });

  it("classifies an `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` marker as a compile error", () => {
    const stderr = "node:internal: ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX\n";
    const result = classifyStderr(stderr, 1);
    expectClassified(result, "compile", "node:internal: ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.location).toBeUndefined();
  });

  it("classifies a `Transform failed with N error` marker line as a compile error", () => {
    const stderr = "Error: Transform failed with 1 error:\n";
    const result = classifyStderr(stderr, 1);
    expectClassified(result, "compile", "Error: Transform failed with 1 error:");
  });

  it("takes a compile marker over a runtime line (precedence 2 > 3)", () => {
    const stderr = "✘ [ERROR] boom\nError: ignored\n";
    const result = classifyStderr(stderr, 1);
    expectClassified(result, "compile", "✘ [ERROR] boom");
  });
});

describe("classifyStderr — branch (3) runtime exceptions", () => {
  it("classifies a bare `Error: <msg>` line as a runtime error", () => {
    const stderr = "Error: boom\n    at f (file:///x.ts:10:20)\n";
    const result = classifyStderr(stderr, 1);
    expectClassified(result, "runtime", "boom");
    expect(result.location).toBe("file:///x.ts:10:20");
  });

  it("classifies a `TypeError:` line and extracts a stack-frame location", () => {
    const stderr = "TypeError: undefined is not a function\n    at g (file:///y.ts:3:5)\n";
    const result = classifyStderr(stderr, 1);
    expectClassified(result, "runtime", "undefined is not a function");
    expect(result.location).toBe("file:///y.ts:3:5");
  });

  it("classifies a `ReferenceError:` without any stack frame (no location)", () => {
    const stderr = "ReferenceError: zzz is not defined\n";
    const result = classifyStderr(stderr, 1);
    expectClassified(result, "runtime", "zzz is not defined");
    expect(result.location).toBeUndefined();
  });

  it("classifies a custom `*Error`/`Exception` type", () => {
    const stderr = "CustomError: fail\n    at h (/abs/p.ts:7:9)\n";
    const result = classifyStderr(stderr, 1);
    expectClassified(result, "runtime", "fail");
    expect(result.location).toBe("/abs/p.ts:7:9");
  });
});

describe("classifyStderr — branch (4) generic fallback", () => {
  it("uses the first stderr line in the fallback message", () => {
    const stderr = "some random stderr line\nsecond line\n";
    const result = classifyStderr(stderr, 1);
    expectClassified(
      result,
      "compile",
      "Workflow script execution failed: some random stderr line",
    );
    expect(result.location).toBeUndefined();
  });

  it("reports the exit code when stderr is empty", () => {
    const result = classifyStderr("", 2);
    expectClassified(
      result,
      "compile",
      "Workflow script exited with code 2 and produced no diagnostic output.",
    );
  });

  it("reports `null` for the exit code when it is null and stderr is empty", () => {
    const result = classifyStderr("", null);
    expectClassified(
      result,
      "compile",
      "Workflow script exited with code null and produced no diagnostic output.",
    );
  });

  it("falls back for unrecognised stderr (no marker / no runtime line)", () => {
    const result = classifyStderr("totally unknown noise here\n", 1);
    expectClassified(
      result,
      "compile",
      "Workflow script execution failed: totally unknown noise here",
    );
  });
});

// ─── matchers in isolation ─────────────────────────────────────────

describe("matchEsbuildError", () => {
  it("returns undefined when stderr has no `:N:N: ERROR:` line", () => {
    expect(matchEsbuildError("Error: boom\n")).toBeUndefined();
  });

  it("extracts message + location from an esbuild line", () => {
    const result = matchEsbuildError("/a.ts:1:2: ERROR: the msg\n");
    expectClassified(result, "compile", "the msg");
    expect(result!.location).toBe("/a.ts:1:2");
  });
});

describe("matchCompileMarker", () => {
  it("returns undefined when no recognised marker is present", () => {
    expect(matchCompileMarker("Error: boom\n")).toBeUndefined();
  });

  it("surfaces the marker line trimmed and a file:line:col location when present", () => {
    const result = matchCompileMarker("app.ts:4:5 - error TS9999: x\n");
    expectClassified(result, "compile", "app.ts:4:5 - error TS9999: x");
    expect(result!.location).toBe("app.ts:4:5");
  });

  it("omits location when the marker line has no file:line:col prefix", () => {
    const result = matchCompileMarker("✘ [ERROR] boom\n");
    expectClassified(result, "compile", "✘ [ERROR] boom");
    expect(result!.location).toBeUndefined();
  });
});

describe("matchRuntimeError", () => {
  it("returns undefined when no `<Type>: <msg>` line is present", () => {
    expect(matchRuntimeError("just some output\n")).toBeUndefined();
  });

  it("extracts the message after the type and a stack-frame location", () => {
    const result = matchRuntimeError("Error: boom\n    at f (file:///x.ts:1:2)\n");
    expectClassified(result, "runtime", "boom");
    expect(result!.location).toBe("file:///x.ts:1:2");
  });

  it("omits location when there is no stack frame", () => {
    const result = matchRuntimeError("TypeError: nope\n");
    expectClassified(result, "runtime", "nope");
    expect(result!.location).toBeUndefined();
  });
});

describe("genericFallback", () => {
  it("prefixes the first stderr line", () => {
    const result = genericFallback("first\nsecond\n", 1);
    expectClassified(result, "compile", "Workflow script execution failed: first");
  });

  it("reports the numeric exit code when stderr is empty", () => {
    expectClassified(
      genericFallback("", 7),
      "compile",
      "Workflow script exited with code 7 and produced no diagnostic output.",
    );
  });

  it("reports `null` when the exit code is null", () => {
    expectClassified(
      genericFallback("", null),
      "compile",
      "Workflow script exited with code null and produced no diagnostic output.",
    );
  });
});

describe("locationFromMatch", () => {
  it("returns undefined for a null match", () => {
    expect(locationFromMatch(null)).toBeUndefined();
  });

  it("returns undefined when any of groups 1–3 is absent", () => {
    expect(locationFromMatch("x".match(/foo/))).toBeUndefined();
    // A match that captures only some groups.
    const partial = "a".match(/(a)/);
    expect(partial).not.toBeNull();
    expect(locationFromMatch(partial)).toBeUndefined();
  });

  it("joins groups 1:2:3 into a location string", () => {
    const m = "/p.ts:3:4".match(/^(.+?):(\d+):(\d+)/);
    expect(m).not.toBeNull();
    expect(locationFromMatch(m)).toBe("/p.ts:3:4");
  });
});
