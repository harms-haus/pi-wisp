// ═══════════════════════════════════════════════════════════════════════════
// Session persistence (S21 / IMPLEMENTATION_PROMPT §12).
//
// Writes and reads per-node session files in a run's `sessions/` subdirectory.
// Each file is a single JSON blob containing the message transcript, metadata,
// and final output. Messages are capped at MAX_MESSAGES_PER_SESSION=500 —
// when the limit is exceeded the oldest message(s) are shifted.
//
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { MAX_MESSAGES_PER_SESSION, RUN_SESSIONS_DIR } from "../constants.js";

/** Shape of a persisted session file. Mirrors IMPLEMENTATION_PROMPT §12. */
export interface PersistedSession {
  sessionId: string;
  nodeId?: string;
  agentType: string;
  profile?: string;
  provider?: string;
  model?: string;
  /** Captured messages (user/assistant/tool). Capped at MAX_MESSAGES_PER_SESSION. */
  messages: unknown[];
  finalText?: string;
  toolCallCount: number;
  durationMs: number;
  costUsd?: number;
  error?: string;
}

/**
 * Write a session JSON file to `<runDir>/sessions/<sessionId>.json`.
 *
 * When `messages` exceeds `MAX_MESSAGES_PER_SESSION` the oldest entries are
 * shifted so the file never contains more than the cap. Optional fields whose
 * value is `undefined` are omitted by `JSON.stringify`.
 */
export function writeSession(runDir: string, session: PersistedSession): void {
  const sessionsDir = join(runDir, RUN_SESSIONS_DIR);
  mkdirSync(sessionsDir, { recursive: true });

  const messages =
    session.messages.length > MAX_MESSAGES_PER_SESSION
      ? session.messages.slice(session.messages.length - MAX_MESSAGES_PER_SESSION)
      : session.messages;

  const filePath = join(sessionsDir, `${session.sessionId}.json`);
  writeFileSync(filePath, JSON.stringify({ ...session, messages }), "utf-8");
}

/**
 * Read a session JSON file from `<runDir>/sessions/<sessionId>.json`.
 *
 * @returns The deserialised session, or `undefined` when the file does not
 *          exist or is corrupt (resilient against partial runs / missing or
 *          truncated sessions).
 */
export function readSession(runDir: string, sessionId: string): PersistedSession | undefined {
  const sessionsDir = resolve(join(runDir, RUN_SESSIONS_DIR));
  const filePath = resolve(join(sessionsDir, `${sessionId}.json`));
  // Confine the file strictly inside sessionsDir. `sessionId` is read from the
  // on-disk run manifest on resume, so a compromised run dir could supply a
  // traversal id (e.g. "../../sensitive"); reject any escape (via "..", an
  // absolute path, or pointing at the directory itself).
  const rel = relative(sessionsDir, filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    console.warn(
      `[wisp] readSession: refusing sessionId outside sessions directory: ${JSON.stringify(sessionId)}`,
    );
    return undefined;
  }
  if (!existsSync(filePath)) return undefined;
  const raw = readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw) as PersistedSession;
  } catch (err) {
    // A corrupt or truncated session file must not crash reconstruction —
    // the doc promises resilience against partial runs.
    console.error(`[wisp] readSession: failed to parse ${filePath}`, err);
    return undefined;
  }
}
