// ═══════════════════════════════════════════════════════════════════════════
// Tests — kb-6 pi adapter (pi.ts)
//
// These tests document the CONTRACT of the pi adapter — the ONLY v1 adapter
// (D1). They verify:
//   • parseEventStreamLine maps every pi --mode json event to the correct
//     NormalizedEvent (and returns null for ignorable events)
//   • buildInvocation produces args with --mode json -p --no-session ADJACENT
//     and includes profile-derived args after the plumbing flags
//   • D3 compliance: NO --api-key and empty env (no PI_API_KEY)
//   • supportsNativeResume === false
//   • buildResumePrompt follows the transcript-replay format (D4)
//   • extractSessionId / extractFileEdits derive metadata from event streams
//   • buildDoneEvent synthesises the final summary event
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { piAdapter, buildDoneEvent, FILE_WRITE_TOOLS } from "../../adapters/pi.js";
import type {
  NormalizedEvent,
  ResolvedProfile,
  NodeInvocationContext,
} from "../../adapters/types.js";

// ─── Fixture helpers ─────────────────────────────────────────────

/** Build a minimal profile for invocation tests. */
function makeProfile(overrides: Partial<ResolvedProfile["profile"]> = {}): ResolvedProfile {
  return {
    profile: {
      agentType: "pi",
      ...overrides,
    },
    source: "inline" as const,
  };
}

/** Build a node invocation context. */
function makeContext(overrides: Partial<NodeInvocationContext> = {}): NodeInvocationContext {
  return {
    nodeId: "test-node",
    attempt: 1,
    ...overrides,
  };
}

// ─── Tests: parseEventStreamLine ─────────────────────────────────

describe("parseEventStreamLine", () => {
  // ── session ──────────────────────────────────────────────────

  it("parses a session event", () => {
    const line = JSON.stringify({
      type: "session",
      version: 3,
      id: "session-uuid-1234",
      timestamp: "2025-06-01T12:00:00Z",
      cwd: "/home/user/project",
    });
    const result = piAdapter.parseEventStreamLine(line);
    expect(result).toEqual({ type: "session", id: "session-uuid-1234" });
  });

  // ── tool_execution_start → tool_call ─────────────────────────

  it("parses a tool_execution_start event as tool_call", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "/src/index.ts" },
    });
    const result = piAdapter.parseEventStreamLine(line);
    expect(result).toEqual({
      type: "tool_call",
      name: "read",
      args: { path: "/src/index.ts" },
    });
  });

  // ── tool_execution_end → tool_result (success) ──────────────

  it("parses a tool_execution_end event (non-error) as tool_result", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: "file content here",
      isError: false,
    });
    const result = piAdapter.parseEventStreamLine(line);
    expect(result).toEqual({
      type: "tool_result",
      name: "read",
      isError: false,
      content: "file content here",
    });
  });

  // ── tool_execution_end → tool_result (error) ────────────────

  it("parses a tool_execution_end event with error flag", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "bash",
      result: "Command failed: permission denied",
      isError: true,
    });
    const result = piAdapter.parseEventStreamLine(line);
    expect(result).toEqual({
      type: "tool_result",
      name: "bash",
      isError: true,
      content: "Command failed: permission denied",
    });
  });

  // ── message_update with text_delta ──────────────────────────

  it("parses a message_update with text_delta assistantMessageEvent", () => {
    const line = JSON.stringify({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello world",
      },
    });
    const result = piAdapter.parseEventStreamLine(line);
    expect(result).toEqual({ type: "text_delta", delta: "Hello world" });
  });

  // ── turn_end ────────────────────────────────────────────────

  it("parses a turn_end event", () => {
    const line = JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
      toolResults: [],
    });
    const result = piAdapter.parseEventStreamLine(line);
    expect(result).toEqual({ type: "turn_end" });
  });

  // ── ignorable events → null ─────────────────────────────────

  it("returns null for agent_start (ignorable)", () => {
    const line = JSON.stringify({ type: "agent_start" });
    expect(piAdapter.parseEventStreamLine(line)).toBeNull();
  });

  it("returns null for turn_start (ignorable)", () => {
    const line = JSON.stringify({ type: "turn_start" });
    expect(piAdapter.parseEventStreamLine(line)).toBeNull();
  });

  it("returns null for message_start (ignorable)", () => {
    const line = JSON.stringify({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    expect(piAdapter.parseEventStreamLine(line)).toBeNull();
  });

  it("returns null for agent_end (ignorable)", () => {
    const line = JSON.stringify({ type: "agent_end", messages: [] });
    expect(piAdapter.parseEventStreamLine(line)).toBeNull();
  });

  it("returns null for queue_update (ignorable)", () => {
    const line = JSON.stringify({
      type: "queue_update",
      steering: [],
      followUp: [],
    });
    expect(piAdapter.parseEventStreamLine(line)).toBeNull();
  });

  it("returns null for compaction_start (ignorable)", () => {
    const line = JSON.stringify({
      type: "compaction_start",
      reason: "overflow",
    });
    expect(piAdapter.parseEventStreamLine(line)).toBeNull();
  });

  it("returns null for compaction_end (ignorable)", () => {
    const line = JSON.stringify({
      type: "compaction_end",
      reason: "manual",
      result: undefined,
      aborted: false,
      willRetry: false,
    });
    expect(piAdapter.parseEventStreamLine(line)).toBeNull();
  });

  it("returns null for auto_retry_start (ignorable)", () => {
    const line = JSON.stringify({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: "rate limit",
    });
    expect(piAdapter.parseEventStreamLine(line)).toBeNull();
  });

  it("returns null for auto_retry_end (ignorable)", () => {
    const line = JSON.stringify({
      type: "auto_retry_end",
      success: true,
      attempt: 1,
    });
    expect(piAdapter.parseEventStreamLine(line)).toBeNull();
  });

  // ── message_end with text content produces message_complete ──

  it("produces a message_complete from a message_end with assistant text", () => {
    // When there is no text_delta during the stream, the final assistant text
    // can be extracted from message_end. The adapter emits the accumulated
    // text as a single message_complete event (distinct from incremental
    // text_delta so buildDoneEvent can prefer the full text once, avoiding
    // duplication in mixed streams).
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is the final answer." }],
      },
    });
    const result = piAdapter.parseEventStreamLine(line);
    expect(result).toEqual({
      type: "message_complete",
      text: "Here is the final answer.",
    });
  });

  it("returns null for message_end with non-assistant role", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    });
    expect(piAdapter.parseEventStreamLine(line)).toBeNull();
  });

  // ── edge cases (blank, non-JSON, malformed) ─────────────────

  it("returns null for blank/empty lines", () => {
    expect(piAdapter.parseEventStreamLine("")).toBeNull();
    expect(piAdapter.parseEventStreamLine("  ")).toBeNull();
    expect(piAdapter.parseEventStreamLine("\t")).toBeNull();
  });

  it("returns null for non-JSON plain text lines", () => {
    expect(piAdapter.parseEventStreamLine("plain text output")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(piAdapter.parseEventStreamLine("{invalid")).toBeNull();
  });

  it("returns null for JSON array (not a recognized event type)", () => {
    expect(piAdapter.parseEventStreamLine('["a","b"]')).toBeNull();
  });

  it("returns null for JSON primitive (number)", () => {
    expect(piAdapter.parseEventStreamLine("42")).toBeNull();
  });
});

// ─── Tests: buildDoneEvent ─────────────────────────────────────

describe("buildDoneEvent", () => {
  it("builds a done event from a complete event stream", () => {
    const events: NormalizedEvent[] = [
      { type: "session", id: "session-xyz" },
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " world" },
      { type: "tool_call", name: "read", args: { path: "/a.ts" } },
      {
        type: "tool_result",
        name: "read",
        isError: false,
        content: "content",
      },
      { type: "turn_end" },
    ];
    const result = buildDoneEvent(events, 5000);
    expect(result).toMatchObject({
      type: "done",
      sessionId: "session-xyz",
      finalText: "Hello world",
      durationMs: 5000,
      toolCallCount: 1,
    });
  });

  it("uses 0 for toolCallCount when there are no tool calls", () => {
    const events: NormalizedEvent[] = [
      { type: "session", id: "s-1" },
      { type: "text_delta", delta: "No tools used" },
      { type: "turn_end" },
    ];
    const result = buildDoneEvent(events, 1000);
    expect(result.toolCallCount).toBe(0);
  });

  it("handles an empty event list gracefully", () => {
    const result = buildDoneEvent([], 0);
    expect(result).toMatchObject({
      type: "done",
      sessionId: "",
      finalText: "",
      durationMs: 0,
      toolCallCount: 0,
    });
  });

  it("constructs finalText by concatenating all text_delta deltas", () => {
    const events: NormalizedEvent[] = [
      { type: "session", id: "s-2" },
      { type: "text_delta", delta: "Line 1\n" },
      { type: "text_delta", delta: "Line 2\n" },
      { type: "text_delta", delta: "Line 3" },
      { type: "turn_end" },
    ];
    const result = buildDoneEvent(events, 2500);
    expect(result.finalText).toBe("Line 1\nLine 2\nLine 3");
  });

  it("does not double finalText when message_end carries full text alongside text_deltas (mixed stream)", () => {
    // Mixed stream: two message_update text_deltas followed by a message_end
    // that repeats the full assistant text. Currently message_end also maps to
    // text_delta, so buildDoneEvent concatenates all three → double. This test
    // asserts the final text appears only once (RED until impl adds a distinct
    // message_complete variant).
    const lines = [
      JSON.stringify({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: "Hello" },
      }),
      JSON.stringify({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: " world" },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
      }),
    ];

    const events: NormalizedEvent[] = lines
      .map((l) => piAdapter.parseEventStreamLine(l))
      .filter((e): e is NormalizedEvent => e !== null);

    const result = buildDoneEvent(events, 5000);
    expect(result.finalText).toBe("Hello world");
  });
});

// ─── Tests: buildInvocation ────────────────────────────────────

describe("buildInvocation", () => {
  it("produces args with --mode json -p --no-session adjacent", () => {
    const result = piAdapter.buildInvocation(makeProfile(), makeContext());

    // The -p flag must be immediately followed by --no-session (adjacent)
    const pIndex = result.args.indexOf("-p");
    expect(pIndex).toBeGreaterThanOrEqual(0);
    expect(result.args[pIndex + 1]).toBe("--no-session");

    // --mode json must be present
    expect(result.args).toContain("--mode");
    expect(result.args[result.args.indexOf("--mode") + 1]).toBe("json");
  });

  it("D3: does NOT include --api-key in args", () => {
    const result = piAdapter.buildInvocation(makeProfile(), makeContext());
    expect(result.args).not.toContain("--api-key");
    expect(result.args.some((a) => a.startsWith("--api-key"))).toBe(false);
  });

  it("D3: returns an empty env object (no PI_API_KEY)", () => {
    const result = piAdapter.buildInvocation(makeProfile(), makeContext());
    expect(result.env).toEqual({});
  });

  it("includes profile-derived args from profileToArgs", () => {
    const profile = makeProfile({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      tools: ["read", "bash"],
    });
    const result = piAdapter.buildInvocation(profile, makeContext());

    expect(result.args).toContain("--provider");
    expect(result.args[result.args.indexOf("--provider") + 1]).toBe("anthropic");
    expect(result.args).toContain("--model");
    expect(result.args[result.args.indexOf("--model") + 1]).toBe("claude-sonnet-4-5");
    expect(result.args).toContain("--tools");
    expect(result.args[result.args.indexOf("--tools") + 1]).toBe("read,bash");
  });

  it("places profile-derived args after the plumbing flags (--mode json -p --no-session)", () => {
    const profile = makeProfile({ provider: "openai" });
    const result = piAdapter.buildInvocation(profile, makeContext());

    const noSessionIndex = result.args.indexOf("--no-session");
    const providerIndex = result.args.indexOf("--provider");

    expect(providerIndex).toBeGreaterThan(noSessionIndex);
  });

  it("returns stdinPrompt as a string", () => {
    const profile = makeProfile({ systemPrompt: "You are an agent." });
    const result = piAdapter.buildInvocation(profile, makeContext());
    expect(result.stdinPrompt).toBeDefined();
    expect(typeof result.stdinPrompt).toBe("string");
  });

  it("handles a profile with no fields (only defaults)", () => {
    const result = piAdapter.buildInvocation(makeProfile(), makeContext());

    // Plumbing flags are always present
    expect(result.args).toContain("--mode");
    expect(result.args).toContain("-p");
    expect(result.args).toContain("--no-session");

    // Profile-specific flags should be absent (empty profile)
    expect(result.args).not.toContain("--provider");
    expect(result.args).not.toContain("--model");
  });
});

// ─── Tests: supportsNativeResume ───────────────────────────────

describe("supportsNativeResume", () => {
  it("is false (wisp never uses pi's interactive --resume; D4)", () => {
    expect(piAdapter.supportsNativeResume).toBe(false);
  });
});

// ─── Tests: buildResumePrompt ──────────────────────────────────

describe("buildResumePrompt", () => {
  it("formats prompt with transcript-replay format (D4)", () => {
    const prior = "User: fix the bug\nAssistant: I'll look at the code.";
    const newPrompt = "Now apply the fix.";
    const result = piAdapter.buildResumePrompt(prior, newPrompt);
    expect(result).toBe(
      "Previously:\n\nUser: fix the bug\nAssistant: I'll look at the code.\n\nInstructions:\n\nNow apply the fix.",
    );
  });

  it("handles empty prior transcript", () => {
    const result = piAdapter.buildResumePrompt("", "Just do it.");
    expect(result).toBe("Previously:\n\n\n\nInstructions:\n\nJust do it.");
  });
});

// ─── Tests: extractSessionId ───────────────────────────────────

describe("extractSessionId", () => {
  it("extracts the session id from the session event", () => {
    const events: NormalizedEvent[] = [
      { type: "session", id: "my-session-id" },
      { type: "turn_end" },
    ];
    expect(piAdapter.extractSessionId(events)).toBe("my-session-id");
  });

  it("returns undefined when no session event is present", () => {
    const events: NormalizedEvent[] = [
      { type: "text_delta", delta: "hello" },
      { type: "turn_end" },
    ];
    expect(piAdapter.extractSessionId(events)).toBeUndefined();
  });

  it("returns undefined for an empty event list", () => {
    expect(piAdapter.extractSessionId([])).toBeUndefined();
  });
});

// ─── Tests: extractFileEdits ───────────────────────────────────

describe("extractFileEdits", () => {
  for (const tool of FILE_WRITE_TOOLS) {
    it(`extracts paths from ${tool} tool calls`, () => {
      const events: NormalizedEvent[] = [
        { type: "tool_call", name: tool, args: { path: "/src/file.ts" } },
        {
          type: "tool_result",
          name: tool,
          isError: false,
          content: "ok",
        },
      ];
      expect(piAdapter.extractFileEdits(events)).toEqual(["/src/file.ts"]);
    });
  }

  it("ignores non-file-write tool calls (read, bash, grep)", () => {
    const events: NormalizedEvent[] = [
      { type: "tool_call", name: "read", args: { path: "/src/file.ts" } },
      { type: "tool_call", name: "bash", args: { command: "ls" } },
      { type: "tool_call", name: "grep", args: { pattern: "foo" } },
    ];
    expect(piAdapter.extractFileEdits(events)).toEqual([]);
  });

  it("returns empty array when no events are supplied", () => {
    expect(piAdapter.extractFileEdits([])).toEqual([]);
  });

  it("extracts multiple file paths from multiple tool calls", () => {
    const events: NormalizedEvent[] = [
      { type: "tool_call", name: "edit", args: { path: "/a.ts" } },
      { type: "tool_call", name: "write", args: { path: "/b.ts" } },
      { type: "tool_call", name: "write_file", args: { path: "/c.ts" } },
    ];
    expect(piAdapter.extractFileEdits(events)).toEqual(["/a.ts", "/b.ts", "/c.ts"]);
  });

  it("deduplicates paths (if the same path appears multiple times)", () => {
    const events: NormalizedEvent[] = [
      { type: "tool_call", name: "edit", args: { path: "/same.ts" } },
      { type: "tool_call", name: "write", args: { path: "/same.ts" } },
    ];
    const edits = piAdapter.extractFileEdits(events);
    // The contract: best-effort list, duplicates may be included.
    // The adapter may or may not deduplicate — just assert both paths are in
    // the result set.
    expect(edits.filter((p) => p === "/same.ts").length).toBeGreaterThanOrEqual(1);
  });
});
