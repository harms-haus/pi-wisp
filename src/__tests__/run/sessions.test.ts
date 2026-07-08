// ═══════════════════════════════════════════════════════════════════════════
// RED tests: writeSession / readSession (S21 / PLAN §12).
//
// These tests define the contract for the production implementation. Each test
// expects the IMPLEMENTATION to fulfil the described behaviour. Currently the
// implementation is a STUB that throws; after the test pass confirms the RED
// state, the stubs are replaced.
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { MAX_MESSAGES_PER_SESSION, RUN_SESSIONS_DIR } from "../../constants.js";
import type { PersistedSession } from "../../run/sessions.js";
import { writeSession, readSession } from "../../run/sessions.js";

// ─── Helpers ──────────────────────────────────────────────────────

/** Create a temp directory for each test and clean it up after. */
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wisp-sessions-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build a minimal PersistedSession with defaults that can be overridden.
 */
function makeSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 10)}`,
    agentType: "pi",
    messages: [],
    toolCallCount: 0,
    durationMs: 100,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("writeSession", () => {
  it("writes a session JSON file at sessions/{sessionId}.json", () => {
    const session = makeSession({ sessionId: "test-001" });
    writeSession(tmpDir, session);

    const filePath = join(tmpDir, RUN_SESSIONS_DIR, "test-001.json");
    expect(existsSync(filePath)).toBe(true);

    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as PersistedSession;
    expect(parsed.sessionId).toBe("test-001");
  });

  it("persists all top-level fields: sessionId, nodeId, agentType, profile, provider, model, messages, finalText, toolCallCount, durationMs, costUsd, error", () => {
    const session = makeSession({
      sessionId: "test-002",
      nodeId: "node-a",
      agentType: "codex",
      profile: "codex-reviewer",
      provider: "openai",
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
      finalText: "Hello world",
      toolCallCount: 3,
      durationMs: 1234,
      costUsd: 0.05,
      error: undefined,
    });
    writeSession(tmpDir, session);

    const filePath = join(tmpDir, RUN_SESSIONS_DIR, "test-002.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as PersistedSession;

    expect(parsed).toEqual({
      sessionId: "test-002",
      nodeId: "node-a",
      agentType: "codex",
      profile: "codex-reviewer",
      provider: "openai",
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
      finalText: "Hello world",
      toolCallCount: 3,
      durationMs: 1234,
      costUsd: 0.05,
    });
  });

  it("persists error field when present", () => {
    const session = makeSession({
      sessionId: "test-003",
      error: "Agent crashed",
    });
    writeSession(tmpDir, session);

    const filePath = join(tmpDir, RUN_SESSIONS_DIR, "test-003.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as PersistedSession;
    expect(parsed.error).toBe("Agent crashed");
  });

  it("caps messages at MAX_MESSAGES_PER_SESSION=500, shifting oldest", () => {
    // Build 501 messages (indices 0..500)
    const messages = Array.from({ length: 501 }, (_, i) => ({
      role: "user" as const,
      content: `message-${i}`,
    }));
    const session = makeSession({
      sessionId: "test-cap",
      messages,
    });
    writeSession(tmpDir, session);

    const filePath = join(tmpDir, RUN_SESSIONS_DIR, "test-cap.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as PersistedSession;

    // Must have exactly 500 messages
    expect(parsed.messages).toHaveLength(MAX_MESSAGES_PER_SESSION);

    // The oldest (index 0) should have been shifted; index 1 becomes the first
    const first = (parsed.messages[0] as { content: string }).content;
    expect(first).toBe("message-1");
    const last = (parsed.messages[parsed.messages.length - 1] as { content: string }).content;
    expect(last).toBe("message-500");
  });

  it("does not cap messages when below MAX_MESSAGES_PER_SESSION", () => {
    const messages = Array.from({ length: 3 }, (_, i) => ({
      role: "user" as const,
      content: `msg-${i}`,
    }));
    const session = makeSession({
      sessionId: "test-below-cap",
      messages,
    });
    writeSession(tmpDir, session);

    const filePath = join(tmpDir, RUN_SESSIONS_DIR, "test-below-cap.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as PersistedSession;
    expect(parsed.messages).toHaveLength(3);
    expect((parsed.messages[0] as { content: string }).content).toBe("msg-0");
  });

  it("overwrites an existing session file with the same sessionId", () => {
    const session1 = makeSession({
      sessionId: "test-overwrite",
      finalText: "version-1",
    });
    const session2 = makeSession({
      sessionId: "test-overwrite",
      finalText: "version-2",
    });

    writeSession(tmpDir, session1);
    writeSession(tmpDir, session2);

    const filePath = join(tmpDir, RUN_SESSIONS_DIR, "test-overwrite.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as PersistedSession;
    expect(parsed.finalText).toBe("version-2");
  });
});

describe("readSession", () => {
  it("returns the deserialised session for an existing file", () => {
    const session = makeSession({
      sessionId: "read-001",
      finalText: "Read me",
      toolCallCount: 7,
    });
    writeSession(tmpDir, session);

    const result = readSession(tmpDir, "read-001");
    expect(result).toBeDefined();
    expect(result!.sessionId).toBe("read-001");
    expect(result!.finalText).toBe("Read me");
    expect(result!.toolCallCount).toBe(7);
  });

  it("returns undefined when the session file does not exist", () => {
    const result = readSession(tmpDir, "nonexistent-session");
    expect(result).toBeUndefined();
  });

  it("round-trips a session with full metadata", () => {
    const original = makeSession({
      sessionId: "roundtrip-001",
      nodeId: "node-b",
      agentType: "pi",
      profile: "default",
      provider: "anthropic",
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Do X" },
        { role: "assistant", content: "Done" },
      ],
      finalText: "Done",
      toolCallCount: 5,
      durationMs: 2345,
      costUsd: 0.12,
    });

    writeSession(tmpDir, original);
    const loaded = readSession(tmpDir, "roundtrip-001")!;

    expect(loaded).toEqual(original);
  });
});
