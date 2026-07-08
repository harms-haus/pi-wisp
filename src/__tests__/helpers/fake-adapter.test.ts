// ═══════════════════════════════════════════════════════════════════════════
// FakeAgentAdapter smoke test (S25 acceptance).
//
// Asserts a scripted FakeAgentAdapter emits its events in order and reports the
// configured sessionId / file-edits / toolCount / cost across the behavior modes.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from "vitest";

import { createFakeAdapter } from "./fake-adapter.js";
import type { NodeInvocationContext } from "../../adapters/types.js";
import type { NormalizedEvent } from "../../types.js";

function collect(adapter: ReturnType<typeof createFakeAdapter>, ctx?: NodeInvocationContext) {
  const events: NormalizedEvent[] = [];
  return {
    events,
    done: adapter.emitEvents((e) => events.push(e), ctx),
  };
}

describe("FakeAgentAdapter (smoke)", () => {
  // ── default success sequence, in order ───────────────────────

  it("emits the default success sequence in order", async () => {
    const adapter = createFakeAdapter({
      sessionId: "s-1",
      finalText: "done",
      fileEdits: ["a.ts"],
      toolCount: 1,
      costUsd: 0.5,
    });
    const { events, done } = collect(adapter);
    await done;

    expect(events.map((e) => e.type)).toEqual([
      "session",
      "text_delta",
      "tool_call",
      "tool_result",
      "turn_end",
      "done",
    ]);
    expect(events[0]).toEqual({ type: "session", id: "s-1" });
    const last = events[events.length - 1];
    expect(last).toMatchObject({
      type: "done",
      sessionId: "s-1",
      finalText: "done",
      toolCallCount: 1,
      costUsd: 0.5,
    });
  });

  // ── metadata extraction from configured values ───────────────

  it("reports the configured sessionId, file edits, tool count, and cost", () => {
    const adapter = createFakeAdapter({
      sessionId: "s-2",
      fileEdits: ["x.ts", "y.ts"],
      toolCount: 3,
      costUsd: 1.25,
    });
    const events: NormalizedEvent[] = [
      { type: "session", id: "s-2" },
      {
        type: "done",
        sessionId: "s-2",
        finalText: "",
        durationMs: 0,
        toolCallCount: 3,
        costUsd: 1.25,
      },
    ];

    expect(adapter.extractSessionId(events)).toBe("s-2");
    expect(adapter.extractFileEdits(events)).toEqual(["x.ts", "y.ts"]);
    expect(adapter.toolCountFromEvents(events)).toBe(3);
    expect(adapter.costFromEvents(events)).toBe(1.25);
  });

  // ── metadata derived from events when not configured ─────────

  it("derives sessionId/edits/toolCount/cost from events when not configured", () => {
    const adapter = createFakeAdapter();
    const events: NormalizedEvent[] = [
      { type: "session", id: "derived" },
      { type: "tool_call", name: "edit", args: { path: "src/a.ts" } },
      { type: "tool_call", name: "grep", args: { pattern: "x" } }, // not a file-write tool
      { type: "tool_call", name: "write_file", args: { path: "src/b.ts" } },
      {
        type: "done",
        sessionId: "derived",
        finalText: "",
        durationMs: 9,
        toolCallCount: 3,
        costUsd: 2,
      },
    ];

    expect(adapter.extractSessionId(events)).toBe("derived");
    expect(adapter.extractFileEdits(events)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(adapter.toolCountFromEvents(events)).toBe(3);
    expect(adapter.costFromEvents(events)).toBe(2);
  });

  // ── fail-after-events mode ────────────────────────────────────

  it("fail-after-events mode truncates then emits a non-retryable error", async () => {
    const adapter = createFakeAdapter({
      mode: "fail-after-events",
      failAfterEvents: 1,
      sessionId: "s-3",
      errorMessage: "boom",
    });
    const { events, done } = collect(adapter);
    await done;

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "session", id: "s-3" });
    expect(events[1]).toEqual({ type: "error", message: "boom", retryable: false });
  });

  // ── retryable-error mode ──────────────────────────────────────

  it("retryable-error mode emits a retryable error", async () => {
    const adapter = createFakeAdapter({
      mode: "retryable-error",
      failAfterEvents: 0,
      sessionId: "s-4",
    });
    const { events, done } = collect(adapter);
    await done;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", retryable: true });
  });

  // ── custom scripted sequence ──────────────────────────────────

  it("delivers a custom scripted event sequence verbatim in order", async () => {
    const script: NormalizedEvent[] = [
      { type: "session", id: "custom" },
      { type: "text_delta", delta: "hi" },
      { type: "done", sessionId: "custom", finalText: "hi", durationMs: 5, toolCallCount: 0 },
    ];
    const adapter = createFakeAdapter({ events: script });
    const { events, done } = collect(adapter);
    await done;

    expect(events).toEqual(script);
  });

  // ── per-attempt events factory (retry / resume testing) ───────

  it("supports a per-attempt events factory (fail then succeed)", async () => {
    const adapter = createFakeAdapter({
      events: (ctx?: NodeInvocationContext): NormalizedEvent[] => {
        const attempt = ctx?.attempt ?? 1;
        if (attempt < 2) {
          return [{ type: "error", message: "transient", retryable: true }];
        }
        return [
          { type: "session", id: "retry-session" },
          {
            type: "done",
            sessionId: "retry-session",
            finalText: "recovered",
            durationMs: 10,
            toolCallCount: 0,
          },
        ];
      },
    });

    const first = collect(adapter, { nodeId: "n", attempt: 1 });
    await first.done;
    expect(first.events).toEqual([{ type: "error", message: "transient", retryable: true }]);

    const second = collect(adapter, { nodeId: "n", attempt: 2 });
    await second.done;
    expect(second.events.map((e) => e.type)).toEqual(["session", "done"]);
    expect(second.events[second.events.length - 1]).toMatchObject({
      type: "done",
      finalText: "recovered",
    });
  });

  // ── no-op invocation + parseEventStreamLine ───────────────────

  it("buildInvocation returns a no-op invocation and records ctx; parseEventStreamLine returns null", () => {
    const adapter = createFakeAdapter();
    const ctx = { nodeId: "n", attempt: 1 };
    const inv = adapter.buildInvocation({ profile: {}, source: "inline" }, ctx);

    expect(inv).toEqual({ command: "fake", args: [], env: {}, stdinPrompt: "" });
    expect(adapter.invocations).toEqual([ctx]);
    expect(adapter.parseEventStreamLine('{"type":"session"}')).toBeNull();
  });

  it("supportsNativeResume is false and buildResumePrompt mirrors the transcript-replay format", () => {
    const adapter = createFakeAdapter();
    expect(adapter.supportsNativeResume).toBe(false);
    expect(adapter.buildResumePrompt("PRIOR", "NEW")).toBe(
      "Previously:\n\nPRIOR\n\nInstructions:\n\nNEW",
    );
  });

  // ── abort signal stops emission ───────────────────────────────

  it("stops emitting when the abort signal is already aborted", async () => {
    const script: NormalizedEvent[] = [
      { type: "session", id: "ab" },
      { type: "turn_end" },
      { type: "done", sessionId: "ab", finalText: "", durationMs: 0, toolCallCount: 0 },
    ];
    const adapter = createFakeAdapter({ events: script });
    const controller = new AbortController();
    controller.abort();

    const events: NormalizedEvent[] = [];
    await adapter.emitEvents((e) => events.push(e), undefined, controller.signal);

    expect(events).toEqual([]);
  });

  // ── delayMs between events ────────────────────────────────────

  it("respects delayMs between events", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createFakeAdapter({
        delayMs: 50,
        events: [
          { type: "session", id: "d" },
          { type: "turn_end" },
          { type: "done", sessionId: "d", finalText: "", durationMs: 0, toolCallCount: 0 },
        ],
      });
      const events: NormalizedEvent[] = [];
      const promise = adapter.emitEvents((e) => events.push(e));

      // Advance enough to flush all inter-event sleeps.
      await vi.advanceTimersByTimeAsync(200);
      await promise;

      expect(events.map((e) => e.type)).toEqual(["session", "turn_end", "done"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
