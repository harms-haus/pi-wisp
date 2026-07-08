// ═══════════════════════════════════════════════════════════════════════════
// Adapter-layer types — AgentAdapter interface, NodeInvocationContext, and
// the AdapterInvocation return type.
//
// WispProfile, ResolvedProfile, and ThinkingLevel are imported from the
// canonical definition in src/profiles/types.ts (kb-3 stable) — adapter
// consumers automatically use the same types as the profile pipeline.
//
// NormalizedEvent lives in src/types.ts (the canonical definition); we re-export
// it here so adapter consumers have a single import.
// ═══════════════════════════════════════════════════════════════════════════

import type { NormalizedEvent } from "../types.js";
import type { ResolvedProfile, ThinkingLevel, WispProfile } from "../profiles/types.js";

// Re-exports so adapter consumers can import everything from one place.
export type { NormalizedEvent };
export type { ResolvedProfile, ThinkingLevel, WispProfile };

// ─── NodeInvocationContext ────────────────────────────────────────

/**
 * Context supplied to `AgentAdapter.buildInvocation()` at the moment a node is
 * scheduled for execution. Contains the current attempt number and node
 * identity so the adapter can produce correct CLI args.
 */
export interface NodeInvocationContext {
  /** The IR node id being invoked. */
  nodeId: string;
  /** Current attempt number (1-based). Fresh session each retry (D4). */
  attempt: number;
  /** Session id from a prior attempt (only populated for transcript-replay loops). */
  sessionId?: string;
  /** Node-level `cwd` override (if any). */
  cwd?: string;
  /**
   * The final prompt text for this node (rehydrated by the executor from the
   * node's static `prompt` or `promptFn`, or a transcript-replay prompt for
   * `.loop`/`.reviewLoop` workers). Adapters place this into `stdinPrompt`;
   * the spawner pipes it to the subprocess on stdin (NOT a trailing
   * positional — the `-p` swallowing trap).
   */
  prompt?: string;
}

// ─── AdapterInvocation ────────────────────────────────────────────

/**
 * The CLI invocation spec produced by `AgentAdapter.buildInvocation()`.
 *
 * Every adapter must return a command, arguments, environment overrides, and
 * the stdin prompt that the engine should pipe into the subprocess.
 */
export interface AdapterInvocation {
  /** Executable path or name. */
  command: string;
  /** CLI arguments. */
  args: string[];
  /** Environment variable overrides (merged into the parent process env). */
  env: Record<string, string>;
  /** Content piped to the subprocess on stdin. */
  stdinPrompt: string;
}

// ─── AgentAdapter (§8.2 + D2) ─────────────────────────────────────

/**
 * Contract every agent adapter must satisfy.
 *
 * An adapter knows how to translate a resolved profile + node context into a
 * CLI invocation, how to parse the streaming JSONL output of that CLI into
 * normalized events, and how to extract session/file-edit metadata from the
 * event stream.
 *
 * ### v1 scope (D1)
 * Only the `pi` adapter ships in v1. codex/claude/gemini/opencode adapters are
 * designed-for but not implemented; the `AgentAdapter` interface is the
 * extension point for adding them later.
 *
 * ### Output-schema hook (D2)
 * Adapters that can enforce structured output natively at the CLI level may
 * set `supportsNativeOutputSchema: true` and implement `outputSchemaArgs()`.
 * When the hook is absent or `false`, the engine performs post-hoc validation
 * (JSON parse + TypeBox `Value.Check`).
 */
export interface AgentAdapter {
  /** Canonical type identifier (e.g. "pi", "codex", "claude"). */
  readonly type: string;

  /**
   * Build the CLI invocation for a node.
   *
   * @param profile - The resolved profile (with effective agentType).
   * @param ctx - Context about the current node + attempt.
   * @returns Invocation spec: command, args, env overrides, and the stdin prompt.
   */
  buildInvocation(profile: ResolvedProfile, ctx: NodeInvocationContext): AdapterInvocation;

  /**
   * Parse a single line of JSONL from the subprocess stdout.
   *
   * @param line - Raw line (already stripped of trailing newline).
   * @returns A normalized event, or `null` if the line is ignorable (heartbeat,
   *          comment, blank).
   */
  parseEventStreamLine(line: string): NormalizedEvent | null;

  // ── Resume hooks ──────────────────────────────────────────────

  /**
   * Whether the adapter supports native `--resume` / `--continue` at the CLI.
   *
   * When `true`, `resumeArgs(sessionId)` MUST be provided. The pi adapter
   * deliberately leaves this `false` (D4) — wisp never uses pi's interactive
   * `--resume`; instead it relies on transcript-replay for `.loop`/`.reviewLoop`
   * workers and fresh sessions for general retries.
   */
  supportsNativeResume?: boolean;

  /**
   * CLI arguments required to resume an existing session natively.
   * Only meaningful when `supportsNativeResume` is `true`.
   */
  resumeArgs?(sessionId: string): string[];

  /**
   * Build a transcript-replay prompt from a prior session transcript and the
   * new instructions (D4). Used for `.loop`/`.reviewLoop` worker continuity.
   *
   * @param priorTranscript - Formatted transcript of the prior session.
   * @param newPrompt - The new prompt for the next iteration.
   */
  buildResumePrompt(priorTranscript: string, newPrompt: string): string;

  // ── Metadata extraction ───────────────────────────────────────

  /**
   * Extract the session id from a completed run's event stream.
   * Returns the `id` from the first `{type:"session"}` event, or `undefined`.
   */
  extractSessionId(events: NormalizedEvent[]): string | undefined;

  /**
   * Best-effort list of file paths edited during a run.
   * Scans `tool_call` events whose `name` matches a file-write tool
   * (`edit`, `write`, `write_file`, etc.) and collects their `args.path`.
   */
  extractFileEdits(events: NormalizedEvent[]): string[];

  // ── Native output schema (D2) ─────────────────────────────────

  /**
   * When `true`, the adapter can enforce a JSON Schema at the CLI level via
   * `outputSchemaArgs(schema)`. Default `false` → engine falls back to post-hoc
   * JSON parse + TypeBox `Value.Check`.
   */
  supportsNativeOutputSchema?: boolean;

  /**
   * Extra CLI arguments that tell the adapter to constrain its output to the
   * given JSON Schema. Only called when `supportsNativeOutputSchema` is `true`.
   *
   * @param schema - A JSON Schema (typebox `Static` type or plain object).
   */
  outputSchemaArgs?(schema: unknown): string[];

  // ── Optional derived metrics ──────────────────────────────────

  /** Count tool calls from an event stream. Default fallback counts `tool_call` events. */
  toolCountFromEvents?(events: NormalizedEvent[]): number;

  /** Extract approximate cost from an event stream (adapter-specific). */
  costFromEvents?(events: NormalizedEvent[]): number | undefined;
}
