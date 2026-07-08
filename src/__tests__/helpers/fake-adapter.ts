// ═══════════════════════════════════════════════════════════════════════════
// FakeAgentAdapter — test infrastructure (S25 / IMPLEMENTATION_PROMPT §19).
//
// A fully-scriptable `AgentAdapter` implementation that emits a deterministic
// `NormalizedEvent[]` WITHOUT spawning any process. This decouples every
// engine / spawner / widget test from real agent CLIs (pi, codex, …).
//
// Configurable per instance:
//   - mode: "succeed" | "fail-after-events" | "retryable-error"
//   - a scripted event sequence (static array OR a per-attempt factory, so a
//     node can fail on attempt 1 and succeed on attempt 2 — needed for retry
//     and resume tests)
//   - a chosen sessionId, scripted file-edits, toolCount, cost
//   - optional inter-event delay (delayMs) for timing-sensitive tests
//
// ### How the engine drives a fake adapter
// Real adapters are driven by the spawner (S10), which spawns a subprocess and
// parses stdout lines via `parseEventStreamLine`. The fake adapter has no
// subprocess, so it instead exposes a public `emitEvents(onEvent, ctx, signal)`
// method. The executor (S26) detects a fake adapter by duck-typing:
//
//     if (typeof (adapter as { emitEvents?: unknown }).emitEvents === "function")
//
// and, when present, calls `emitEvents` directly instead of spawning. Real
// adapters never define `emitEvents`, so the check is unambiguous and requires
// NO production import of this test helper.
// ═══════════════════════════════════════════════════════════════════════════

import type { NormalizedEvent } from "../../types.js";
import type {
  AgentAdapter,
  AdapterInvocation,
  NodeInvocationContext,
  ResolvedProfile,
} from "../../adapters/types.js";

// ─── Tool names recognised as file writes ──────────────────────────

/**
 * Tool names that count as file edits (matches the pi adapter's
 * `extractFileEdits` set per PLAN S9). Used by `extractFileEdits` when deriving
 * edits from a scripted event stream.
 */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "write_file"]);

// ─── Options ───────────────────────────────────────────────────────

/** Behavioral mode for the default (auto-generated) event sequence. */
export type FakeAdapterMode = "succeed" | "fail-after-events" | "retryable-error";

/**
 * The scripted event source. A static array gives full control of the stream; a
 * factory receives the per-node invocation context (incl. `attempt`) so a test
 * can vary behavior across retries (e.g. fail on attempt 1, succeed on attempt 2).
 */
export type FakeEventSource =
  | NormalizedEvent[]
  | ((ctx?: NodeInvocationContext) => NormalizedEvent[] | Promise<NormalizedEvent[]>);

/** Options accepted by {@link createFakeAdapter}. */
export interface FakeAdapterOptions {
  /** Adapter type identifier. Defaults to `"fake"`. */
  readonly type?: string;
  /** Default-sequence behavior. Defaults to `"succeed"`. Ignored when `events` is set. */
  readonly mode?: FakeAdapterMode;
  /**
   * Scripted event sequence. When a function, it is invoked per run with the
   * node context so behavior can vary by attempt. When omitted, a sequence is
   * generated from `mode`/`sessionId`/`fileEdits`/etc.
   */
  readonly events?: FakeEventSource;
  /** Session id to report (injected into generated `session`/`done` events). */
  readonly sessionId?: string;
  /**
   * Number of events to emit before erroring — only for `mode` `"fail-after-events"`
   * or `"retryable-error"`. Defaults to `0`.
   */
  readonly failAfterEvents?: number;
  /** File paths reported by `extractFileEdits` (also emitted as `write` tool calls). */
  readonly fileEdits?: string[];
  /** Cost (USD) reported by `costFromEvents` / injected into the `done` event. */
  readonly costUsd?: number;
  /** Tool count reported by `toolCountFromEvents` / injected into the `done` event. */
  readonly toolCount?: number;
  /** Final assistant text used in the generated sequence's `done` event. */
  readonly finalText?: string;
  /** Duration (ms) injected into the generated `done` event. */
  readonly durationMs?: number;
  /** Delay (ms) between emitted events; `0` = synchronous. */
  readonly delayMs?: number;
  /** Error message used in generated `error` events. */
  readonly errorMessage?: string;
}

// ─── FakeAgentAdapter ──────────────────────────────────────────────

/**
 * A scripted `AgentAdapter` for tests. See file header for the full contract.
 *
 * The metadata-extraction methods (`extractSessionId`, `extractFileEdits`,
 * `toolCountFromEvents`, `costFromEvents`) prefer their explicitly-configured
 * value and fall back to deriving from the supplied event stream — mirroring the
 * real pi adapter's behavior while letting tests pin metadata independently.
 */
export class FakeAgentAdapter implements AgentAdapter {
  public readonly type: string;
  public readonly supportsNativeResume = false;
  public readonly supportsNativeOutputSchema = false;

  resumeArgs(_sessionId: string): string[] {
    return [];
  }

  outputSchemaArgs(_schema: unknown): string[] {
    return [];
  }

  private readonly mode: FakeAdapterMode;
  /** Always-defined session id used to generate default events (defaults to "fake-session"). */
  private readonly sessionId: string;
  /** The explicitly-configured session id (undefined when defaulted); drives extractSessionId precedence. */
  private readonly configuredSessionId: string | undefined;
  private readonly finalText: string;
  private readonly durationMs: number;
  private readonly delayMs: number;
  private readonly errorMessage: string;
  private readonly failAfterEvents: number;
  private readonly fileEdits: string[];
  private readonly costUsd: number | undefined;
  private readonly toolCount: number | undefined;
  private readonly eventsFactory:
    ((ctx?: NodeInvocationContext) => NormalizedEvent[] | Promise<NormalizedEvent[]>) | undefined;
  private readonly staticEvents: NormalizedEvent[] | undefined;

  /** Recorded `buildInvocation` contexts (useful for asserting per-attempt calls). */
  public readonly invocations: NodeInvocationContext[] = [];

  constructor(opts: FakeAdapterOptions = {}) {
    this.type = opts.type ?? "fake";
    this.mode = opts.mode ?? "succeed";
    this.configuredSessionId = opts.sessionId;
    this.sessionId = opts.sessionId ?? "fake-session";
    this.finalText = opts.finalText ?? "";
    this.durationMs = opts.durationMs ?? 0;
    this.delayMs = opts.delayMs ?? 0;
    this.errorMessage = opts.errorMessage ?? "fake adapter failure";
    this.failAfterEvents = opts.failAfterEvents ?? 0;
    this.fileEdits = opts.fileEdits ? [...opts.fileEdits] : [];
    this.costUsd = opts.costUsd;
    this.toolCount = opts.toolCount;

    if (typeof opts.events === "function") {
      this.eventsFactory = opts.events;
    } else if (opts.events !== undefined) {
      this.staticEvents = [...opts.events];
    }
  }

  // ── AgentAdapter: invocation ─────────────────────────────────

  buildInvocation(_profile: ResolvedProfile, ctx: NodeInvocationContext): AdapterInvocation {
    this.invocations.push(ctx);
    return { command: "fake", args: [], env: {}, stdinPrompt: "" };
  }

  // Fake adapters emit events programmatically; lines are never parsed.
  parseEventStreamLine(_line: string): NormalizedEvent | null {
    return null;
  }

  buildResumePrompt(priorTranscript: string, newPrompt: string): string {
    return `Previously:\n\n${priorTranscript}\n\nInstructions:\n\n${newPrompt}`;
  }

  // ── AgentAdapter: metadata extraction ────────────────────────

  extractSessionId(events: NormalizedEvent[]): string | undefined {
    // An explicitly-configured session id wins; otherwise derive from the stream.
    if (this.configuredSessionId !== undefined) return this.configuredSessionId;
    for (const e of events) {
      if (e.type === "session") return e.id;
    }
    return undefined;
  }

  extractFileEdits(events: NormalizedEvent[]): string[] {
    if (this.fileEdits.length > 0) return [...this.fileEdits];
    const edits: string[] = [];
    for (const e of events) {
      if (e.type === "tool_call" && FILE_WRITE_TOOLS.has(e.name)) {
        const args = e.args;
        if (typeof args === "object" && args !== null && "path" in args) {
          const path = args.path;
          if (typeof path === "string") edits.push(path);
        }
      }
    }
    return edits;
  }

  toolCountFromEvents(events: NormalizedEvent[]): number {
    if (this.toolCount !== undefined) return this.toolCount;
    return events.filter((e) => e.type === "tool_call").length;
  }

  costFromEvents(events: NormalizedEvent[]): number | undefined {
    if (this.costUsd !== undefined) return this.costUsd;
    for (const e of events) {
      if (e.type === "done" && e.costUsd !== undefined) return e.costUsd;
    }
    return undefined;
  }

  // ── Fake-only: programmatic emission (see file header) ───────

  /**
   * Emit the scripted event sequence programmatically (no process spawn). This
   * is the engine-test entry point: the executor calls it instead of spawning
   * when it detects a fake adapter.
   *
   * Records the invocation context in {@link invocations} so tests that assert
   * per-node adapter usage via `adapter.invocations` work regardless of whether
   * the executor uses the spawner or emitEvents path.
   *
   * @param onEvent - Callback for each normalized event (mirrors the spawner's `onEvent`).
   * @param ctx - Node invocation context; forwarded to the event factory when `events` is a function.
   * @param signal - Optional abort signal; emission stops immediately if already aborted.
   */
  async emitEvents(
    onEvent: (event: NormalizedEvent) => void,
    ctx?: NodeInvocationContext,
    signal?: AbortSignal,
  ): Promise<void> {
    // Record invocation for tests that assert per-node adapter usage.
    if (ctx) {
      this.invocations.push(ctx);
    }
    const events = await this.resolveEvents(ctx);
    for (const event of events) {
      if (signal?.aborted) return;
      onEvent(event);
      if (this.delayMs > 0) {
        await sleep(this.delayMs);
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────

  private async resolveEvents(ctx?: NodeInvocationContext): Promise<NormalizedEvent[]> {
    if (this.eventsFactory) {
      return this.eventsFactory(ctx);
    }
    if (this.staticEvents) {
      return this.staticEvents;
    }
    return this.buildDefaultSequence();
  }

  /**
   * Build a default event sequence from the configured mode/metadata. Produces a
   * realistic stream: `session` → optional `text_delta` → file-edit tool pairs →
   * `turn_end` → `done` (or a truncated stream + `error` for failure modes).
   */
  private buildDefaultSequence(): NormalizedEvent[] {
    const events: NormalizedEvent[] = [{ type: "session", id: this.sessionId }];

    if (this.finalText.length > 0) {
      events.push({ type: "text_delta", delta: this.finalText });
    }

    for (const path of this.fileEdits) {
      events.push({ type: "tool_call", name: "write", args: { path } });
      events.push({
        type: "tool_result",
        name: "write",
        isError: false,
        content: `wrote ${path}`,
      });
    }

    events.push({ type: "turn_end" });

    if (this.mode === "fail-after-events" || this.mode === "retryable-error") {
      const truncated = events.slice(0, Math.max(0, this.failAfterEvents));
      truncated.push({
        type: "error",
        message: this.errorMessage,
        retryable: this.mode === "retryable-error",
      });
      return truncated;
    }

    const done: {
      type: "done";
      sessionId: string;
      finalText: string;
      costUsd?: number;
      durationMs: number;
      toolCallCount: number;
    } = {
      type: "done",
      sessionId: this.sessionId,
      finalText: this.finalText,
      durationMs: this.durationMs,
      toolCallCount: this.toolCount ?? this.fileEdits.length,
    };
    if (this.costUsd !== undefined) {
      done.costUsd = this.costUsd;
    }
    events.push(done);
    return events;
  }
}

// ─── Factory ───────────────────────────────────────────────────────

/**
 * Create a `FakeAgentAdapter` with the given options.
 */
export function createFakeAdapter(opts: FakeAdapterOptions = {}): FakeAgentAdapter {
  return new FakeAgentAdapter(opts);
}

// ─── Helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
