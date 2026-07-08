# Architecture

wisp is a pi-coding-agent extension with four layers: a TypeScript DSL for
defining workflows, a DAG orchestration engine, a CLI adapter layer, and an
execution/persistence/TUI layer. This document covers the data flow, executor
algorithm, concurrency scheduler, persistence model, and stale-context guards.

> See also: [dsl.md](dsl.md) for the authoring API, [adapters.md](adapters.md)
> for the adapter layer, and [configuration.md](configuration.md) for config and
> profiles.

---

## Table of Contents

- [Layer Overview](#layer-overview)
- [Data Flow](#data-flow)
- [DAG Executor](#dag-executor)
  - [Shared Event Helpers](#shared-event-helpers)
  - [Node State Machine](#node-state-machine)
  - [Execution Loop](#execution-loop)
  - [Lazy fanOut Expansion](#lazy-fanout-expansion)
  - [Cond Branching](#cond-branching)
  - [Loop Execution](#loop-execution)
  - [Retry / Skip / No Fail-Fast](#retry--skip--no-fail-fast)
  - [Synthesis (reduce/merge)](#synthesis-reducemerge)
- [Concurrency Scheduler](#concurrency-scheduler)
- [Run Lifecycle Orchestration](#run-lifecycle-orchestration)
- [Persistence](#persistence)
  - [On-Disk Run Layout](#on-disk-run-layout)
  - [Audit Trail](#audit-trail)
  - [Session Files](#session-files)
  - [run.json Manifest](#runjson-manifest)
  - [In-Memory Store + `pi.appendEntry`](#in-memory-store--piappendentry)
- [Stale-Context Guards](#stale-context-guards)
- [Lifecycle Hooks](#lifecycle-hooks)
- [Resume](#resume)
- [Live TUI Widget](#live-tui-widget)

---

## Layer Overview

```
Layer 1 — Definition     DSL builder (fluent TS)  ──tsx subprocess──▶  Graph IR (JSON)
Layer 2 — Orchestration   DAG executor · topo deps · context API · conditional edges ·
                          loops · composite macros · concurrency pools · retry/skip · resume
Layer 3 — Adapter         AgentAdapterRegistry { pi }  →  normalize CLI JSONL  →
                          NormalizedEvent model
Layer 4 — Execution/TUI   spawn · kill · abort · session store · live widget · audit.jsonl · runs
```

| Layer | Key modules                                           |
| ----- | ----------------------------------------------------- |
| 1     | `src/dsl/builder.ts`, `src/dsl/macros.ts`, `src/dsl/ir.ts`, `src/dsl/fn-serialize.ts`, `src/dsl/compile.ts`, `src/dsl/compile-harness.ts` |
| 2     | `src/engine/executor.ts`, `src/engine/scheduler.ts`, `src/engine/context.ts`, `src/engine/retry.ts`, `src/engine/loop.ts`, `src/engine/resume.ts`, `src/engine/synthesize.ts`, `src/engine/transcript.ts`, `src/engine/events.ts`, `src/engine/run.ts` |
| 3     | `src/adapters/types.ts`, `src/adapters/pi.ts`, `src/adapters/registry.ts` |
| 4     | `src/spawn/spawner.ts`, `src/spawn/abort.ts`, `src/run/store.ts`, `src/run/layout.ts`, `src/run/audit.ts`, `src/run/sessions.ts`, `src/tui/widget.ts`, `src/tui/format.ts` |

---

## Data Flow

A single `run_workflow` tool call proceeds through these steps:

```
run_workflow({ path | script | resumeFrom })
  │
  ├─ if resumeFrom ──▶ prepareResume(runDir) ──▶ { ir, runState, rerunNodeIds }
  │
  ├─ else:
  │    1. compileWorkflow({ scriptSource | scriptPath, builderPath, harnessPath })
  │         └─ tsx subprocess builds GraphIR; stderr classified as compile/runtime
  │    2. validateIR(ir) ──▶ structural checks (cycles, refs, schemas, pools)
  │    3. (on failure: return classified WispError)
  │
  ├─ createRunDir(runsDir, title) ──▶ .wisp/runs/{timecode}-{slug}/
  ├─ copy workflow.ts + write graph.json into artifacts/
  ├─ create AuditLogger, Scheduler, RunState
  │
  ├─ executeDAG({ ir, runState, scheduler, getAdapter, onUpdate })
  │    └─ per node: resolve profile → tryAcquire slots → invokeAdapter
  │       (emitEvents in-process | buildInvocation+runAgent subprocess) →
  │       stream events → validate output → release slots
  │    └─ onUpdate (50ms-debounced) → ctx.ui.setWidget("wisp", lines)
  │
  ├─ finalize: reconcileRunStatus → audit.runComplete/runFail → writeRunJson → persistRun
  │
  └─ return { summary, runDir }  or  { error: WispError, runDir? }
```

**Error classification** (agent-actionable):

| Class        | When                                                          |
| ------------ | ------------------------------------------------------------- |
| `compile`    | tsx/syntax error, IR build failure, unparseable stdout.       |
| `validation` | Graph checks (cycles, dangling refs, malformed schema, etc.). |
| `runtime`    | Node failures during execution, mid-run crashes.              |

---

## DAG Executor

`src/engine/executor.ts` — the core execution engine (`executeDAG()`).

### Shared Event Helpers

`src/engine/events.ts` — a shared module that **centralizes** the event-stream
reducers, adapter dispatch, and run-summary helpers formerly duplicated across
`executor.ts`, `synthesize.ts`, `adapters/pi.ts`, and `run/audit.ts`. Single
source of truth for:

- **Event-stream reducers** — `finalTextFromEvents`, `fileEditsFromEvents`,
  `toolCountFromEvents`, `sessionIdFromEvents`: project a `NormalizedEvent[]`
  stream into the node's final text, edited file paths, tool count, and session
  id. `finalTextFromEvents` prefers an explicit `done.finalText`, then the last
  `message_complete.text`, then concatenated `text_delta` deltas.
- **`invokeAdapter(adapter, options)`** — uniform duck-typed adapter dispatch.
  Detects a fake/in-process adapter by its `emitEvents()` method and calls it
  directly; otherwise builds the invocation (`buildInvocation`) and spawns the
  subprocess (`runAgent`) with the adapter's `parseEventStreamLine`. Returns the
  `RunAgentResult` (subprocess path) or `undefined` (fake path).
- **Run-summary helpers** — `nodeDurationMs`, `summarizeNode`, `computeTotals`
  — plus the `RunSummary`, `RunSummaryNode`, and `RunSummaryTotals` types,
  shared by the executor return value, the `run.json` manifest (`writeRunJson`),
  and the `run_workflow` tool result.

### Node State Machine

```
pending ──(all deps met)──→ ready ──(tryAcquire)──→ running ──(done)──→ completed
                             │                          │
                             │                          └──(error/schema-fail + shouldRetry)──→ running (fresh session)
                             │                          └──(exhausted)──→ failed ──→ dependents → skipped
                             └──(tryAcquire fails)──→ ready (waits for capacity)
```

### Execution Loop

The executor runs a concurrent event loop:

1. **Phase 1 — Mark ready:** Scan all `pending` nodes; mark those whose
   dependencies (all `dep`/`fanOut`/`cond:branch` predecessors) are `completed`
   as `ready`. `depsMet(nodeId)` consults a **pre-built predecessors adjacency
   map** (`buildPredecessorsMap`, O(in-degree) per node) constructed once at
   `executeDAG` entry, instead of scanning every edge per node. A matching
   **successors map** (`buildSuccessorsMap`) is built at the same time for skip
   propagation.

2. **Phase 2a — Structural nodes (cond/loop):** Process `cond` nodes
   (synchronous: evaluate predicate, route branch, skip non-chosen) and launch
   `loop` nodes as in-flight promises (async: run iteration subgraph). This
   happens **before** Phase 2b so structural handlers can claim subgraph nodes
   before they are scheduled independently.

3. **Phase 2b — Regular nodes:** For each remaining `ready` node:
   - **fanOut:** expand lazily (see below), mark the fanOut node `completed`.
   - **reduce:** no longer a placeholder — once all members are `completed`,
     it acquires scheduler slots (agent-run synthesis) or skips them (pure-JS
     merge) and delegates to `executeReduceNode()` (see
     [Synthesis](#synthesis-reducemerge)).
   - **parallel/sequence:** complete as placeholders so their dependents
     unblock.
   - **plain node:** resolve profile → `scheduler.tryAcquire()` → if slots
     available, set `running` + launch `runNode()` as an in-flight promise; if
     no slots, leave `ready` (retried next pass).

4. **Notify:** Debounced TUI update (50ms) with current `RunState` + pool
   snapshot.

5. **Phase 3 — Await:** If in-flight promises exist, `await Promise.race()`
   (first completion), then loop. If nothing is ready/schedulable and nothing is
   in flight, the run is finished.

The executor is **adapter-agnostic**: adapter dispatch is centralized in
`invokeAdapter()` ([Shared Event Helpers](#shared-event-helpers)), which
duck-types the adapter — calling `emitEvents()` directly for in-process (fake)
adapters, otherwise falling back to `buildInvocation()` + the subprocess spawner
(`runAgent`) with the adapter's `parseEventStreamLine`.

### Lazy fanOut Expansion

When a fanOut node becomes `ready` and its producer has `completed`:

1. Rehydrate + invoke the `iterate` fn with `NodeCtx` → item array.
2. For each item, rehydrate + invoke the `each` fn → `NodeSpec`.
3. Create a child IRNode (`<fanOutId>-<index>`) from the spec, add to the live
   `nodeMap` and `runState`.
4. The fanOut node itself is marked `completed`; children become `pending` and
   are picked up in the next loop pass.

### Cond Branching

When a `cond` node becomes `ready` (`src/engine/loop.ts: evaluateCond`):

1. Rehydrate + invoke the `when` fn with `NodeCtx` → branch key (or boolean).
2. The chosen branch (`then` when truthy, `else` when falsy) proceeds.
3. The non-chosen branch is marked `skipped` with reason `"cond-not-taken"`.
4. The cond node itself is marked `completed`.

If the `when` fn throws, both branches are skipped and the cond node is marked
`failed`.

### Loop Execution

When a `loop` node becomes `ready` (`src/engine/loop.ts: executeLoop`):

1. Collect the iteration subgraph (body node + all transitive `dep` successors).
2. **Claim** all iteration nodes synchronously (set to `running`) so Phase 2b
   does not schedule them independently.
3. For each iteration (1 to `maxIterations`):
   a. If iteration > 1: capture the prior transcript from iteration nodes
      **before** resetting them (`buildPriorTranscript`), format it via
      `formatRunsForResume()` (`src/engine/transcript.ts` — role-prefixed,
      truncating formatter), then set a prompt override on the body node via
      `buildResumePromptForBody()` (transcript-replay, Decision D4).
   b. Reset all iteration nodes to `pending`.
   c. Run each iteration node in dependency order via `runNodeWrapper()`.
   d. If any node fails: mark the loop `failed`, skip remaining iteration nodes.
   e. Check `until` condition. If accepted → complete the loop.
   f. If `maxIterations` reached → complete the loop.

### Retry / Skip / No Fail-Fast

`src/engine/retry.ts`:

- **Retry policy:** `node.retries` (per-node) or config `defaultRetries`
  (default 3). Backoff is exponential: `retryBackoffMs * 2^(attempt-1)`.
- **Fresh sessions per retry** (D4): each retry spawns a brand-new session; the
  failed session's transcript is discarded.
- **Skip propagation:** when a node is exhausted (`failed`), transitive
  dependents reachable via `dep` **+ `fanOut` + `cond:branch`** edges are
  marked `skipped` (reason `"dep-failed"`) — following all three edge kinds
  (via `buildSuccessorsMap`) ensures no pending node is orphaned behind a
  fan-out child or a cond branch. **Independent branches continue** — the
  workflow does not fail-fast.
- A completed node that depends on a later-failed node is left untouched.
- `cond-not-taken` skips are **benign** and do not cause a run failure; only
  `dep-failed` skips do.

### Synthesis (reduce/merge)

`src/engine/synthesize.ts` (`executeSynthesis`) + `executor.ts`
(`executeReduceNode`).

Reduce nodes are **no longer placeholders**. When all members are `completed`,
the executor runs `executeReduceNode()`:

1. Resolves the reduce node's profile (when present).
2. Acquires scheduler slots for **agent-run synthesis** (AND semantics), or
   skips slot acquisition for a **pure-JS merge** (synchronous CPU work).
3. Calls `executeSynthesis()`, which gathers member outputs and either
   dispatches a merge prompt to the adapter or merges in-process.
4. Wraps the call in `try`/`catch` — on throw the node is failed via `failNode`
   + `propagateSkip` (no rejection escapes the reduce promise).

`executeSynthesis` member access:

- **Agent-run synthesis** (reduce with `profile`): builds a merge prompt
  referencing every member output and dispatches via the adapter. Member outputs
  are accessed via `ctx.output(nodeId)` for **all** `from` ids — including
  councils — avoiding the `ctx.member(i)` suffix-search collision.
- **Pure-JS merge** (reduce without `profile`): if every member output is a
  plain object, deep-merges them (last-writer-wins, recursive). Otherwise wraps
  all outputs into `{ merged, count }`.
- Prototype-pollution keys (`__proto__`, `constructor`, `prototype`) are
  stripped during deep-merge.

Only **`parallel`/`sequence`** nodes remain placeholders (completed immediately
so their dependents unblock).

---

## Concurrency Scheduler

`src/engine/scheduler.ts` — pure pool accounting with **AND semantics**.

A node belongs to multiple pools, determined from its resolved profile:

| Pool              | Key                          | Condition                         |
| ----------------- | ---------------------------- | --------------------------------- |
| **global**        | (always)                     | Always. Cap = `maxAgentConcurrency`. |
| **byAgentType**   | `agentType` (default `"pi"`) | If a limit is configured for this type. |
| **byProvider**    | `provider`                   | If a limit is configured for this provider. |
| **byModel**       | `provider/model`, else `model` | If a limit is configured. Tries composite key first, then bare model. |

**AND semantics:** `tryAcquire(node)` returns `true` **only if every pool the
node belongs to has a free slot**. On success it increments all atomically (no
partial acquisition). `release(node)` decrements all (clamped at zero) and then
**wakes the first compatible waiter** (see `acquire` below).

Two acquisition entry points:

- **`tryAcquire(node): boolean`** — non-blocking. The **Phase-2b first-pass hot
  path** in the executor: a `ready` node that fails `tryAcquire` stays `ready`
  and is retried on the next loop pass once a release frees capacity. Also used
  for reduce nodes.
- **`acquire(node, signal): Promise<boolean>`** — async **FIFO semaphore**.
  Calls `tryAcquire` first; if no capacity, the caller is appended to a wait
  queue. On each `release()`, `wakeFirstCompatibleWaiter()` scans the queue in
  insertion order and resolves the first waiter whose pools ALL have capacity
  (AND semantics preserved), atomically claiming its slots. If the caller's
  `AbortSignal` fires first, the waiter is removed from the queue and resolves
  `false` — its slot is never stolen from another waiter. The executor uses
  `acquire` in `runNodeWrapper` (**loop subgraph nodes** scheduled via
  `runIterationNodes`) and for **retry re-acquisition** within `runNode`
  (re-acquiring slots after releasing them between attempts so other nodes may
  run during validation / back-off sleep). Plain and reduce nodes in the
  Phase-2b hot path use the non-blocking `tryAcquire` instead.

Pools are **created lazily** (on first membership resolution) — a
configured-but-never-touched limit does not appear in `usage()`.

`usage()` returns a `PoolUsage` snapshot for the TUI footer:

```ts
interface PoolUsage {
  global: { used: number; cap: number };
  byAgentType: Record<string, { used: number; cap: number }>;
  byProvider: Record<string, { used: number; cap: number }>;
  byModel: Record<string, { used: number; cap: number }>;
}
```

See [configuration.md](configuration.md) for pool configuration.

---

## Run Lifecycle Orchestration

`src/engine/run.ts` — `runWorkflow()` ties together compile, validate, run-dir
creation, execution, and persistence.

1. **Resolve IR:** use pre-compiled `ir` (resume/test), or
   `compileWorkflow()` → `validateIR()`.
2. **Setup:** create run directory + copy workflow source + write `graph.json`;
   create `AuditLogger`, `RunState`, `Scheduler`. (Guarded: cleans up partial
   run-dir on failure.)
3. **Execute:** `executeDAG()` with scheduler, adapter, and `onUpdate` callback.
4. **Finalize:** `reconcileRunStatus()` (only `dep-failed` skips count as
   failure; `cond-not-taken` is benign) → `audit.runComplete()` or
   `audit.runFail()` → `writeRunJson()` → `persistRun()`.
5. **Mid-run guard:** if the executor throws, the run is marked `error`,
   `audit.runFail()` is emitted, and a structured `RunFailure` is returned (the
   throw never escapes the orchestrator).

**Result type:** `RunSuccess { ok: true, summary, runDir }` or `RunFailure {
ok: false, error: WispError, runDir?, summary? }`.

---

## Persistence

### On-Disk Run Layout

```
.wisp/
├── config.json
└── runs/
    └── {YYYYMMDD-HHMM}-{kebab-title}/     # timecode + slug; -2/-3 suffix on collision
        ├── run.json                       # manifest: status, per-node summary, totals
        ├── audit.jsonl                    # append-only event log (PRIMARY inspection artifact)
        ├── artifacts/
        │   ├── workflow.ts                # the authored script (copied in)
        │   ├── graph.json                 # compiled Graph IR
        │   └── profiles/*.md              # bespoke profiles for this run
        └── sessions/
            └── {sessionId}.json           # per-agent transcript + metadata
```

`src/run/layout.ts` creates this tree with `mkdirSync({ recursive: true })` —
synchronous I/O before any async execution begins.

### Audit Trail

`src/run/audit.ts` — `AuditLogger` writes an append-only `audit.jsonl` (one JSON
object per line with `ts` timestamp). It opens a file descriptor via
`openSync("a")` in the constructor and keeps it open for the logger's lifetime;
each event is a single `writeSync` on that fd (no per-event open/close churn).
`close()` releases the fd. The logger emits all 9 event types: `run.start`,
`run.complete`, `run.fail`, plus per-node `node.start`, `node.tool`,
`node.retry`, `node.complete`, `node.fail`, `node.skip`. Events:

| Event           | Fields                                                       |
| --------------- | ------------------------------------------------------------ |
| `run.start`     | `ts`                                                         |
| `node.start`    | `nodeId`, `ts`                                               |
| `node.tool`     | `nodeId`, `toolName`, `ts`                                   |
| `node.retry`    | `nodeId`, `attempt`, `error?`, `ts`                          |
| `node.complete` | `nodeId`, `sessionId?`, `durationMs?`, `toolCount?`, `ts`    |
| `node.fail`     | `nodeId`, `error`, `ts`                                      |
| `node.skip`     | `nodeId`, `reason`, `ts`                                     |
| `run.complete`  | `ts`                                                         |
| `run.fail`      | `error?`, `ts`                                               |

The orchestrating agent inspects runs by reading these files with built-in tools
(`read`, `grep`, `ls`) — no dedicated list/get tools.

### Session Files

`src/run/sessions.ts` — `writeSession(runDir, session)` writes
`sessions/{sessionId}.json`:

```ts
interface PersistedSession {
  sessionId: string;
  nodeId?: string;
  agentType: string;
  profile?: string;
  provider?: string;
  model?: string;
  messages: unknown[];        // capped at MAX_MESSAGES_PER_SESSION (500)
  finalText?: string;
  toolCallCount: number;
  durationMs: number;
  costUsd?: number;
  error?: string;
}
```

When `messages` exceeds 500, the oldest entries are dropped. `readSession()` is
resilient against corrupt/missing files (returns `undefined`).

### run.json Manifest

`writeRunJson(runDir, state)` writes/overwrites `run.json`:

```json
{
  "runId": "…",
  "title": "…",
  "slug": "…",
  "status": "completed | failed | error",
  "startedAt": 1234567890,
  "endedAt": 1234567999,
  "nodes": [
    { "id": "…", "status": "…", "sessionId": "…", "durationMs": 4200, "toolCount": 11, "retries": 0, "error": null }
  ],
  "totals": {
    "nodes": 5, "completed": 4, "failed": 1, "skipped": 0,
    "totalCostUsd": 0, "totalDurationMs": 12345
  }
}
```

### In-Memory Store + `pi.appendEntry`

`src/run/store.ts` — `createRunStore()` returns a closure-held
`Map<runId, RunState>` with LRU eviction (default cap: 50 runs). The store API
has **shrunk to reconstruction + finalization**: `registerRun`, `updateRun`,
and `persistRun` were removed because runs are created and persisted inside
`engine/run.ts`. Surviving accessors:

- **`getRun(runId)`:** look up a run (primarily tests); promotes recency for LRU.
- **`reconstructRuns(ctx)`:** called on `session_start`. Scans
  `ctx.sessionManager.getBranch()` in reverse for `"wisp:run"` custom entries,
  deserializes the latest snapshot per `runId`, and registers them.
  **Passive stale detection:** any reconstructed `"running"` run is transitioned
  to `"error"` (the agent process must have died mid-flight). In-flight nodes
  within an errored run are marked `"failed"`.
- **`finalizeAll(pi)`:** called on `session_shutdown`. Marks all in-store
  `"running"` runs as `"error"` and persists terminal state via
  `pi.appendEntry`.
- **`_clear()`:** test-only store reset.

`persistRun` is now a **local function** in `src/engine/run.ts` (not a store
method): it calls `pi.appendEntry("wisp:run", serializeRunState(run))` during
run finalization.

---

## Stale-Context Guards

`src/stale.ts` — ported from pi-workflows.

A "stale" error occurs when the session a handler is operating on has been
replaced or reloaded mid-handler (e.g. the user switched branches). Such errors
are safe to swallow because the discarded session's work is no longer relevant.

```ts
function isStaleError(e: unknown): boolean;    // true when e.message includes "stale"
function withStaleGuard(fn: () => void): void; // swallows stale errors, rethrows others
```

All lifecycle hooks (`session_start`, `session_tree`) that touch `ctx`/`pi.*`
are wrapped in `withStaleGuard`. This is essential because a long `run_workflow`
call can outlive a session switch.

---

## Lifecycle Hooks

Registered in `src/index.ts`:

| Hook               | Behavior                                                              |
| ------------------ | --------------------------------------------------------------------- |
| `session_start`    | `loadConfig(ctx.cwd)` + `runStore.reconstructRuns(ctx)` (stale-guarded). |
| `session_tree`     | Same as `session_start` (re-init on tree switch).                     |
| `session_shutdown` | `runStore.finalizeAll(pi)` + clear TUI widget/status.                 |

The extension follows the pi-workflows **closure + accessor-callback** pattern:
the in-memory run store is held in a closure, accessible from lifecycle hooks
and tools without a global singleton.

Two tools are registered:
- **`run_workflow`** — compile, validate, execute, resume.
- **`list_profiles`** — list profiles across scopes.

Tool names are distinct from pi-subagents (`delegate_to_subagents`, etc.) — no
collision.

---

## Resume

`src/engine/resume.ts` — `prepareResume(runDir)` loads a prior run for
re-execution.

1. Load `artifacts/graph.json` (the IR) and `run.json` (the manifest).
2. Reconstruct `RunState` from the manifest's per-node entries (enriching with
   session data when available).
3. Apply **D4 status transitions:**
   - `completed` nodes → stay `completed` (outputs preserved for dependents'
     context). `parsedOutput` is re-validated against `ir.schemas` when possible.
   - `failed` / `skipped` / stale (`ready` / `running`) nodes → reset to
     `pending` with a **fresh session id** and all accumulated state cleared
     (attempts, toolCount, filesEdited, etc.). Added to `rerunNodeIds`.
   - `pending` nodes → stay `pending` (will become ready naturally when deps
     are met).
4. Return `{ ir, runState, rerunNodeIds }`.

The executor then runs only the `pending` nodes; completed nodes are skipped
(their stored outputs are available to dependents via `NodeCtx`).

**Resume ≠ CLI resume.** "Resume" means re-running selected nodes with **fresh
sessions**. It does not use pi's interactive `--resume`. The only place wisp
continues an existing conversation is `.loop()`/`reviewLoop()`: the loop handler
captures prior-iteration transcripts (`buildPriorTranscript`) and formats them
via `formatRunsForResume()` in `src/engine/transcript.ts` (a role-prefixed,
truncating formatter — no longer inline concatenation), then feeds the worker
its prior transcript via `adapter.buildResumePrompt()` — again without CLI
session resume.

---

## Live TUI Widget

`src/tui/widget.ts` (`renderWidget`) + `src/tui/format.ts` — produces a snapshot
of the current run as an array of lines for `ctx.ui.setWidget("wisp", lines)`.
The executor drives this via its `onUpdate` callback (50ms-debounced). Layout:

- **Header:** `wisp: {title} · stage: {stage} · {completed}/{total} nodes`.
- **One row per node:** `{glyph} {id} · {stage}[ · {elapsed} · {tools}[ · {files}]]`.
- **Footer:** pool-usage snapshot (omitted when empty).

Status glyphs: ✓ completed, ⏳ running, ✗ failed, ○ pending, · ready, ◇ skipped.

**Failed-node detail:** a failed node renders `⚠` plus a truncated error — the
message is sliced at **57 characters** and terminated with `…` when longer.

**Pool footer prefixes:** non-global pools are prefixed by category to avoid
ambiguous keys — `agent:`, `provider:`, `model:` — while the global pool is
unprefixed. Example: `global 4/12 · agent:zai 5/7 · provider:anthropic 3/5`.
Only pools with `cap > 0` or `used > 0` are shown.

### Synthesized Output

`src/tools/run-workflow.ts` — the tool's returned text is the **terminal
DAG-sink node's `finalText`**. `findTerminalNode()` identifies the unique
completed node with **no outgoing `dep` edge to an incomplete node**; when there
is exactly one, its `finalText` is the synthesized output. When the terminal is
ambiguous (zero or multiple candidates), it falls back to the last completed
node in iteration order.
