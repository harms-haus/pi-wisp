// ═══════════════════════════════════════════════════════════════════════════
// pi-wisp extension entry tests (S36 / kb-20).
//
// Verifies:
//   1. Tool registration — run_workflow and list_profiles are registered with
//      the correct names (no collision with pi-subagents' tools).
//   2. Lifecycle hook wiring — session_start, session_tree, session_shutdown
//      handlers are wired via pi.on().
//   3. Load-smoke — the module exports the expected shape.
//
// These tests do NOT spawn a real pi process. All assertions are on the mock
// ExtensionAPI calls.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Module under test
import extensionFactory, { builderPath, harnessPath } from "../index.js";

// ─── Helpers ──────────────────────────────────────────────────────

/** A minimal inline type matching the tool registration shape we inspect. */
interface NamedTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => unknown;
}

/** Narrow a tool registration argument to the fields we care about. */
function asNamedTool(tool: unknown): NamedTool | undefined {
  if (tool !== null && typeof tool === "object") {
    const obj = tool as Record<string, unknown>;
    if (typeof obj.name === "string") {
      return obj as unknown as NamedTool;
    }
  }
  return undefined;
}

/**
 * Create a minimal mock ExtensionAPI with vi.fn() spies on the methods the
 * extension calls during initialisation.
 */
function createMockAPI(): {
  api: ExtensionAPI;
  on: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
} {
  const on = vi.fn();
  const registerTool = vi.fn();
  const registerCommand = vi.fn();

  const api = {
    on,
    registerTool,
    registerCommand,
  } as unknown as ExtensionAPI;

  return { api, on, registerTool, registerCommand };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("pi-wisp extension", () => {
  let mock: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    mock = createMockAPI();
  });

  // ── Load-smoke ───────────────────────────────────────────────

  describe("load-smoke", () => {
    it("exports builderPath and harnessPath as strings", () => {
      expect(typeof builderPath).toBe("string");
      expect(typeof harnessPath).toBe("string");
      expect(builderPath.length).toBeGreaterThan(0);
      expect(harnessPath.length).toBeGreaterThan(0);
    });

    it("exports a default function", () => {
      expect(typeof extensionFactory).toBe("function");
    });

    it("invokes the factory without throwing", () => {
      expect(() => {
        extensionFactory(mock.api);
      }).not.toThrow();
    });
  });

  // ── Tool registration ───────────────────────────────────────

  describe("tool registration", () => {
    it("calls registerTool exactly twice", () => {
      extensionFactory(mock.api);
      expect(mock.registerTool).toHaveBeenCalledTimes(2);
    });

    it("registers the run_workflow tool", () => {
      extensionFactory(mock.api);
      const tools: NamedTool[] = mock.registerTool.mock.calls.map(
        (call: unknown[]) => asNamedTool(call[0]) as NamedTool,
      );
      expect(tools.some((t) => t.name === "run_workflow")).toBe(true);
    });

    it("registers the list_profiles tool", () => {
      extensionFactory(mock.api);
      const tools: NamedTool[] = mock.registerTool.mock.calls.map(
        (call: unknown[]) => asNamedTool(call[0]) as NamedTool,
      );
      expect(tools.some((t) => t.name === "list_profiles")).toBe(true);
    });

    it("does NOT register the scaffold wisp_ping tool", () => {
      extensionFactory(mock.api);
      const tools: NamedTool[] = mock.registerTool.mock.calls.map(
        (call: unknown[]) => asNamedTool(call[0]) as NamedTool,
      );
      expect(tools.some((t) => t.name === "wisp_ping")).toBe(false);
    });

    it("uses tool names that do NOT collide with pi-subagents", () => {
      // pi-subagents registers: delegate_to_subagents, get_subagent_output,
      // get_subagent_session, list_subagent_profiles
      extensionFactory(mock.api);
      const tools: NamedTool[] = mock.registerTool.mock.calls.map(
        (call: unknown[]) => asNamedTool(call[0]) as NamedTool,
      );
      const names = new Set(tools.map((t) => t.name));
      // Our names
      expect(names.has("run_workflow")).toBe(true);
      expect(names.has("list_profiles")).toBe(true);
      // pi-subagents names that MUST NOT collide
      expect(names.has("delegate_to_subagents")).toBe(false);
      expect(names.has("list_subagent_profiles")).toBe(false);
    });
  });

  // ── Lifecycle hooks ─────────────────────────────────────────

  describe("lifecycle hooks", () => {
    it("wires session_start handler", () => {
      extensionFactory(mock.api);
      expect(mock.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    });

    it("wires session_tree handler", () => {
      extensionFactory(mock.api);
      expect(mock.on).toHaveBeenCalledWith("session_tree", expect.any(Function));
    });

    it("wires session_shutdown handler", () => {
      extensionFactory(mock.api);
      expect(mock.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    });

    it("wires exactly three lifecycle hooks", () => {
      extensionFactory(mock.api);
      // Filter only the "session_*" events to count lifecycle hooks
      const lifecycleCalls = (mock.on.mock.calls as [string, unknown][]).filter(([event]) =>
        event.startsWith("session_"),
      );
      expect(lifecycleCalls.length).toBe(3);
    });

    it("calls session_start handler without throwing", () => {
      extensionFactory(mock.api);
      // Extract the session_start handler and call it
      const calls = mock.on.mock.calls as [string, (...args: unknown[]) => unknown][];
      const startHandler = calls.find(([ev]) => ev === "session_start")?.[1];
      expect(startHandler).toBeDefined();
      // Calling with minimal event + ctx must not throw
      expect(() =>
        startHandler!({ type: "session_start", reason: "new" }, { cwd: process.cwd() }),
      ).not.toThrow();
    });

    it("calls session_shutdown handler without throwing", () => {
      extensionFactory(mock.api);
      const calls = mock.on.mock.calls as [string, (...args: unknown[]) => unknown][];
      const shutdownHandler = calls.find(([ev]) => ev === "session_shutdown")?.[1];
      expect(shutdownHandler).toBeDefined();
      // Calling with minimal event + ctx must not throw
      expect(() =>
        shutdownHandler!(
          { type: "session_shutdown", reason: "quit" },
          { cwd: process.cwd(), ui: { setStatus: vi.fn(), setWidget: vi.fn() } },
        ),
      ).not.toThrow();
    });
  });
});
