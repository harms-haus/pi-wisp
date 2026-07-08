// ═══════════════════════════════════════════════════════════════════════════
// RED tests — run-workflow-paths extracted module (refactor: split run-workflow.ts).
//
// Imports `validateParams`, `defaultGetAdapter`, `executeResumePath`,
// `executeFreshPath` from the NEW module `src/tools/run-workflow-paths.js`,
// which does not exist yet — so these imports FAIL until the green team extracts
// the path helpers. The assertions pin current behavior so the refactor is safe.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentAdapter } from "../../adapters/types.js";
import { piAdapter } from "../../adapters/pi.js";

import {
  validateParams,
  defaultGetAdapter,
  executeResumePath,
  executeFreshPath,
} from "../../tools/run-workflow-paths.js";

/** Minimal ctx shape compatible with the tool's ToolCtx (structurally). */
function uiCtx(cwd: string) {
  return {
    cwd,
    ui: {
      setWidget: vi.fn() as (name: string, content: unknown) => void,
      setStatus: vi.fn() as (name: string, text: unknown) => void,
    },
  };
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "wisp-paths-test-"));
}

const dummyGetAdapter = (): AgentAdapter => ({ run: (() => {}) as never }) as never;

// ─── validateParams ───────────────────────────────────────────────

describe("validateParams", () => {
  it("returns a validation error when none of path/script/resumeFrom is provided", () => {
    const r = validateParams({});
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.details.kind).toBe("validation");
      expect(r.error.details.message.toLowerCase()).toContain("path");
      expect(r.error.details.message.toLowerCase()).toContain("script");
      expect(r.error.details.message.toLowerCase()).toContain("resumefrom");
      expect(r.error.content[0]!.text).toContain("Validation error:");
    }
  });

  it("extracts a provided path", () => {
    const r = validateParams({ path: "/tmp/wf.ts" });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.path).toBe("/tmp/wf.ts");
      expect(r.script).toBeUndefined();
      expect(r.resumeFrom).toBeUndefined();
    }
  });

  it("extracts a provided script", () => {
    const r = validateParams({ script: "inline" });
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.script).toBe("inline");
  });

  it("extracts a provided resumeFrom", () => {
    const r = validateParams({ resumeFrom: "/runs/2025-01-01-x" });
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.resumeFrom).toBe("/runs/2025-01-01-x");
  });

  it("treats empty strings as missing (returns validation error)", () => {
    const r = validateParams({ path: "", script: "", resumeFrom: "" });
    expect("error" in r).toBe(true);
  });

  it("treats non-string values as missing (returns validation error)", () => {
    const r = validateParams({ path: 42 });
    expect("error" in r).toBe(true);
  });

  it("can extract more than one field at once", () => {
    const r = validateParams({ path: "/a.ts", script: "b", resumeFrom: "/c" });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.path).toBe("/a.ts");
      expect(r.script).toBe("b");
      expect(r.resumeFrom).toBe("/c");
    }
  });
});

// ─── defaultGetAdapter ────────────────────────────────────────────

describe("defaultGetAdapter", () => {
  it("returns the canonical pi adapter for any/undefined type", () => {
    expect(defaultGetAdapter()).toBe(piAdapter);
    expect(defaultGetAdapter("pi")).toBe(piAdapter);
  });

  it("logs a warning and still returns pi when a non-pi type is requested", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapter = defaultGetAdapter("codex");
      expect(adapter).toBe(piAdapter);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toContain("codex");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn for the pi type", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      defaultGetAdapter("pi");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─── executeResumePath ────────────────────────────────────────────

describe("executeResumePath", () => {
  it("returns a runtime error result when the resume directory is missing", async () => {
    const cwd = tmpCwd();
    const ctx = uiCtx(cwd);
    const result = await executeResumePath(
      join(cwd, "does-not-exist"),
      ctx,
      join(cwd, "runs"),
      undefined,
      undefined,
      dummyGetAdapter,
    );
    const details = result.details as Record<string, unknown>;
    expect(details.kind).toBe("runtime");
    expect(typeof details.message).toBe("string");
    expect((details.message as string).toLowerCase()).toContain("not found");
  });
});

// ─── executeFreshPath ─────────────────────────────────────────────

describe("executeFreshPath", () => {
  it("returns a compile error result when the workflow path does not exist", async () => {
    const cwd = tmpCwd();
    const ctx = uiCtx(cwd);
    const result = await executeFreshPath(
      undefined,
      join(cwd, "missing-workflow.ts"),
      ctx,
      join(cwd, "runs"),
      undefined,
      undefined,
      dummyGetAdapter,
    );
    const details = result.details as Record<string, unknown>;
    expect(details.kind).toBe("compile");
    expect(typeof details.message).toBe("string");
    expect((details.message as string).toLowerCase()).toContain("not found");
  });
});
