// ═══════════════════════════════════════════════════════════════════════════
// pi adapter — the ONLY v1 adapter (D1 / DECISIONS.md).
//
// Translates the pi `--mode json` output stream (JSONL) into normalized events
// consumed by the wisp engine. Implements the AgentAdapter interface §8.2.
//
// ### pi event model (docs/json.md)
//   • session                     → NormalizedEvent(type:"session")
//   • tool_execution_start        → NormalizedEvent(type:"tool_call")
//   • tool_execution_end          → NormalizedEvent(type:"tool_result")
//   • message_update (text_delta) → NormalizedEvent(type:"text_delta")
//   • message_end (assistant)     → NormalizedEvent(type:"message_complete")
//   • turn_end                    → NormalizedEvent(type:"turn_end")
//   • All others                  → null (ignorable)
//   • done event                  → synthesised by buildDoneEvent() at stream end
//
// ### D3 — API keys
//   This adapter does NOT emit --api-key or set PI_API_KEY in the spawned
//   env. The harness inherits the host environment (assumed pre-configured).
//
// ### D4 — Resume
//   supportsNativeResume: false — wisp never uses pi's interactive --resume.
//   Loop/reviewLoop continuity uses transcript-replay via buildResumePrompt.
// ═══════════════════════════════════════════════════════════════════════════

import { profileToArgs } from "../profiles/to-args.js";
import { getAgentDir } from "../constants.js";
import type {
  AgentAdapter,
  AdapterInvocation,
  NodeInvocationContext,
  ResolvedProfile,
} from "./types.js";
import type { NormalizedEvent } from "../types.js";
import {
  finalTextFromEvents,
  sessionIdFromEvents,
  toolCountFromEvents as eventsToolCount,
  fileEditsFromEvents,
} from "../engine/events.js";

// ─── Tool names treated as file writes ──────────────────────────

/**
 * Best-effort set of tool names whose `args.path` counts as a file edit.
 * Used by {@link piAdapter.extractFileEdits}.
 */
export const FILE_WRITE_TOOLS = new Set(["edit", "write", "write_file"]);

// ─── Coercion helpers ───────────────────────────────────────────

/**
 * Coerce an unknown value to a string, returning `""` for anything that is not
 * already a string (avoids `String()`'s "[object Object]" default). pi always
 * emits these fields as strings; the empty fallback is only for malformed input.
 */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Extract assistant text content from a pi message's `content` field.
 *
 * - A bare string is returned as-is.
 * - An array of parts is filtered to `{type:"text"}` parts and their `text`
 *   joined. Returns `null` when there are no text parts (so the caller can
 *   suppress an empty delta).
 */
function extractAssistantText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part && typeof part === "object" && !Array.isArray(part)) {
        const p = part as Record<string, unknown>;
        if (p.type === "text") {
          parts.push(asString(p.text));
        }
      }
    }
    if (parts.length === 0) return null;
    return parts.join("");
  }
  return null;
}

// ─── pi invocation detection ────────────────────────────────────

/**
 * Determine how to invoke the pi binary.
 *
 * Mirrors `getPiInvocation()` from `pi-subagents/src/spawner.ts`: when pi is
 * running as a normal Node script, re-invoke the same entrypoint via
 * `process.execPath`; when running as a compiled bun binary (argv[1] under
 * `/$bunfs/root/`), invoke the `pi` bin directly.
 */
function getPiInvocation(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/")) {
    return { command: process.execPath, args: [currentScript] };
  }
  return { command: "pi", args: [] };
}

// ─── JSONL parsing helpers ──────────────────────────────────────

/** A parsed pi JSONL event line as an untyped record. */
type EventObject = Record<string, unknown>;

/**
 * Parse and validate a single stdout line into a typed event object.
 * Returns `null` for blank lines, non-JSON, primitives, arrays, or objects
 * without a string `type` field.
 */
function tryParseEventObject(line: string): EventObject | null {
  if (line.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as EventObject;
  if (typeof obj.type !== "string") return null;
  return obj;
}

/** Map a `session` event → `{type:"session", id}`. */
function mapSessionEvent(obj: EventObject): NormalizedEvent {
  return { type: "session", id: asString(obj.id) };
}

/** Map a `tool_execution_start` event → `{type:"tool_call", name, args}`. */
function mapToolCallEvent(obj: EventObject): NormalizedEvent {
  return { type: "tool_call", name: asString(obj.toolName), args: obj.args };
}

/** Map a `tool_execution_end` event → `{type:"tool_result", name, isError, content}`. */
function mapToolResultEvent(obj: EventObject): NormalizedEvent {
  const result = obj.result;
  let content: string;
  if (typeof result === "string") {
    content = result;
  } else if (result === undefined) {
    content = "";
  } else {
    content = JSON.stringify(result);
  }
  return {
    type: "tool_result",
    name: asString(obj.toolName),
    isError: obj.isError === true,
    content,
  };
}

/** Map a `message_update` event → `{type:"text_delta", delta}` (or null). */
function mapMessageUpdateEvent(obj: EventObject): NormalizedEvent | null {
  const ev = obj.assistantMessageEvent;
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return null;
  const e = ev as EventObject;
  if (e.type !== "text_delta") return null;
  return { type: "text_delta", delta: asString(e.delta) };
}

/** Map a `message_end` event → `{type:"message_complete", text}` (or null). */
function mapMessageEndEvent(obj: EventObject): NormalizedEvent | null {
  const msg = obj.message;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const m = msg as EventObject;
  if (m.role !== "assistant") return null;
  const text = extractAssistantText(m.content);
  if (text === null) return null;
  return { type: "message_complete", text };
}

// ─── piAdapter ─────────────────────────────────────────────────

/**
 * The canonical pi adapter instance (the only v1 adapter — D1).
 */
export const piAdapter: AgentAdapter = {
  type: "pi",
  supportsNativeResume: false,

  // ── buildInvocation ────────────────────────────────────────
  //
  // Args layout:
  //   [...piBinArgs, "--mode", "json", "-p", "--no-session", ...profileArgs]
  //
  // `-p` MUST be immediately followed by `--no-session` — the `-p` flag
  // swallows the next positional, so a prompt passed as a trailing positional
  // would be consumed (SCOUTING §2 / WEB §2a). The prompt is instead placed
  // into `stdinPrompt` (from `ctx.prompt`, rehydrated by the executor) and
  // piped to stdin by the spawner at spawn time.
  //
  // D3: NO `--api-key` flag and an empty env (no PI_API_KEY). The spawned
  // harness inherits the host environment, which is assumed pre-configured.
  buildInvocation(profile: ResolvedProfile, ctx: NodeInvocationContext): AdapterInvocation {
    const invocation = getPiInvocation();
    const { args: profileArgs } = profileToArgs(profile.profile, ctx.cwd, getAgentDir());

    const args = [...invocation.args, "--mode", "json", "-p", "--no-session", ...profileArgs];

    return {
      command: invocation.command,
      args,
      // `ctx.prompt` is rehydrated by the executor (static prompt or
      // promptFn, or a transcript-replay prompt for .loop/.reviewLoop workers).
      env: {},
      stdinPrompt: ctx.prompt ?? "",
    };
  },

  // ── parseEventStreamLine ──────────────────────────────────
  parseEventStreamLine(line: string): NormalizedEvent | null {
    const obj = tryParseEventObject(line);
    if (obj === null) return null;

    switch (obj.type) {
      case "session":
        return mapSessionEvent(obj);
      case "tool_execution_start":
        return mapToolCallEvent(obj);
      case "tool_execution_end":
        return mapToolResultEvent(obj);
      case "message_update":
        return mapMessageUpdateEvent(obj);
      case "message_end":
        return mapMessageEndEvent(obj);
      case "turn_end":
        return { type: "turn_end" };
      default:
        // agent_start/end, turn_start, message_start, queue_update,
        // compaction_*, auto_retry_*, tool_execution_update, etc. → ignore.
        // No known pi --mode json event carries an error payload.
        return null;
    }
  },

  // ── buildResumePrompt ─────────────────────────────────────
  //
  // Transcript-replay format (D4):
  //   "Previously:\n\n${priorTranscript}\n\nInstructions:\n\n${newPrompt}"
  buildResumePrompt(priorTranscript: string, newPrompt: string): string {
    return `Previously:\n\n${priorTranscript}\n\nInstructions:\n\n${newPrompt}`;
  },

  // ── extractSessionId ──────────────────────────────────────
  extractSessionId(events: NormalizedEvent[]): string | undefined {
    return sessionIdFromEvents(events);
  },

  // ── extractFileEdits ──────────────────────────────────────
  extractFileEdits(events: NormalizedEvent[]): string[] {
    return fileEditsFromEvents(events, FILE_WRITE_TOOLS);
  },

  // ── toolCountFromEvents ───────────────────────────────────
  //
  // Explicit adapter implementation (optional on the interface; the engine
  // has an identical fallback, but providing it makes the adapter complete).
  toolCountFromEvents(events: NormalizedEvent[]): number {
    return eventsToolCount(events);
  },
};

// ─── buildDoneEvent ───────────────────────────────────────────

/**
 * Synthesise a `done` NormalizedEvent from the parsed event stream.
 *
 * Called by the engine when the subprocess exits and the stream is complete.
 * Scans the event array for:
 *   • The session id from the first `session` event
 *   • The final assistant text, preferring the last `message_complete` event's
 *     full text (used once) and otherwise concatenating `text_delta` deltas
 *   • The tool call count from `tool_call` events
 *   • The caller-supplied wall-clock duration in ms
 */
export function buildDoneEvent(
  events: NormalizedEvent[],
  durationMs: number,
): NormalizedEvent & { type: "done" } {
  return {
    type: "done",
    sessionId: sessionIdFromEvents(events) ?? "",
    finalText: finalTextFromEvents(events),
    durationMs,
    toolCallCount: eventsToolCount(events),
  };
}
