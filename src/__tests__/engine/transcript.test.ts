import { describe, it, expect } from "vitest";

import type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
} from "@earendil-works/pi-ai";

import {
  formatRunsForResume,
  formatTranscript,
  getTextContent,
  extractTextParts,
  RESUME_OPTIONS,
  type SessionSnapshot,
  type TranscriptOptions,
} from "../../engine/transcript.js";

// ─── Fixture helpers ──────────────────────────────────────────────

/**
 * Build a UserMessage with the given text content.
 */
function userMsg(text: string, _parts?: TextContent[]): UserMessage {
  return {
    role: "user",
    content: text,
    timestamp: 1000,
  };
}

/**
 * Build an AssistantMessage with text content and optional tool calls.
 */
function assistantMsg(
  text: string,
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>,
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (text) {
    content.push({ type: "text" as const, text });
  }
  if (toolCalls) {
    for (const tc of toolCalls) {
      content.push({
        type: "toolCall" as const,
        id: `call-${tc.name}`,
        name: tc.name,
        arguments: tc.args,
      });
    }
  }
  return {
    role: "assistant",
    content,
    api: "anthropic" as const,
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    usage: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "stop",
    timestamp: 2000,
  };
}

/**
 * Build a ToolResultMessage.
 */
function toolResultMsg(toolName: string, content: string, isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${toolName}`,
    toolName,
    content: [{ type: "text" as const, text: content }],
    isError,
    timestamp: 3000,
  };
}

/**
 * Build a SessionSnapshot from an array of messages.
 */
function session(
  messages: (UserMessage | AssistantMessage | ToolResultMessage)[],
): SessionSnapshot {
  return { messages, finalText: messages.length > 0 ? "done" : undefined };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("extractTextParts", () => {
  it("returns text parts from a message with array content", () => {
    // Message content as array of parts
    const msg = {
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: "World" },
      ],
    };
    const parts = extractTextParts(msg);
    expect(parts).toEqual(["Hello", "World"]);
  });

  it("returns a single-element array when content is a string", () => {
    const msg = { content: "plain text" };
    const parts = extractTextParts(msg);
    expect(parts).toEqual(["plain text"]);
  });

  it("returns an empty array when content is undefined", () => {
    const msg = { content: undefined };
    const parts = extractTextParts(msg);
    expect(parts).toEqual([]);
  });

  it("filters out non-text parts (e.g. toolCall, thinking)", () => {
    const msg = {
      content: [
        { type: "text", text: "Only text" },
        { type: "toolCall", name: "read", arguments: {} },
        { type: "thinking", thinking: "hmm" },
      ],
    };
    const parts = extractTextParts(msg);
    expect(parts).toEqual(["Only text"]);
  });

  it("returns an empty array for empty content array", () => {
    const msg = { content: [] };
    const parts = extractTextParts(msg);
    expect(parts).toEqual([]);
  });
});

describe("getTextContent", () => {
  it("joins text parts with newlines", () => {
    const msg = {
      content: [
        { type: "text", text: "Line 1" },
        { type: "text", text: "Line 2" },
      ],
    };
    const text = getTextContent(msg);
    expect(text).toBe("Line 1\nLine 2");
  });

  it("returns undefined when there are no text parts", () => {
    const msg = { content: [] };
    const text = getTextContent(msg);
    expect(text).toBeUndefined();
  });

  it("returns the text when content is a string", () => {
    const msg = { content: "just a string" };
    const text = getTextContent(msg);
    expect(text).toBe("just a string");
  });
});

describe("formatTranscript", () => {
  it("formats a simple user→assistant exchange with role prefixes", () => {
    const sessions = [
      session([
        userMsg("What is the capital of France?"),
        assistantMsg("The capital of France is Paris."),
      ]),
    ];

    const result = formatTranscript(sessions, RESUME_OPTIONS);

    expect(result).toContain("User: What is the capital of France?");
    expect(result).toContain("Assistant: The capital of France is Paris.");
  });

  it("includes tool call details with args preview", () => {
    const sessions = [
      session([
        userMsg("Read the file"),
        assistantMsg("Let me read that file.", [{ name: "read", args: { path: "/src/index.ts" } }]),
        toolResultMsg("read", 'File contents: console.log("hello");'),
      ]),
    ];

    const result = formatTranscript(sessions, RESUME_OPTIONS);

    // Should contain the tool call with args preview (120 char limit)
    expect(result).toContain("Tool Call: read({");
    expect(result).toContain('"path"');
    expect(result).toContain("/src/index.ts");
  });

  it("truncates tool result content that exceeds the preview length", () => {
    const longResult = "x".repeat(600);
    const sessions = [
      session([
        userMsg("Run the analysis"),
        assistantMsg("Running analysis.", [{ name: "analyze", args: { mode: "full" } }]),
        toolResultMsg("analyze", longResult),
      ]),
    ];

    const result = formatTranscript(sessions, RESUME_OPTIONS);

    // The default RESUME_OPTIONS truncates tool results at 500 chars
    expect(result).toContain("Tool Result: ");
    // Should contain the truncated content (500 chars of x's + "...")
    expect(result).toContain("x".repeat(500) + "...");
    // Should NOT contain the full 600 chars
    expect(result).not.toContain("x".repeat(501));
  });

  it("truncates tool call args that exceed the preview length", () => {
    const longArgs = { data: "a".repeat(200) };
    const sessions = [
      session([assistantMsg("Processing...", [{ name: "bigCall", args: longArgs }])]),
    ];

    const result = formatTranscript(sessions, RESUME_OPTIONS);

    // The default RESUME_OPTIONS previews tool call args at 120 chars
    expect(result).toContain("Tool Call: bigCall(");
    // The args preview should be truncated to ~120 chars
    expect(result.length).toBeLessThan(600); // total output is reasonable
  });

  it("adds run separators when there are multiple sessions", () => {
    const sessions = [
      session([userMsg("First run"), assistantMsg("Done 1")]),
      session([userMsg("Second run"), assistantMsg("Done 2")]),
    ];

    const result = formatTranscript(sessions, RESUME_OPTIONS);

    // Should contain separators indicating multiple runs
    expect(result).toContain("--- Run 1 (2 total) ---");
    expect(result).toContain("--- Run 2 (2 total) ---");
  });

  it("does not add a run header when there is only one session", () => {
    const sessions = [session([userMsg("Single run"), assistantMsg("Done")])];

    const result = formatTranscript(sessions, RESUME_OPTIONS);

    // The runHeader function should return undefined for a single run
    expect(result).not.toContain("--- Run 1");
  });

  it("handles empty session list", () => {
    const result = formatTranscript([], RESUME_OPTIONS);
    expect(result).toBe("");
  });

  it("uses the configured part separator between messages", () => {
    const customOptions: TranscriptOptions = {
      ...RESUME_OPTIONS,
      partSeparator: " | ",
    };

    const sessions = [session([userMsg("Hi"), assistantMsg("Hello")])];

    const result = formatTranscript(sessions, customOptions);

    // Messages should be separated by " | "
    expect(result).toContain("User: Hi | Assistant: Hello");
  });

  /**
   * (b) RED test: a toolCall message part with `arguments: undefined` must NOT
   * throw when formatted.  The current implementation calls
   * `JSON.stringify(part.arguments).slice(…)` but `JSON.stringify(undefined)`
   * returns `undefined` (not a string), so `.slice()` throws a TypeError.
   * The fix will restore a `?? {}` guard (or equivalent).
   */
  it("does not throw when a toolCall has undefined arguments", () => {
    // Build a session directly — bypassing the type-safe assistantMsg helper —
    // with a toolCall whose arguments is undefined (edge case from malformed
    // API responses or serialised sessions missing the field).
    const rawSession: SessionSnapshot = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-undefined-args",
              name: "getData",
              arguments: undefined as any,
            },
          ],
          api: "anthropic",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2000,
        },
      ],
      finalText: "done",
    };

    // Must NOT throw — currently throws "Cannot read properties of undefined (reading 'slice')"
    expect(() => formatTranscript([rawSession], RESUME_OPTIONS)).not.toThrow();

    const result = formatTranscript([rawSession], RESUME_OPTIONS);
    expect(result).toContain("Tool Call: getData(");
  });
});

describe("formatRunsForResume", () => {
  it("produces a formatted transcript using RESUME_OPTIONS defaults", () => {
    const sessions = [
      session([
        userMsg("What is the weather?"),
        assistantMsg("The weather is sunny.", [
          { name: "getWeather", args: { location: "London" } },
        ]),
        toolResultMsg("getWeather", '{"weather": "sunny", "temp": 22}'),
      ]),
    ];

    const result = formatRunsForResume(sessions);

    // Should be a string
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);

    // Should contain expected prefixes
    expect(result).toContain("User: What is the weather?");
    expect(result).toContain("Assistant: The weather is sunny.");
    expect(result).toContain("Tool Call: getWeather(");
    expect(result).toContain("Tool Result:");
  });

  it("returns empty string for empty sessions", () => {
    const result = formatRunsForResume([]);
    expect(result).toBe("");
  });

  it("formats a multi-turn conversation coherently", () => {
    // Simulate a longer conversation with multiple tool calls
    const sessions = [
      session([
        userMsg("Find and fix the bug in auth.ts"),
        assistantMsg("I'll look at the auth module.", [
          { name: "read", args: { path: "auth.ts" } },
        ]),
        toolResultMsg("read", "export function login(user, pass) { /* ... */ }"),
        assistantMsg("I see the issue. The password isn't hashed.", [
          { name: "edit", args: { path: "auth.ts", oldText: "plain", newText: "hash" } },
        ]),
        toolResultMsg("edit", "Applied edit to auth.ts"),
        assistantMsg("Done! I've fixed the auth module."),
      ]),
    ];

    const result = formatRunsForResume(sessions);

    // All messages should appear in order
    expect(result).toContain("Find and fix the bug in auth.ts");
    expect(result).toContain("I'll look at the auth module.");
    expect(result).toContain("I see the issue");
    expect(result).toContain("Done! I've fixed the auth module.");
    expect(result).toContain("Tool Call: read(");
    expect(result).toContain("Tool Call: edit(");
  });
});
