/**
 * Engine — Transcript replay (for .loop / .reviewLoop worker continuity).
 *
 * Ports `pi-subagents/src/format-transcript.ts` (+ `extractTextParts` from its
 * `utils.ts`), adapted to wisp's session shape. Iterates over run sessions,
 * extracts text/tool calls/tool results from messages, applies role prefixes,
 * and truncates tool call args (120 chars) and tool results (500 chars).
 *
 * Per D4, transcript-replay is used ONLY in .loop / .reviewLoop workers.
 * General node retries use a FRESH session. The transcript feeds
 * `buildResumePrompt` for worker continuity across loop iterations.
 *
 * The session shape is wisp's own: `{ messages: Message[], finalText?: string }`
 * where Message follows pi-ai's Message type.
 */

import type { Message } from "@earendil-works/pi-ai";

/**
 * A wisp session snapshot as stored in `sessions/{sessionId}.json`.
 * For transcript replay we only need `messages`.
 *
 * Each message can be a full pi-ai Message or a minimal { role, content }
 * object (sufficient for the role-prefixed formatter).
 */
export interface SessionSnapshot {
  messages: Message[];
  finalText?: string;
  // Other fields (sessionId, nodeId, agentType, etc.) are ignored for replay.
}

/**
 * Options controlling how transcript runs are formatted.
 */
export interface TranscriptOptions {
  /** Whether to include user messages in the transcript. */
  includeUserMessages: boolean;
  /** Prefix for user messages. */
  userPrefix: string;
  /** Prefix for assistant text messages. */
  assistantPrefix: string;
  /** Prefix format for tool calls. Use `{name}` and `{args}` placeholders. */
  toolCallPrefix: string;
  /** Prefix for tool result messages. */
  toolResultPrefix: string;
  /** Maximum characters for tool result text before truncation. */
  toolResultTruncation: number;
  /** Maximum characters for tool call arguments preview. */
  toolCallPreviewLength: number;
  /** Separator used between formatted parts/lines. */
  partSeparator: string;
  /**
   * Function to format the run header when there are multiple runs.
   * Receives (runIndex, totalRuns, run). Return undefined to skip header.
   */
  runHeader: (runIndex: number, totalRuns: number, run: SessionSnapshot) => string | undefined;
}

/**
 * Default options for formatting runs when resuming a session.
 */
export const RESUME_OPTIONS: TranscriptOptions = {
  includeUserMessages: true,
  userPrefix: "User: ",
  assistantPrefix: "Assistant: ",
  toolCallPrefix: "Tool Call: {name}({args})",
  toolResultPrefix: "Tool Result: ",
  toolResultTruncation: 500,
  toolCallPreviewLength: 120,
  partSeparator: "\n\n",
  runHeader: (i: number, total: number, _run: SessionSnapshot): string | undefined =>
    total > 1 ? `--- Run ${i + 1} (${total} total) ---` : undefined,
};

/** Format tool calls from an assistant message's content into transcript lines. */
function formatToolCalls(content: unknown, prefix: string, previewLength: number): string[] {
  if (typeof content === "string" || !Array.isArray(content)) return [];
  const results: string[] = [];
  for (const raw of content) {
    if (
      raw !== null &&
      typeof raw === "object" &&
      (raw as { type?: unknown }).type === "toolCall"
    ) {
      const part = raw as { name: string; arguments?: unknown };
      const rawArgs: unknown = part.arguments;
      const args = JSON.stringify(rawArgs ?? {}).slice(0, previewLength);
      results.push(prefix.replace("{name}", part.name).replace("{args}", args));
    }
  }
  return results;
}

/** Format a single message into transcript lines, honouring the given options. */
function formatMessage(
  msg: { role: string; content?: unknown },
  options: TranscriptOptions,
): string[] {
  const parts: string[] = [];

  if (msg.role === "user" && options.includeUserMessages) {
    const text = getTextContent(msg);
    if (text) parts.push(`${options.userPrefix}${text}`);
  } else if (msg.role === "assistant") {
    const text = getTextContent(msg);
    if (text) parts.push(`${options.assistantPrefix}${text}`);
    parts.push(
      ...formatToolCalls(msg.content, options.toolCallPrefix, options.toolCallPreviewLength),
    );
  } else if (msg.role === "toolResult") {
    const text = getTextContent(msg);
    if (text) {
      const truncated =
        text.length > options.toolResultTruncation
          ? `${text.slice(0, options.toolResultTruncation)}...`
          : text;
      parts.push(`${options.toolResultPrefix}${truncated}`);
    }
  }

  return parts;
}

/**
 * Format a complete transcript from an array of session snapshots.
 *
 * Iterates over sessions, extracts text/tool calls/tool results from messages,
 * applies role prefixes, truncates tool call args and tool results, and adds
 * run separators when there is more than one session.
 *
 * @param sessions - Array of session snapshots (typically in chronological order).
 * @param options  - Formatting options.
 * @returns A human-readable transcript string.
 */
export function formatTranscript(sessions: SessionSnapshot[], options: TranscriptOptions): string {
  const parts: string[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const run = sessions[i];
    if (!run) continue;
    const header = options.runHeader(i, sessions.length, run);
    if (header) parts.push(header);

    for (const msg of run.messages) {
      parts.push(...formatMessage(msg, options));
    }
  }

  return parts.join(options.partSeparator);
}

/**
 * Format previous runs' session data for inclusion in a resume prompt.
 *
 * Convenience wrapper over `formatTranscript` using `RESUME_OPTIONS`.
 *
 * @param sessions - Array of prior session snapshots.
 * @returns A formatted transcript string ready for injection into a resume prompt.
 */
export function formatRunsForResume(sessions: SessionSnapshot[]): string {
  return formatTranscript(sessions, RESUME_OPTIONS);
}

/**
 * Extract text content from a Message's content field.
 *
 * Handles string content, array-of-parts content (text parts), and gracefully
 * returns `undefined` when there are no text parts.
 */
export function getTextContent(msg: { content?: unknown }): string | undefined {
  const parts = extractTextParts(msg);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Extract text parts from a message's content, regardless of role.
 *
 * Handles string content, array-of-parts content (text parts only), and
 * gracefully returns an empty array for anything else.
 *
 * @param msg - A Message-like object with a `content` property.
 * @returns An array of text strings extracted from the content.
 */
export function extractTextParts(msg: { content?: unknown }): string[] {
  const content = msg.content;
  if (!content) return [];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const results: string[] = [];
  for (const raw of content as unknown[]) {
    if (
      raw !== null &&
      typeof raw === "object" &&
      (raw as { type?: unknown }).type === "text" &&
      typeof (raw as { text?: unknown }).text === "string"
    ) {
      results.push((raw as { text: string }).text);
    }
  }
  return results;
}
