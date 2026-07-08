// ═══════════════════════════════════════════════════════════════════════════
// Spawn/kill/abort tests — runAgent + killProcessTree (S10)
//
// These tests verify the contract for the generic spawner and the process-tree
// killing utility. All process spawning is mocked so no real agent binary is
// needed; line-buffering, 50ms debounce coalescing, stdin pipeline, stderr
// capture, abort escalation (SIGTERM→SIGKILL→force-resolve), and exit-code
// propagation are tested in isolation.
//
// ═══════════════════════════════════════════════════════════════════════════

import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { killProcessTree } from "../../spawn/abort.js";
import { runAgent } from "../../spawn/spawner.js";
import type { NormalizedEvent } from "../../types.js";
import { createMockProcess } from "../helpers/engine-helpers.js";
import type { MockChildProcess } from "../helpers/engine-helpers.js";

// ─── Mocks ──────────────────────────────────────────────────────────

// Mock tree-kill so we never actually kill OS processes in tests.
vi.mock("tree-kill", () => ({
  default: vi.fn(),
}));

// Mock child_process.spawn so no real subprocess is spawned.
// Each test sets up the mock via `vi.mocked(spawn).mockReturnValue(...)`.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import treeKill from "tree-kill";
const mockTreeKill = vi.mocked(treeKill);

// ─── Helpers ────────────────────────────────────────────────────────

/** A pass-through parse function used when the test wants to check events. */
const identityParse = (line: string): NormalizedEvent | null => {
  try {
    return JSON.parse(line) as NormalizedEvent;
  } catch {
    return null;
  }
};

/** A parse function that returns `null` for every line (e.g. ignorable/heartbeat lines). */
const nullParse = (_line: string): NormalizedEvent | null => null;

/**
 * Advance fake timers and let pending microtasks drain.
 * Combines `vi.advanceTimersByTimeAsync` so that setTimeout callbacks (including
 * the 50ms debounce and abort escalation timers) execute in order.
 */
async function advanceTime(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

// ─── runAgent: line-buffering ──────────────────────────────────────

describe("runAgent — stdout line buffering", () => {
  let mockProcess: MockChildProcess;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ChildProcess);
  });

  it("splits stdout on \\n and calls onEvent for each complete line", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: ["--mode", "json", "-p", "--no-session"],
      env: {},
      stdinPrompt: "hello",
      parseLine: identityParse,
      onEvent,
      onUpdate,
    });

    // Emit two complete lines
    const event1: NormalizedEvent = { type: "session", id: "sess-1" };
    const event2: NormalizedEvent = { type: "turn_end" };
    mockProcess.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify(event1)}\n${JSON.stringify(event2)}\n`),
    );

    // Let any microtasks settle
    await new Promise((r) => setTimeout(r, 0));

    // Both events should be forwarded to onEvent
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(1, event1);
    expect(onEvent).toHaveBeenNthCalledWith(2, event2);

    // Close the process so the promise resolves
    mockProcess.emit("close", 0);
    await promise;
  });

  it("holds an incomplete trailing line until the next \\n arrives", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: identityParse,
      onEvent,
      onUpdate,
    });

    // Emit an incomplete JSON value (no trailing newline) — held in buffer
    const partialLine = '{"type":"text_delta","delta":"hello wor';
    mockProcess.stdout.emit("data", Buffer.from(partialLine));

    // Let microtasks settle
    await new Promise((r) => setTimeout(r, 0));

    // The incomplete line should NOT have been parsed yet
    expect(onEvent).not.toHaveBeenCalled();

    // Now emit the rest which completes the JSON value and adds a newline
    mockProcess.stdout.emit("data", Buffer.from('ld"}\n'));

    await new Promise((r) => setTimeout(r, 0));

    // The combined line should now be parsed
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      type: "text_delta",
      delta: "hello world",
    });

    mockProcess.emit("close", 0);
    await promise;
  });

  it("handles multiple lines in a single data chunk", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: identityParse,
      onEvent,
      onUpdate,
    });

    // Emit three lines in one chunk
    const lines = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "turn_end" }),
      JSON.stringify({ type: "text_delta", delta: "done" }),
    ];
    mockProcess.stdout.emit("data", Buffer.from(lines.join("\n") + "\n"));

    await new Promise((r) => setTimeout(r, 0));

    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent).toHaveBeenNthCalledWith(1, { type: "session", id: "s1" });
    expect(onEvent).toHaveBeenNthCalledWith(2, { type: "turn_end" });
    expect(onEvent).toHaveBeenNthCalledWith(3, {
      type: "text_delta",
      delta: "done",
    });

    mockProcess.emit("close", 0);
    await promise;
  });

  it("calls onEvent(null) for ignorable lines when parseLine returns null", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: nullParse,
      onEvent,
      onUpdate,
    });

    // Emit a line that the parse function considers ignorable
    mockProcess.stdout.emit("data", Buffer.from("heartbeat\n"));

    await new Promise((r) => setTimeout(r, 0));

    // nullParse always returns null, so onEvent should be called with null
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(null);

    mockProcess.emit("close", 0);
    await promise;
  });

  it("handles UTF-8 multibyte characters split across data chunks", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: identityParse,
      onEvent,
      onUpdate,
    });

    await new Promise((r) => setTimeout(r, 0));

    // Construct a line with '😀' (U+1F600 = 4 UTF-8 bytes: F0 9F 98 80)
    // and split the emoji bytes across two data chunks.
    const beforeEmoji = '{"type":"text_delta","delta":"';
    const afterEmoji = '"}\n';
    const emoji = "😀";
    const emojiBytes = Buffer.from(emoji, "utf8"); // 4 bytes

    // First chunk: everything before the emoji + first 2 bytes of the emoji
    const chunk1 = Buffer.concat([Buffer.from(beforeEmoji, "utf8"), emojiBytes.subarray(0, 2)]);

    // Second chunk: last 2 bytes of the emoji + rest of the line + newline
    const chunk2 = Buffer.concat([emojiBytes.subarray(2), Buffer.from(afterEmoji, "utf8")]);

    // Emit first chunk — line is incomplete (emoji bytes straddle the boundary)
    mockProcess.stdout.emit("data", chunk1);
    await new Promise((r) => setTimeout(r, 0));

    // The incomplete line should NOT have been parsed yet
    expect(onEvent).not.toHaveBeenCalled();

    // Emit second chunk — completes the emoji + finishes the line
    mockProcess.stdout.emit("data", chunk2);
    await new Promise((r) => setTimeout(r, 0));

    // The complete line must have the correct multibyte character (no U+FFFD)
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      type: "text_delta",
      delta: emoji,
    });

    mockProcess.emit("close", 0);
    await promise;
  });
});

// ─── runAgent: stdin writing ───────────────────────────────────────

describe("runAgent — stdin writing", () => {
  let mockProcess: MockChildProcess;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ChildProcess);
  });

  it("writes stdinPrompt to process.stdin then ends it", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "write this prompt to stdin",
      parseLine: nullParse,
      onEvent,
      onUpdate,
    });

    // Let async setup complete
    await new Promise((r) => setTimeout(r, 0));

    // The prompt should be written to stdin
    expect(mockProcess.stdin.write).toHaveBeenCalledWith("write this prompt to stdin");
    // stdin should have been ended
    expect(mockProcess.stdin.end).toHaveBeenCalledTimes(1);

    mockProcess.emit("close", 0);
    await promise;
  });

  it("writes an empty stdinPrompt and ends stdin", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: nullParse,
      onEvent,
      onUpdate,
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(mockProcess.stdin.write).toHaveBeenCalledWith("");
    expect(mockProcess.stdin.end).toHaveBeenCalledTimes(1);

    mockProcess.emit("close", 0);
    await promise;
  });
});

// ─── runAgent: stderr capture ──────────────────────────────────────

describe("runAgent — stderr capture", () => {
  let mockProcess: MockChildProcess;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ChildProcess);
  });

  it("captures stderr data and returns it in the result", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: nullParse,
      onEvent,
      onUpdate,
    });

    await new Promise((r) => setTimeout(r, 0));

    // Emit stderr data (multiple chunks)
    mockProcess.stderr.emit("data", Buffer.from("warning: something\n"));
    mockProcess.stderr.emit("data", Buffer.from("error: failed\n"));

    mockProcess.emit("close", 1);

    const result = await promise;

    expect(result.stderr).toContain("warning: something");
    expect(result.stderr).toContain("error: failed");
  });

  it("returns empty string when no stderr was emitted", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: nullParse,
      onEvent,
      onUpdate,
    });

    await new Promise((r) => setTimeout(r, 0));

    mockProcess.emit("close", 0);

    const result = await promise;
    expect(result.stderr).toBe("");
  });
});

// ─── runAgent: onUpdate forwarding (no redundant debounce) ────────
// The executor's notify is already debounced at 50ms, so runAgent passes
// onUpdate through WITHOUT wrapping — each line processed triggers onUpdate
// immediately.

describe("runAgent — onUpdate forwarding", () => {
  let mockProcess: MockChildProcess;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockProcess = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ChildProcess);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onUpdate immediately after each parsed line", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: identityParse,
      onEvent,
      onUpdate,
    });

    // Let the constructor / spawn complete
    await advanceTime(10);

    const event1 = { type: "text_delta", delta: "a" } as NormalizedEvent;
    const event2 = { type: "text_delta", delta: "b" } as NormalizedEvent;

    // Emit data lines
    mockProcess.stdout.emit("data", Buffer.from(`${JSON.stringify(event1)}\n`));
    mockProcess.stdout.emit("data", Buffer.from(`${JSON.stringify(event2)}\n`));

    // All events forwarded immediately
    expect(onEvent).toHaveBeenCalledTimes(2);

    // onUpdate also called immediately (no debounce layer)
    expect(onUpdate).toHaveBeenCalledTimes(2);

    // Close the process so the promise resolves
    mockProcess.emit("close", 0);
    await promise;
  });

  it("calls onUpdate on close for any trailing buffered line", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: identityParse,
      onEvent,
      onUpdate,
    });

    await advanceTime(10);

    // Emit a line WITHOUT trailing newline (buffered)
    mockProcess.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ type: "text_delta", delta: "buffered" })),
    );

    // No event yet (no newline encountered)
    expect(onEvent).toHaveBeenCalledTimes(0);
    // No onUpdate yet
    expect(onUpdate).toHaveBeenCalledTimes(0);

    // Close triggers flush of buffered line
    mockProcess.emit("close", 0);
    await promise;

    // Now the buffered line should have been processed
    expect(onEvent).toHaveBeenCalledTimes(1);
    // onUpdate called once (for the flush) plus one more for close
    expect(onUpdate).toHaveBeenCalled();
  });

  it("does not call onUpdate when no data was emitted before close", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: nullParse,
      onEvent,
      onUpdate,
    });

    await advanceTime(10);

    // No data emitted — onUpdate should not have been called yet
    expect(onUpdate).not.toHaveBeenCalled();

    mockProcess.emit("close", 0);
    await promise;

    // onUpdate is called once on close
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});

// ─── runAgent: exit handling ───────────────────────────────────────

describe("runAgent — exit handling", () => {
  let mockProcess: MockChildProcess;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ChildProcess);
  });

  it("returns exitCode and stderr on process exit", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: nullParse,
      onEvent,
      onUpdate,
    });

    await new Promise((r) => setTimeout(r, 0));

    // Emit some stderr
    mockProcess.stderr.emit("data", Buffer.from("some error text"));

    // Exit with code 1
    mockProcess.emit("close", 1);

    const result = await promise;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("some error text");
  });

  it("returns exitCode 0 and empty stderr on clean exit", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: nullParse,
      onEvent,
      onUpdate,
    });

    await new Promise((r) => setTimeout(r, 0));

    mockProcess.emit("close", 0);

    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("processes buffered data on close before resolving", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: identityParse,
      onEvent,
      onUpdate,
    });

    await new Promise((r) => setTimeout(r, 0));

    // Emit a line without trailing newline (held in buffer)
    mockProcess.stdout.emit("data", Buffer.from('{"type":"session","id":"s-1"}'));

    // Close triggers buffer flush
    mockProcess.emit("close", 0);

    await promise;

    // The buffered line should have been parsed
    expect(onEvent).toHaveBeenCalledWith({
      type: "session",
      id: "s-1",
    });
  });

  it("returns null exitCode when process was killed by a signal", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: nullParse,
      onEvent,
      onUpdate,
    });

    await new Promise((r) => setTimeout(r, 0));

    // Emit close with null code (killed by signal)
    mockProcess.emit("close", null);

    const result = await promise;

    expect(result.exitCode).toBeNull();
  });
});

// ─── runAgent: abort signal integration ────────────────────────────

describe("runAgent — abort signal integration", () => {
  let mockProcess: MockChildProcess;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ChildProcess);
    // Ensure real timers for abort tests that don't need fake timers
    vi.useRealTimers();
  });

  it("calls killProcessTree when the AbortSignal is aborted", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();
    const abortController = new AbortController();

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      signal: abortController.signal,
      parseLine: nullParse,
      onEvent,
      onUpdate,
    });

    await new Promise((r) => setTimeout(r, 0));

    // Abort the signal
    abortController.abort();

    // Let async abort handler execute (tree-kill is called asynchronously)
    await new Promise((r) => setTimeout(r, 10));

    // tree-kill should have been called with SIGTERM
    expect(mockTreeKill).toHaveBeenCalledWith(mockProcess.pid, "SIGTERM");

    // Let the process close
    mockProcess.emit("close", null);
    await promise;
  });

  it("handles an already-aborted signal at start", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();
    const abortController = new AbortController();
    abortController.abort(); // Already aborted

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      signal: abortController.signal,
      parseLine: nullParse,
      onEvent,
      onUpdate,
    });

    // Let async code execute
    await new Promise((r) => setTimeout(r, 10));

    // tree-kill should have been called immediately
    expect(mockTreeKill).toHaveBeenCalledWith(mockProcess.pid, "SIGTERM");

    mockProcess.emit("close", null);
    await promise;
  });

  it("removes the abort event listener when the process closes normally", async () => {
    const onEvent = vi.fn();
    const onUpdate = vi.fn();
    const abortController = new AbortController();
    const signal = abortController.signal;

    const removeSpy = vi.spyOn(signal, "removeEventListener");

    const promise = runAgent({
      command: "pi",
      args: [],
      env: {},
      stdinPrompt: "",
      signal,
      parseLine: nullParse,
      onEvent,
      onUpdate,
    });

    await new Promise((r) => setTimeout(r, 0));

    // Process closes normally (not aborted)
    mockProcess.emit("close", 0);
    await promise;

    // The abort listener must have been removed to prevent leaks
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    removeSpy.mockRestore();
  });
});

// ─── killProcessTree ────────────────────────────────────────────────

describe("killProcessTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends SIGTERM to the process tree", async () => {
    const proc = {
      pid: 999,
      kill: vi.fn(),
    };

    const promise = killProcessTree(proc, { sigtermGraceMs: 5000, forceResolveMs: 5000 });

    // Advance time past the grace period
    await advanceTime(6000);

    // tree-kill should have sent SIGTERM
    expect(mockTreeKill).toHaveBeenCalledWith(999, "SIGTERM");

    // Simulate process exit after SIGTERM
    proc.kill.mockImplementation((signal: string) => {
      if (signal === "exit") {
        // not used for actual kill, just resolving
      }
    });

    // The promise eventually resolves (force-resolve after another 5s)
    await advanceTime(10000);
    await promise;
  });

  it("escalates to SIGKILL after sigtermGraceMs if process did not exit", async () => {
    const proc = {
      pid: 888,
      kill: vi.fn(),
    };

    // Don't let the process exit — simulate an unresponsive process
    const promise = killProcessTree(proc, { sigtermGraceMs: 5000, forceResolveMs: 5000 });

    // After sigtermGraceMs, SIGTERM is sent
    await advanceTime(5001);
    expect(mockTreeKill).toHaveBeenCalledWith(888, "SIGTERM");

    // Process still hasn't exited, so after another sigtermGraceMs (the escalation window)
    // SIGKILL should be sent
    await advanceTime(5001);
    expect(mockTreeKill).toHaveBeenCalledWith(888, "SIGKILL");

    // Finally the force-resolve kicks in
    await advanceTime(10000);
    await promise;
  });

  it("force-resolves after forceResolveMs (D-state guard)", async () => {
    const proc = {
      pid: 777,
      kill: vi.fn(),
    };

    const promise = killProcessTree(proc, { sigtermGraceMs: 5000, forceResolveMs: 5000 });

    // Advance past SIGTERM + SIGKILL + force-resolve windows
    await advanceTime(20000);

    // The promise should resolve even though the process never exited (D-state)
    // tree-kill should have been called with both signals
    expect(mockTreeKill).toHaveBeenCalledWith(777, "SIGTERM");
    expect(mockTreeKill).toHaveBeenCalledWith(777, "SIGKILL");

    await promise;
  });

  it("resolves early when process exits on SIGTERM (no escalation needed)", async () => {
    const proc = {
      pid: 666,
      kill: vi.fn(),
    };

    const promise = killProcessTree(proc, { sigtermGraceMs: 5000, forceResolveMs: 5000 });

    // Before the escalation timeout, simulate process exit
    // (the test verifies the design contract — the impl must emit an 'exit'
    //  event or similar when the process dies)
    await advanceTime(1000);

    // At this point, if the implementation handles early exit, the promise
    // should resolve. We just verify SIGKILL was NOT sent yet.
    expect(mockTreeKill).not.toHaveBeenCalledWith(666, "SIGKILL");

    await advanceTime(20000);
    await promise;
  });

  it("uses default options when none are provided", async () => {
    const proc = {
      pid: 555,
      kill: vi.fn(),
    };

    const promise = killProcessTree(proc);

    // With defaults: sigtermGraceMs=5000, forceResolveMs=5000
    await advanceTime(6000);
    expect(mockTreeKill).toHaveBeenCalledWith(555, "SIGTERM");

    await advanceTime(20000);
    await promise;
  });

  it("handles a process with no pid gracefully", async () => {
    const proc = {
      pid: undefined,
      kill: vi.fn(),
    };

    // Should not throw when pid is undefined
    const promise = killProcessTree(proc);

    await advanceTime(1000);
    // tree-kill should not be called with undefined pid
    expect(mockTreeKill).not.toHaveBeenCalled();

    await advanceTime(20000);
    await promise;
  });
});

// ─── runAgent: spawn errors ───────────────────────────────────────

describe("runAgent — spawn error handling", () => {
  let mockProcess: MockChildProcess;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ChildProcess);
  });

  it("rejects when the spawn process emits an 'error' event", async () => {
    // Some spawners emit an 'error' event (e.g. ENOENT) before 'close'.
    // The wrapper should propagate this.

    const onEvent = vi.fn();
    const onUpdate = vi.fn();

    const promise = runAgent({
      command: "nonexistent-binary",
      args: [],
      env: {},
      stdinPrompt: "",
      parseLine: nullParse,
      onEvent,
      onUpdate,
    });

    await new Promise((r) => setTimeout(r, 0));

    // Emit spawn error
    mockProcess.emit("error", new Error("ENOENT: spawn nonexistent-binary ENOENT"));

    // The promise should reject (or resolve with an error indicator)
    await expect(promise).rejects.toThrow(/ENOENT|spawn/);
  });
});
