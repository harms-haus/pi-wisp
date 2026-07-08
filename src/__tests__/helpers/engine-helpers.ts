// ═══════════════════════════════════════════════════════════════════════════
// Engine / spawner / widget test helpers (S25 / IMPLEMENTATION_PROMPT §19).
//
// Ported from `@harms-haus/pi-subagents/src/__tests__/helpers.ts` and adapted to
// wisp's shapes:
//   - createMockPi          — minimal ExtensionAPI mock (port)
//   - createMockExtensionAPI — richer wisp mock (appendEntry/getBranch/exec/…)
//                              with a dual-handle return so tests can assert
//   - createMockProcess     — EventEmitter-based ChildProcess (port)
//   - createMockTheme       — passthrough Theme (port)
//   - makeSession           — wisp session shape (S21)
//   - makeWindow            — wisp per-node runtime state (NodeRuntime)
//   - emitToolCall          — emit a native tool JSONL line on a mock stdout
//   - waitForCalls          — async wait for a mock to be called N times (port)
//   - waitForCondition      — async wait for a boolean predicate (port)
// ═══════════════════════════════════════════════════════════════════════════

import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { NodeRuntime } from "../../types.js";

// ─── createMockPi ───────────────────────────────────────────────────
// Used by: tools tests (S34), store tests (S23).

/**
 * Create a minimal mock `ExtensionAPI` with sensible defaults, mirroring
 * pi-subagents' `createMockPi`. Pass `overrides` to replace/extend any property.
 *
 * For tests that need to assert on individual mocks (appendEntry round-trips,
 * getBranch reconstruction) prefer {@link createMockExtensionAPI}.
 */
export function createMockPi(overrides: Partial<ExtensionAPI> = {}): ExtensionAPI {
  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
    getAllTools: vi.fn().mockReturnValue([]),
    getActiveTools: vi.fn().mockReturnValue([]),
    appendEntry: vi.fn(),
    exec: vi.fn(),
    ui: {
      notify: vi.fn(),
      confirm: vi.fn(),
      setWidget: vi.fn(),
      setStatus: vi.fn(),
    },
    ...overrides,
  } as unknown as ExtensionAPI;
}

// ─── createMockExtensionAPI ─────────────────────────────────────────
// Used by: store tests (S23 — appendEntry round-trip + getBranch
// reconstruction), run-lifecycle/tool tests (S31/S34).

/** Handle object returned by {@link createMockExtensionAPI}. */
export interface MockExtensionAPI {
  /** The assembled mock `ExtensionAPI` (pass this into production code). */
  api: ExtensionAPI;
  registerTool: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  getAllTools: ReturnType<typeof vi.fn>;
  getActiveTools: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  /** `sessionManager.getBranch` mock (returns the configured branch entries). */
  getBranch: ReturnType<typeof vi.fn>;
  setWidget: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
}

/**
 * Create a richer mock `ExtensionAPI` exposing the methods wisp's run/tool/store
 * layers touch (`appendEntry`, `sessionManager.getBranch`, `registerTool`,
 * `on`, `getAllTools`, `getActiveTools`, `exec`) as individually-assertable
 * `vi.fn()` mocks.
 *
 * @param options.branch - Entries returned by `sessionManager.getBranch()` (for
 *   reconstruct-runs tests). Defaults to `[]`.
 */
export function createMockExtensionAPI(options: { branch?: unknown[] } = {}): MockExtensionAPI {
  const registerTool = vi.fn();
  const on = vi.fn();
  const appendEntry = vi.fn();
  const getAllTools = vi.fn().mockReturnValue([]);
  const getActiveTools = vi.fn().mockReturnValue([]);
  const exec = vi.fn();
  const getBranch = vi.fn(() => options.branch ?? []);
  const setWidget = vi.fn();
  const setStatus = vi.fn();

  const sessionManager = { getBranch };

  const api = {
    registerTool,
    on,
    appendEntry,
    getAllTools,
    getActiveTools,
    exec,
    ui: {
      setWidget,
      setStatus,
      notify: vi.fn(),
      confirm: vi.fn(),
    },
    sessionManager,
  } as unknown as ExtensionAPI;

  return {
    api,
    registerTool,
    on,
    appendEntry,
    getAllTools,
    getActiveTools,
    exec,
    getBranch,
    setWidget,
    setStatus,
  };
}

// ─── makeSession ────────────────────────────────────────────────────
// Used by: transcript tests (S20), session-store tests (S21).

/**
 * Wisp persisted-session shape (PLAN S21 / IMPLEMENTATION §12). Mirrors the
 * `sessions/{sessionId}.json` content. Defined here because the canonical type
 * is produced by S21; this lets transcript/session tests run before S21 lands.
 */
export interface WispTestSession {
  sessionId: string;
  nodeId?: string;
  agentType: string;
  profile?: string;
  provider?: string;
  model?: string;
  messages: unknown[];
  finalText?: string;
  toolCallCount: number;
  durationMs: number;
  costUsd?: number;
  error?: string;
}

/**
 * Factory for a {@link WispTestSession} with sensible defaults.
 * Override any field via `overrides`.
 */
export function makeSession(overrides: Partial<WispTestSession> = {}): WispTestSession {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 10)}`,
    agentType: "pi",
    messages: [],
    toolCallCount: 0,
    durationMs: 100,
    ...overrides,
  };
}

// ─── makeWindow ─────────────────────────────────────────────────────
// Used by: widget tests (S33), spawner-adjacent tests.
//
// In wisp the per-agent "window" analog is a node's `NodeRuntime` — the live
// execution state rendered as one row in the TUI widget.

/**
 * Factory for a `NodeRuntime` (wisp's per-node execution window) with sensible
 * defaults. Override any field via `overrides`.
 */
export function makeWindow(overrides: Partial<NodeRuntime> = {}): NodeRuntime {
  return {
    status: "pending",
    attempts: 0,
    toolCount: 0,
    filesEdited: [],
    ...overrides,
  };
}

// ─── createMockProcess ──────────────────────────────────────────────
// Used by: spawner tests (S10).

/** Type for the mock ChildProcess returned by {@link createMockProcess}. */
export type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  pid: number | undefined;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

/**
 * Create a mock `ChildProcess` with `EventEmitter`-based stdout/stderr/stdin.
 * The `kill` mock emits `"exit"` with code `0` for `SIGTERM` and `1` otherwise.
 * Ported from pi-subagents' `createMockProcess`.
 */
export function createMockProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  proc.pid = 12345;
  proc.killed = false;
  proc.kill = vi.fn((signal: string) => {
    proc.killed = true;
    proc.emit("exit", signal === "SIGTERM" ? 0 : 1);
  });
  return proc;
}

// ─── createMockTheme ────────────────────────────────────────────────
// Used by: widget tests (S33), format tests (S32).

/**
 * Create a mock `Theme` where `fg` and `bold` pass text through unchanged.
 * Ported from pi-subagents' `createMockTheme`.
 */
export function createMockTheme(): Theme {
  return {
    fg: vi.fn((_color: string, text: string) => text),
    bold: vi.fn((text: string) => text),
  } as unknown as Theme;
}

// ─── emitToolCall ───────────────────────────────────────────────────
// Used by: spawner/adapter line-parsing tests (S9/S10).
//
// Emits a native tool JSONL line on a mock process's stdout. The wisp pi adapter
// (PLAN S9) maps `tool_execution_start` → `tool_call`; align this helper with
// S9's exact format once the adapter lands.

/**
 * Emit a synthetic tool-call JSONL event on a mock process's stdout. The data
 * handler processes the event synchronously, so no await is needed.
 */
export function emitToolCall(
  proc: { stdout: EventEmitter },
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string = `call-${Math.random().toString(36).slice(2, 8)}`,
): void {
  const jsonEvent = JSON.stringify({
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args,
  });
  proc.stdout.emit("data", Buffer.from(`${jsonEvent}\n`));
}

// ─── Async test helpers ─────────────────────────────────────────────

/**
 * Wait for a mock function to have been called at least `callCount` times.
 * Uses `setTimeout(0)` polling for responsive event-driven waiting. Ported from
 * pi-subagents.
 */
export async function waitForCalls(
  mockFn: { mock: { calls: unknown[] } },
  callCount: number,
  timeout = 2000,
): Promise<void> {
  const start = Date.now();
  while (mockFn.mock.calls.length < callCount) {
    if (Date.now() - start > timeout) {
      throw new Error(
        `Timeout waiting for mock to be called ${callCount} times (was called ${mockFn.mock.calls.length} times)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Wait for a condition to become true. Ported from pi-subagents.
 */
export async function waitForCondition(
  condition: () => boolean,
  timeout = 2000,
  description = "condition",
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error(`Timeout (${timeout}ms) waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
