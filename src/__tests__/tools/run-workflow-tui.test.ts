// ═══════════════════════════════════════════════════════════════════════════
// RED tests — run-workflow-tui extracted module (refactor: split run-workflow.ts).
//
// Imports `initTUI`, `clearTUI`, `buildBaseRunOpts` from the NEW module
// `src/tools/run-workflow-tui.js`, which does not exist yet — so these imports
// FAIL until the green team extracts the TUI helpers. The assertions then pin
// the exact current behavior so the refactor preserves it.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentAdapter } from "../../adapters/types.js";
import { CONFIG_DEFAULTS } from "../../constants.js";

import { initTUI, clearTUI, buildBaseRunOpts } from "../../tools/run-workflow-tui.js";

// WISP_WIDGET_NAME is "wisp" — referenced as a literal here to avoid coupling
// this test to the widget module re-export surface.
const WIDGET = "wisp";

/** Minimal ctx shape compatible with the tool's ToolCtx (structurally). */
function uiCtx() {
  return {
    ui: {
      setWidget: vi.fn() as (name: string, content: unknown) => void,
      setStatus: vi.fn() as (name: string, text: unknown) => void,
    },
  };
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "wisp-tui-test-"));
}

// ─── initTUI ──────────────────────────────────────────────────────

describe("initTUI", () => {
  it("sets the widget content to a 'running workflow' line and status to 'running'", () => {
    const ctx = uiCtx();
    initTUI(ctx as never);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(WIDGET, [`${WIDGET}: running workflow...`]);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(WIDGET, "running");
  });

  it("is a no-op when ctx.ui is undefined", () => {
    expect(() => {
      initTUI({} as never);
    }).not.toThrow();
  });
});

// ─── clearTUI ─────────────────────────────────────────────────────

describe("clearTUI", () => {
  it("clears the widget content and status", () => {
    const ctx = uiCtx();
    clearTUI(ctx as never);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(WIDGET, undefined);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(WIDGET, undefined);
  });

  it("swallows errors thrown during cleanup (best-effort)", () => {
    const ctx = {
      ui: {
        setWidget: () => {
          throw new Error("cleanup exploded");
        },
        setStatus: vi.fn(),
      },
    };
    expect(() => {
      clearTUI(ctx as never);
    }).not.toThrow();
  });
});

// ─── buildBaseRunOpts ─────────────────────────────────────────────

describe("buildBaseRunOpts", () => {
  const dummyAdapter: AgentAdapter = { run: (() => {}) as never } as never;
  const dummyGetAdapter = (): AgentAdapter => dummyAdapter;

  it("assembles the shared run options with config defaults for a config-less cwd", () => {
    const cwd = tmpCwd();
    const opts = buildBaseRunOpts({ cwd }, "/runs", undefined, undefined, dummyGetAdapter);

    expect(opts.runsDir).toBe("/runs");
    expect(opts.getAdapter).toBe(dummyGetAdapter);
    // No config file → CONFIG_DEFAULTS apply.
    expect(opts.defaultRetries).toBe(CONFIG_DEFAULTS.defaultRetries);
    expect(opts.retryBackoffMs).toBe(CONFIG_DEFAULTS.retryBackoffMs);
    expect(opts.maxAgentConcurrency).toBe(CONFIG_DEFAULTS.maxAgentConcurrency);
    // builder/harness paths are absolute filesystem paths to the DSL modules.
    expect(typeof opts.builderPath).toBe("string");
    expect(opts.builderPath.length).toBeGreaterThan(0);
    expect(typeof opts.harnessPath).toBe("string");
    expect(opts.harnessPath.length).toBeGreaterThan(0);
    // No profilesRunDir → profiles only carries cwd.
    expect(opts.profiles).toEqual({ cwd });
    // No ctx.pi → appendEntry is a no-op function.
    expect(typeof opts.pi.appendEntry).toBe("function");
    expect(opts.signal).toBeUndefined();
    expect(opts.onUpdate).toBeUndefined();
  });

  it("includes runDir in profiles when profilesRunDir is provided", () => {
    const cwd = tmpCwd();
    const opts = buildBaseRunOpts(
      { cwd },
      "/runs",
      undefined,
      undefined,
      dummyGetAdapter,
      "/profiles/run-1",
    );
    expect(opts.profiles).toEqual({ cwd, runDir: "/profiles/run-1" });
  });

  it("threads signal and engineOnUpdate through to the options", () => {
    const cwd = tmpCwd();
    const controller = new AbortController();
    const onUpdate = vi.fn();
    const opts = buildBaseRunOpts({ cwd }, "/runs", controller.signal, onUpdate, dummyGetAdapter);
    expect(opts.signal).toBe(controller.signal);
    expect(opts.onUpdate).toBe(onUpdate);
  });

  it("wires ctx.pi.appendEntry into the options when present", () => {
    const cwd = tmpCwd();
    const spy = vi.fn();
    const opts = buildBaseRunOpts(
      { cwd, pi: { appendEntry: spy } },
      "/runs",
      undefined,
      undefined,
      dummyGetAdapter,
    );
    opts.pi.appendEntry("wisp:run", { id: 1 });
    expect(spy).toHaveBeenCalledWith("wisp:run", { id: 1 });
  });
});
