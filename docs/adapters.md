# Adapter Layer

The adapter layer translates between wisp's engine and a specific agent CLI. Each
adapter knows how to build a CLI invocation from a resolved profile, parse the
CLI's streaming JSONL output into normalized events, and extract metadata
(session id, file edits, cost) from the event stream.

**v1 scope (Decision D1):** only the **pi** adapter ships. The `AgentAdapter`
interface is designed so that codex, claude, gemini, and opencode adapters can be
added later without engine changes. Their canonical invocations and event schemas
are documented in [Future Adapters](#future-adapters) below.

---

## Table of Contents

- [Normalized Event Model](#normalized-event-model)
- [The `AgentAdapter` Interface](#the-agentadapter-interface)
- [Adapter Registry](#adapter-registry)
- [The pi Adapter](#the-pi-adapter)
  - [Invocation](#invocation)
  - [Event Parsing](#event-parsing)
  - [Resume (Transcript-Replay)](#resume-transcript-replay)
  - [Metadata Extraction](#metadata-extraction)
  - [`buildDoneEvent`](#builddoneevent)
- [Engine Dispatch: `invokeAdapter`](#engine-dispatch-invokeadapter)
- [Spawner: `runAgent`](#spawner-runagent)
- [Process Termination: `killProcessTree`](#process-termination-killprocesstree)
- [Future Adapters](#future-adapters)
  - [codex](#codex)
  - [claude](#claude)
  - [gemini](#gemini)
  - [opencode](#opencode)

---

## Normalized Event Model

Every adapter normalizes its native CLI output into this event union (defined in
`src/types.ts`). The engine consumes these uniformly regardless of adapter.

```ts
type NormalizedEvent =
  | { type: "session"; id: string }
  | { type: "text_delta"; delta: string }
  | { type: "message_complete"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; isError: boolean; content: string }
  | { type: "turn_end" }
  | { type: "error"; message: string; retryable: boolean }
  | {
      type: "done";
      sessionId: string;
      finalText: string;
      costUsd?: number;
      durationMs: number;
      toolCallCount: number;
    };
```

| Event              | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `session`          | Session identity (from the CLI's session header).              |
| `text_delta`       | Incremental assistant text chunk.                              |
| `message_complete` | Full assistant message text (avoids doubling when deltas were also streamed). |
| `tool_call`        | Agent invoked a tool (`name`, `args`).                         |
| `tool_result`      | Tool execution result (`name`, `isError`, `content`).          |
| `turn_end`         | A turn completed.                                              |
| `error`            | An error occurred (`message`, `retryable`).                    |
| `done`             | Terminal: synthesized by the engine/adapter at stream end.     |

The `done` event is typically **synthesized by the engine** when the subprocess
exits and no explicit `done` event was emitted (the pi CLI does not emit one).
See [`buildDoneEvent`](#builddoneevent).

---

## The `AgentAdapter` Interface

Defined in `src/adapters/types.ts`:

```ts
interface AgentAdapter {
  readonly type: string;

  buildInvocation(
    profile: ResolvedProfile,
    ctx: NodeInvocationContext,
  ): AdapterInvocation;

  parseEventStreamLine(line: string): NormalizedEvent | null;

  // ── Resume hooks ──
  supportsNativeResume?: boolean;
  resumeArgs?(sessionId: string): string[];
  buildResumePrompt(priorTranscript: string, newPrompt: string): string;

  // ── Metadata extraction ──
  extractSessionId(events: NormalizedEvent[]): string | undefined;
  extractFileEdits(events: NormalizedEvent[]): string[];

  // ── Native output schema (D2) ──
  supportsNativeOutputSchema?: boolean;
  outputSchemaArgs?(schema: unknown): string[];

  // ── Optional derived metrics ──
  toolCountFromEvents?(events: NormalizedEvent[]): number;
  costFromEvents?(events: NormalizedEvent[]): number | undefined;
}
```

### `NodeInvocationContext`

Passed to `buildInvocation()` at the moment a node is scheduled:

```ts
interface NodeInvocationContext {
  nodeId: string;        // IR node id
  attempt: number;       // 1-based; fresh session each retry
  sessionId?: string;    // from a prior attempt (transcript-replay loops only)
  cwd?: string;          // node-level cwd override
  prompt?: string;       // final prompt (rehydrated; placed in stdinPrompt)
}
```

### `AdapterInvocation`

The CLI invocation spec returned by `buildInvocation()`:

```ts
interface AdapterInvocation {
  command: string;                          // executable path or name
  args: string[];                           // CLI arguments
  env: Record<string, string>;             // environment overrides (merged into parent env)
  stdinPrompt: string;                     // piped to subprocess on stdin
}
```

### `ResolvedProfile`

A profile together with metadata about where it was resolved from:

```ts
interface ResolvedProfile {
  profile: WispProfile;
  source: "inline" | "global" | "project" | "run-artifact";
  filePath?: string;
}
```

### Resume hooks

| Hook                    | Purpose                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `supportsNativeResume`  | Whether the CLI can resume a session by id natively (e.g. `claude --resume <id>`). |
| `resumeArgs(sessionId)` | CLI args to resume a specific session (only when `supportsNativeResume` is `true`). |
| `buildResumePrompt`     | **Universal fallback:** builds a transcript-replay prompt from a prior transcript + new instructions. Used by all adapters including pi. |

The pi adapter sets `supportsNativeResume: false` and omits `resumeArgs` — pi's
`--resume` is interactive and incompatible with `--no-session`. It implements
`buildResumePrompt` for `.loop()`/`reviewLoop()` worker continuity.

### Native output schema hooks (Decision D2)

| Hook                          | Purpose                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `supportsNativeOutputSchema`  | Whether the adapter can enforce a JSON Schema at the CLI level.       |
| `outputSchemaArgs(schema)`    | Extra CLI args that constrain output to the schema (only called when `supportsNativeOutputSchema` is `true`). |

When the hooks are absent or `false`, the engine performs **post-hoc
validation** (JSON parse + TypeBox `Value.Check`). The pi adapter leaves these
unset. Adapters for CLIs with native structured output (codex `--output-schema`,
claude `--json-schema`) can implement them to enforce schemas at the source.

---

## Adapter Registry

`src/adapters/registry.ts` provides a module-level store:

```ts
registerAdapter(adapter: AgentAdapter): void;
getAdapter(type?: string): AgentAdapter;    // defaults to "pi"
listAdapters(): string[];
```

`getAdapter()` falls back to the `"pi"` adapter when a requested type is not
registered (emitting a `console.warn`). Throws `AdapterNotRegisteredError` when
neither the requested type nor the pi fallback is available.

---

## The pi Adapter

The only v1 adapter (`src/adapters/pi.ts`). Implements `AgentAdapter` with
`type: "pi"`.

### Invocation

**Decision D3 (API keys):** wisp does **not** pass, map, or forward API keys.
The spawned pi process inherits the host environment and reads its own persisted
auth storage. No `--api-key` flag is emitted; no provider env var is set. The
`apiKey` profile field is parsed for format compatibility but **ignored** by the
adapter.

The invocation is built from the resolved profile via `profileToArgs()` (ported
from pi-subagents):

```
[...piBinArgs, "--mode", "json", "-p", "--no-session", ...profileArgs]
```

- `getPiInvocation()` detects whether pi is running as a Node script
  (`process.execPath` + `process.argv[1]`) or a compiled bun binary
  (`pi` bin).
- `-p` (`--print`) is immediately followed by `--no-session` — the `-p` flag
  **swallows the next positional argument** as the message, so the prompt must
  go to stdin, not a trailing positional.
- The prompt is placed in `stdinPrompt` (piped to stdin by the spawner), not as
  a CLI argument.
- `profileArgs` includes `--provider`, `--model`, `--system-prompt`,
  `--append-system-prompt`, `--thinking`, `--tools`/`--no-tools`,
  `--no-extensions`, `--no-skills`, `--no-context-files`, `--extension`,
  `--skill`, and validated `extraArgs`.
- `env` is always `{}` (host inherits).

### Event Parsing

`parseEventStreamLine(line)` maps pi `--mode json` JSONL events to
`NormalizedEvent`:

| pi event                                          | NormalizedEvent                           |
| ------------------------------------------------- | ----------------------------------------- |
| `session`                                         | `{ type: "session", id }`                 |
| `tool_execution_start`                            | `{ type: "tool_call", name, args }`       |
| `tool_execution_end`                              | `{ type: "tool_result", name, isError, content }` |
| `message_update` (with `assistantMessageEvent.type === "text_delta"`) | `{ type: "text_delta", delta }`   |
| `message_end` (assistant role)                    | `{ type: "message_complete", text }`      |
| `turn_end`                                        | `{ type: "turn_end" }`                     |
| All others (`agent_start`, `turn_start`, `message_start`, `tool_execution_update`, etc.) | `null` (ignored) |

Assistant text is extracted from the message `content` field: a bare string is
returned as-is; an array of parts is filtered to `{type:"text"}` parts and
joined. The `done` event is **not emitted by pi** — the engine synthesizes it.

### Resume (Transcript-Replay)

`supportsNativeResume: false` — wisp never uses pi's interactive `--resume`.

`buildResumePrompt(priorTranscript, newPrompt)`:

```
Previously:

${priorTranscript}

Instructions:

${newPrompt}
```

The transcript is produced by `formatRunsForResume()` (ported from
pi-subagents' `format-transcript.ts`), which formats session messages with role
prefixes and truncation. Used only by `.loop()`/`reviewLoop()` for worker
continuity (Decision D4).

### Metadata Extraction

- **`extractSessionId`** — delegates to the shared reducer `sessionIdFromEvents()`
  (`src/engine/events.ts`): returns the `id` from the first `session` event.
- **`extractFileEdits`** — delegates to the shared reducer
  `fileEditsFromEvents(events, FILE_WRITE_TOOLS)`: scans `tool_call` events
  where `name ∈ {edit, write, write_file}` and collects `args.path`.
  Best-effort.
- **`toolCountFromEvents`** — delegates to the shared reducer
  `toolCountFromEvents()`: counts `tool_call` events.

### `buildDoneEvent`

Exported helper (`src/adapters/pi.ts`) that synthesizes a `done` event from the
event stream when the CLI does not emit one:

```ts
function buildDoneEvent(events: NormalizedEvent[], durationMs: number): NormalizedEvent & { type: "done" };
```

It delegates to the shared reducers in `src/engine/events.ts`:
- Session id via `sessionIdFromEvents(events)` (first `session` event).
- Final text via `finalTextFromEvents(events)` (prefers the last
  `message_complete.text` used once over concatenated `text_delta` deltas —
  avoids doubling).
- Tool call count via `toolCountFromEvents(events)` (`tool_call` events).
- Caller-supplied wall-clock duration.

---

## Engine Dispatch: `invokeAdapter`

The engine does **not** call `buildInvocation` / `runAgent` / `emitEvents`
inline from the executor or the synthesis step. All adapter invocation is
funneled through a single shared dispatcher, `invokeAdapter()` in
`src/engine/events.ts`. Both the executor (`src/engine/executor.ts`) and the
synthesis step (`src/engine/synthesize.ts`) call it.

`invokeAdapter(adapter, options)` **duck-types** the adapter to pick a path:

| Path | Condition | Behaviour |
| ---- | --------- | -------- |
| In-process (fake/test) | `adapter.emitEvents` is a function | Calls `adapter.emitEvents(onEvent, invokeCtx, signal)` directly. Returns `undefined`. |
| Subprocess (real) | `emitEvents` is absent | Calls `adapter.buildInvocation(...)` to build the CLI spec, then `runAgent(...)` with the adapter's `parseEventStreamLine` as the line parser. Returns a `RunAgentResult`. |

```ts
async function invokeAdapter(
  adapter: AgentAdapter,
  options: InvokeAdapterOptions,
): Promise<RunAgentResult | undefined>;
```

`InvokeAdapterOptions` carries the `prompt`, `nodeId`, `attempt`, `cwd`,
`signal`, `onEvent` callback, `onUpdate` (debounced re-render trigger), and
`agentType` (default `"pi"`, passed to `buildInvocation`).

This consolidates the previously duplicated dispatch logic into one place:
`src/engine/events.ts` also houses the shared event-stream **reducers**
(`finalTextFromEvents`, `sessionIdFromEvents`, `fileEditsFromEvents`,
`toolCountFromEvents`) and the run-summary helpers (`summarizeNode`,
`computeTotals`) used across the executor, the pi adapter, and the audit layer.

---

## Spawner: `runAgent`

`src/spawn/spawner.ts` provides a generic, **adapter-agnostic** process spawner.
The engine calls it per node, passing the adapter's `parseEventStreamLine` as
the line parser.

```ts
interface RunAgentOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  stdinPrompt: string;
  signal?: AbortSignal;
  parseLine: (line: string) => NormalizedEvent | null;
  onEvent: (event: NormalizedEvent | null) => void;
  onUpdate: () => void;          // debounced at 50ms internally
  cwd?: string;
}

function runAgent(options: RunAgentOptions): Promise<RunAgentResult>;
```

The return type is the named interface `RunAgentResult` (defined in
`src/spawn/spawner.ts`):

```ts
interface RunAgentResult {
  exitCode: number | null;    // `null` when killed by a signal
  stderr: string;             // all accumulated stderr text
}
```

Behavior:
- Spawns with `{ detached: true, shell: false, stdio: ["pipe","pipe","pipe"] }`.
- **Line-buffers stdout**: splits on `\n`, holds the incomplete trailing tail
  until the next newline (or flushes on close). Uses `StringDecoder` for
  multibyte-safe UTF-8.
- For each complete line, calls `parseLine()` → `onEvent()` (immediate) and
  `onUpdate()` (50ms-debounced).
- Writes `stdinPrompt` via `proc.stdin.write()` + `proc.stdin.end()`.
- Captures stderr verbatim (multibyte-safe).
- On abort: calls `killProcessTree(proc)`.
- On spawn error (e.g. ENOENT): rejects the promise.
- Returns `{ exitCode, stderr }` on close.

---

## Process Termination: `killProcessTree`

`src/spawn/abort.ts` kills an entire process tree via the `tree-kill` package
(NOT `proc.kill`, which only kills the direct child):

```ts
function killProcessTree(
  proc: KillableProcess,
  options?: { sigtermGraceMs?: number; forceResolveMs?: number },
): Promise<void>;
```

Escalation timeline:
1. `tree-kill` sends `SIGTERM` to the whole process group **immediately**.
2. After `sigtermGraceMs` (default 5000), escalates to `SIGKILL`.
3. After a further `forceResolveMs` (default 5000), force-resolves the promise
   (guards against D-state / uninterruptible sleeps — ported from
   pi-processes' pattern).

If the process supports event subscription (`on("exit")`/`on("close")`), the
promise resolves early and pending timers are cleared.

---

## Future Adapters

> **D1:** these adapters are **not implemented in v1**. The invocations and event
> schemas below are documented for future implementation; all four CLIs are now
> mature with stable headless JSON and native resume. The `AgentAdapter`
> interface requires no engine changes to add any of them.

### codex

**Binary:** `codex` (OpenAI Codex CLI; npm `@openai/codex`). Rust binary.

**Canonical invocation:**
```bash
codex exec --json --sandbox workspace-write -a never -C <cwd> [--model <m>] - < prompt
```

- Prompt via stdin (`-` sentinel).
- `--json` emits **JSONL** with 9 event types: `thread.started`/`thread.resumed`
  (carry `thread_id`), `turn.started`/`turn.completed` (carries `usage` — **no
  costUsd**), `turn.failed`, `item.started`/`item.updated`/`item.completed`/
  `item.failed`, `error`.
- Item `type` discriminator: `agent_message` (final text), `reasoning`,
  `command_execution`, `file_change` (edits), `mcp_tool_call`, `web_search`,
  `todo_list`.
- **Native resume:** `codex exec resume <SESSION_ID>` (also `--last`, `--all`).
  `supportsNativeResume: true`, `resumeArgs: (id) => ["resume", id]`.
- **Native output schema:** `--output-schema <json-schema-file>`.
  `supportsNativeOutputSchema: true`.
- No `--provider` flag — use config or `-c model_provider=<id>`.
- Auth: `OPENAI_API_KEY` (or `CODEX_API_KEY`).

### claude

**Binary:** `claude` (Anthropic Claude Code).

**Canonical invocation:**
```bash
ANTHROPIC_API_KEY=… claude -p --output-format json --bare --permission-mode bypassPermissions [--model m] [--max-turns n]
```
(prompt on stdin)

- `--output-format json` → single object with ~20 fields. Core: `result` (final
  text), `session_id`, `total_cost_usd`, `num_turns`, `is_error`, `stop_reason`.
  **Recommended over `stream-json`** for the adapter (simpler, sufficient).
- `--output-format stream-json` event types: `system`(subtype `init` carries
  `session_id`), `assistant` (text + `tool_use` blocks), `user` (tool results),
  `result` (terminal), `stream_event` (raw deltas).
- **Native resume:** `--resume <id>` / `-r`, `--continue` / `-c`,
  `--fork-session`, `--session-id <uuid>`.
  `supportsNativeResume: true`, `resumeArgs: (id) => ["--resume", id]`.
- **Native output schema:** `--json-schema`.
  `supportsNativeOutputSchema: true`.
- Tool control: `--allowedTools`/`--disallowedTools` (approval patterns),
  `--tools` (availability), `--permission-mode`.
- System prompt: `--system-prompt` (replace), `--append-system-prompt` (append).
- **No `-m` short alias** (use `--model`).
- Auth: `ANTHROPIC_API_KEY` env var (primary); OAuth via `claude auth login`.

### gemini

**Binary:** `gemini` (Google Gemini CLI).

**Canonical invocation:**
```bash
GEMINI_API_KEY=… gemini -p "<prompt>" --output-format stream-json -m flash
```

- `--output-format stream-json` maps near-1:1 to wisp's normalized events:
  `init`, `message`, `tool_use`, `tool_result`, `error`, `result`. Design the
  adapter around this form.
- `-p`/`--prompt` forces non-interactive (appended to stdin).
- `--model`/`-m` (aliases `auto`→2.5-pro, `pro`, `flash`, `flash-lite`).
- **Native resume:** `--resume`/`-r <id|"latest"|index>`, plus
  `--list-sessions`/`--delete-session`. Stable since v0.45.0.
  `supportsNativeResume: true`.
- Sandbox: `--sandbox`/`-s`, `--approval-mode default|auto_edit|yolo|plan`.
- Exit codes: 0 ok, 1 error, 42 input error, 53 turn limit.
- Auth: `GEMINI_API_KEY` (AI Studio) OR `GOOGLE_API_KEY`/
  `GOOGLE_APPLICATION_CREDENTIALS`/ADC (Vertex).

### opencode

**Binary:** `opencode` (anomalyco/opencode; NOT the archived sst/opencode).

**Canonical invocation:**
```bash
opencode run "<prompt>" --format json -m anthropic/claude-sonnet-4
```

- `run` is the dedicated headless subcommand. Stdin supported (appended to
  message when not a TTY).
- `--format json` on `run` → typed JSONL: `tool_use`, `step_start`,
  `step_finish`, `text`, `reasoning`, `error`.
- `--model`/`-m provider/model` (e.g. `anthropic/claude-sonnet-4`);
  `--variant` for reasoning effort.
- **Native resume:** `--continue`/`-c` (last), `--session`/`-s <id>` (specific),
  `--fork`.
  `supportsNativeResume: true`.
- `opencode export [sessionID]` for full session JSON.
- Auth: `opencode auth login` (interactive), per-provider env vars, project
  `.env`, or `OPENCODE_AUTH_CONTENT`.
