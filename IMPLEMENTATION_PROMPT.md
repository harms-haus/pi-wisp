# Implementation Prompt: `pi-wisp` (Multi-Agent Workflow Orchestrator)

> **Read this entire document before writing any code.** Then read the local research artifacts listed in §13. This prompt is self-contained: it contains the full design spec + the key technical findings the design rests on, so you don't need to re-derive them.

You are implementing **`pi-wisp`** — a [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension (npm `@earendil-works/pi-coding-agent`) that lets the orchestrating pi agent **author and execute scripted multi-agent workflows as a DAG**, with orchestration primitives (review-loop, council, review-fix), per-provider/model concurrency limits, a live TUI, and a durable on-disk audit trail.

**Project root:** `/home/blake/Documents/software/pi-wisp` (empty git repo, `main` branch, no commits yet).

**One-line summary:** the agent writes a TypeScript DSL script describing a graph of agent runs; wisp compiles it to an IR, executes it as a DAG respecting dependencies + concurrency pools, spawns the agents as subprocesses, renders live status in the TUI, persists everything under `.wisp/runs/`, and returns the synthesized result.

---

## 1. Context — what already exists in the pi ecosystem (REUSE THESE PATTERNS)

wisp is a **fresh extension** (no code dependency on other extensions), but it deliberately reuses proven patterns and **shared file formats** from three installed extensions. Read their source — it is the fastest way to get the details right. All paths below are on this machine.

### 1a. `pi-subagents` (the current `delegate_to_subagents`) — closest relative
Path: `~/.pi/agent/git/github.com/harms-haus/pi-subagents/`
- `docs/architecture.md` — **READ FIRST.** Spawning model, session store (LRU + persistence via `pi.appendEntry`), resume flow, concurrency worker-pool, abort/timeout, rolling-window TUI, profile system. ⚠️ **Two errors in that doc to ignore:** (a) it labels `-p` as "profile mode" — it is actually `--print` (non-interactive); see pi's own `dist/cli/args.js`; (b) it claims the profile `apiKey` is passed via a `PI_API_KEY` env var — **pi does not read `PI_API_KEY`** (verified: zero readers in the entire pi tree). Its "resume flow" is **transcript replay** (prepending prior messages to a fresh `--no-session` prompt), NOT pi CLI session resume.
- `docs/profiles.md` — the **exact profile `.md` frontmatter format** wisp reuses (see §10).
- `src/spawner.ts` — `runSubAgent()`: spawns `pi --mode json -p --no-session [profileArgs]`, line-buffers stdout, parses JSONL `message_end`/`turn_end` events, 50ms-debounced TUI updates, `tree-kill` SIGTERM→SIGKILL. **Port this.**
- `src/profile-types.ts` — `SubagentProfile` interface.
- `src/profiles.ts` — `profileToArgs()` (profile→CLI flags+env), frontmatter parsing, 5s TTL cache, `excludeTools` resolution, skill resolution.
- `src/utils.ts` — `mapWithConcurrencyLimit()` (work-stealing worker pool), `appendLineToWindow()`.
- `src/format-tool-call.ts` — per-tool emoji one-liners (reuse for the TUI).

### 1b. `pi-workflows` — state-machine / hooks patterns
Path: `~/.pi/agent/git/github.com/harms-haus/pi-workflows/`
- `docs/architecture.md` — **READ.** Closure-captured state w/ accessor callbacks, copy-on-write state, `withStaleGuard`/`isStaleError` for async handlers surviving session switches, persistence/reconstruction via `pi.appendEntry`.
- `docs/configuration-reference.md` + `src/types.ts` — validation patterns: iterative-DFS cycle detection, path-traversal safety, mutual-exclusivity checks, duplicate detection.

### 1c. `pi-processes` — subprocess lifecycle
Path: `~/.pi/agent/git/github.com/harms-haus/pi-processes/`
- `src/process-manager.ts` — `ProcessManager`: debounce-based "startup settled" detection, log ring-buffer (`MAX_LOG_ENTRIES`), SIGTERM→SIGKILL w/ force-resolve for D-state, `onProcessCountChange` callback. Reference for clean spawn/kill.

### 1d. pi core extension API
Path: `/home/blake/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/`
- `docs/extensions.md` — **THE extension API reference.** Key sections: Events lifecycle (§Events), `pi.registerTool()` (§Custom Tools → Tool Definition), `pi.appendEntry(customType, data)`, `ctx.ui` (§Custom UI → Widgets/Status/Footer: `setWidget`, `setStatus`, `setFooter`, `notify`), `ctx.signal`, `pi.getActiveTools/getAllTools`, `pi.exec`.
- `docs/json.md` — **the normalized JSON event model** (the target shape adapters normalize to): `session{id}`, `agent_start/end`, `turn_start/end{message,toolResults}`, `message_start/update/end`, `tool_execution_start/update/end{toolCallId,toolName,args,result,isError}`.
- `examples/sdk/01-minimal.ts`, `examples/sdk/13-session-runtime.ts`, `examples/extensions/*.ts` (esp. `subagent/`, `tools.ts`, `custom-footer.ts`, `status-line.ts`, `widget-placement.ts`, `doom-overlay/`).
- `README.md` §CLI flags: `--mode json`, `-p/--print`, `-r/--resume`, `-c/--continue`, `--no-session`, `--tools`, `--no-tools`, `--provider`, `--model`, `--thinking`, `--system-prompt`, `--append-system-prompt`, `--skill`, `--no-extensions`, `--extension`.

### 1e. Multi-CLI headless research (informs the adapter INTERFACE — v1 ships pi only)
All these CLIs share: prompt-via-stdin, structured output, session-resume-by-id, model selection, tool restriction. wisp v1 implements only the **pi** adapter, but the `AgentAdapter` interface (§8) must be designed so codex/claude/gemini adapters can be added later without engine changes.
- **pi:** `pi --mode json -p --no-session [profileArgs]` → JSONL events (see 1d). Prompt is delivered via **stdin** (pi merges piped stdin into the initial prompt in print mode). **Resume:** pi's `-r/--resume` is *interactive* (browse/select) — unsuitable for headless use; `--session <id>` / `--session-id <id>` resume a specific session but require a persisted session file (incompatible with `--no-session`). Therefore wisp's pi adapter resumes via **transcript replay** (prepend prior run transcript to the new prompt + a fresh `--no-session` process), mirroring pi-subagents' `formatRunsForResume`. Tools: `--tools` / `--no-tools` / `--exclude-tools`. ⚠️ **Trap (from `dist/cli/args.js`):** `-p`/`--print` **swallows the next non-flag arg as the message** — keep `--no-session` immediately after `-p` and ensure every profileArg begins with `-` (the ported `profileToArgs()` emits only `--flag value` pairs, so this invariant holds).
- **codex:** `codex exec [opts] "<prompt>"` (alias `codex e`). JSON: `--json` (JSONL: `thread.started{thread_id}`, `turn.started/completed`, `item.*`). Resume: `codex exec resume <SESSION_ID>` or `--last`. Sandbox: `--sandbox workspace-write|danger-full-access`. Stdin prompt via `-` sentinel. Model flag in CLI ref.
- **claude:** `claude -p/--print "<prompt>"`. Output: `--output-format json|stream-json` (json has `result`, `session_id`, `total_cost_usd`). Resume: `--resume <SESSION_ID>`, `--continue`. Tools: `--allowedTools`, `--disallowedTools`, `--permission-mode`. System prompt: `--system-prompt`, `--append-system-prompt`.
- **gemini:** `gemini -p "<prompt>"`, JSON output supported; session-resume-by-id is an open feature request (not yet landed) — adapter must degrade gracefully.
- **opencode:** `opencode run [msg]`, stdin supported.

---

## 2. Locked design decisions (do not relitigate without asking)

| Area | Decision |
|---|---|
| Definition format | **Imperative JS/TS DSL** — fluent builder, `export default wf(name, opts).node(...)...` |
| Execution model | **Blocking `run_workflow` tool call** w/ live TUI render; returns synthesized result into context |
| Codebase origin | **Fresh extension** (`pi-wisp`); shares profile `.md` format; **coexists** with pi-subagents under **distinct tool names** |
| Primitives | **Low-level atoms + composite macros** (macros are sugar over atoms) |
| CLI adapters v1 | **pi only**; `AgentAdapter` interface designed against codex/claude/gemini |
| Data passing | **Context API**: `ctx.output(id)`, `ctx.fanOut(id)`, `ctx.member(i).output`, `ctx.run`; optional `outputSchema` (JSON Schema) per node |
| Concurrency | **Layered pools**: global `maxAgentConcurrency` + `byProvider` + `byModel` + `byAgentType`; a node needs a slot in global **AND** every matching pool |
| TUI | **Live widget** (`ctx.ui.setWidget`) above/below editor; per-node status/stage/time/tool-counts + DAG + pool-usage footer |
| Failure/resume | **Retry N then skip** (default + per-node); persist DAG+sessions+artifacts; resume via `run_workflow(resumeFrom)` re-runs failed nodes w/ fresh sessions |
| DSL runtime | **Subprocess (tsx) builds JSON IR**; executor runs the IR (the script only *builds* the graph — it never spawns agents) |
| Profile format | **Reuse pi-subagents `.md`+YAML frontmatter** + **new `agentType`** field (default `pi`) + adapter-specific fields |
| Profile storage | Bespoke → **run artifacts dir**; existing named profiles resolvable from global+project dirs; inline `wf.profile({...})` also supported |
| Synthesis step | **Another agent run** w/ a profile (uses context API to merge member outputs) |
| Tool surface | **Exactly 2 tools**: `run_workflow` (path/inline, `resumeFrom`; rich compile/runtime error reporting) + `list_profiles` |
| Stage labels | **Derived from primitive type** + optional per-node `stage:` override |
| Audit trail | Append-only event log: sessions started+when, failures/retries, best-effort file edits |
| Config | Dedicated **`.wisp/config.json`** |

---

## 3. Architecture (4 layers)

```
Layer 1 — Definition     workflow.ts (fluent DSL)  ──tsx subprocess──▶  Graph IR (JSON)
Layer 2 — Orchestration   DAG executor · topo deps · context API · conditional edges ·
                          loops · composite macros · concurrency pools · retry/skip · resume
Layer 3 — Adapter         AgentAdapterRegistry { pi }  →  normalize CLI JSONL  →
                          common NormalizedEvent model
Layer 4 — Execution/TUI   spawn·kill·abort · session store · live widget · audit.jsonl · on-disk runs
```

**Data flow for one `run_workflow` call:**
1. `run_workflow({path|script})` reads the `.ts` file.
2. **Build IR:** spawn a `tsx` subprocess that imports the DSL builder, executes the module, captures the `export default` workflow object, and emits a **`graph.json` IR** (nodes, edges, conditions, primitives, concurrency hints, schemas) to stdout. The script's *only* effect is to produce this IR — it cannot spawn agents.
3. **Validate IR inline** (cycles via DFS, unique node ids, resolved deps, profile name pre-resolution, concurrency-pool sanity, schema well-formedness). On failure, return a **structured, agent-actionable error** distinguishing *compile error* (tsx/IR build), *validation error* (graph checks), *runtime error* (agent failure).
4. **Create run dir** `.wisp/runs/{YYYYMMDD-HHMM}-{kebab-title}/` (copy `workflow.ts` + write `graph.json` into `artifacts/`).
5. **Execute DAG:** topo-respect deps; when a node's deps are satisfied and all its concurrency pools have capacity, claim slots, spawn the agent (via the node's adapter), stream NormalizedEvents → update node state + widget (50ms debounce) + append `audit.jsonl`. Node fns (`prompt`/`iterate`/`each`/`cond`/`synthesize`) are invoked with the **context API** at the moment the node becomes ready (so they can reference prior nodes' parsed outputs).
6. On node completion: parse `outputSchema` (if present) → structured output stored; release pool slots; unblock dependents; append `node.complete|fail`. On failure: retry per policy, else mark failed + skip dependents (continue independent branches).
7. **Return** synthesized result + structured summary (per-node status, session pointers, run path) into the agent's context.

---

## 4. The DSL (TypeScript, fluent builder)

### 4.1 Module shape
```ts
import { wf } from "pi-wisp";            // the builder is published from the extension

export default wf("fix-bugs", { maxConcurrency: 6 })
  .node("review", {
    agent: "pi", profile: "reviewer",
    outputSchema: { type: "object", properties: { findings: { type: "array", items: { type: "object", properties: { title: {type:"string"}, file: {type:"string"}, severity: {type:"string"} }, required: ["title","file"] } } }, required: ["findings"] },
    prompt: "Find bugs in auth/*.ts. Return JSON {findings:[{title,file,severity}]}.",
  })
  .fanOut("fix", {
    from: "review",
    iterate: (ctx) => ctx.output("review").findings,
    each: (f) => ({ agent: "pi", profile: "fixer", prompt: `Fix ${f.title} in ${f.file}` }),
  })
  .reviewLoop("verify", { worker: "fix", gate: "reviewer", maxRounds: 3 });
```

### 4.2 Atoms (low-level)
- `.node(id, { agent, profile?, prompt|promptFn, outputSchema?, dependsOn?, stage?, retries?, timeoutSec?, cwd? })` — a single agent run.
- `.fanOut(id, { from, iterate: (ctx)=>any[], each: (item,index,ctx)=>NodeSpec })` — parallel map: spawns one node per item produced by `iterate` over a dependency's output. Results addressable via `ctx.fanOut(id)` (array).
- `.cond(id, { on: nodeId, when: (ctx)=>boolean|string, then: NodeSpec|NodeId, else?: ... })` — conditional routing. `when` may return a branch key.
- `.loop(id, { body: NodeId|NodeSpec, until: (ctx)=>boolean, maxIterations? })` — feed output back to a **resumed** session until `until` accepts. Resume reuses the body node's sessionId.
- `.reduce(id, { from: NodeId[], merge: (ctx)=>any, profile?, agent? })` / alias `.merge` — fan-in; if `profile` given it's an agent-run synthesis, else a pure-JS merge.
- `.parallel(id, { nodes: NodeSpec[] })` — run N independent nodes concurrently.
- `.sequence(id, { steps: NodeSpec[] })` — chain, each depends on the prior.

### 4.3 Composite macros (sugar over atoms — implement in terms of atoms)
- `.reviewLoop(id, { worker: NodeId|NodeSpec, gate: ProfileRef|NodeSpec, maxRounds, acceptOn?: (ctx)=>boolean })` → `loop` whose body is `[worker] → [gate review] → cond(accept ? done : resume-worker)`.
- `.council(id, { members: NodeSpec[], synthesize: { agent, profile, prompt|promptFn } })` → `parallel(members) → reduce(synthesize)`.
- `.reviewFix(id, { reviewer: NodeSpec, workers: NodeSpec[]|((ctx)=>NodeSpec[]), merge?: NodeSpec })` → `[reviewer] → fanOut(workers from reviewer findings) → merge?`.

Macros must emit the **same IR** atoms do (expand to nodes+edges at build time), so the executor treats them uniformly.

### 4.4 Context API (passed to all fns)
```ts
interface NodeCtx {
  output(nodeId: string): any;            // a prior single node's parsed outputSchema result (or raw text)
  fanOut(nodeId: string): any[];          // array of a fanOut node's per-item results
  member(index: number): { output: any }; // inside a council synthesize
  run: { runId: string; title: string; attempt: number; startedAt: number };
  raw(nodeId: string): { text: string; sessionId: string }; // unstructured fallback
}
```
- When a node declares `outputSchema`, the adapter's final text is validated/parsed as JSON against it; on parse/validation failure the node **fails** (→ retry per policy).
- Fns are invoked **at node-ready time**, so `ctx.output('review')` is always populated for a node that `dependsOn: ['review']`.

### 4.5 Inline profiles
```ts
wf("x").profile("quick-reviewer", { agent:"pi", provider:"anthropic", model:"claude-sonnet-4-5", thinkingLevel:"high", tools:["read","grep"], systemPrompt:"You are a reviewer." })
```
Inline profiles are scoped to the workflow run; resolution precedence (most-specific wins): **run-artifacts** › **project** `.pi/agent-profiles/` › **global** `~/.pi/agent-profiles/` › **inline**.

---

## 5. Graph IR (`graph.json`)

A serializable, validated, adapter/engine-facing representation. Suggested shape:
```ts
interface GraphIR {
  title: string; slug: string;
  options: { maxConcurrency?: number; defaultRetries?: number; };
  nodes: IRNode[];          // flattened, including macro-expanded sub-nodes
  edges: IREdge[];          // {from, to, kind: "dep"|"fanOut"|"cond:branch"|"loop"}
  conditions: IRCondition[];// {id, on, expr} — expr is the serialized fn (see §6)
  schemas: Record<nodeId, JSONSchema>;
  primitives: Record<nodeId, { kind: "reviewLoop"|"council"|"reviewFix"|..., meta }>; // for stage labeling + TUI grouping
}
```

---

## 6. DSL runtime — subprocess builds IR (CRITICAL DESIGN)

The agent-authored `.ts` contains **real functions** (`iterate`, `each`, `prompt` ctx-fns, `cond` predicates). These cannot be serialized to pure JSON. Approach:

1. wisp spawns a **child process** running the script under `tsx` (TypeScript execution; add `tsx` as a dep). The child loads a wisp-owned **compile harness** (a `.ts` file shipped inside wisp at a known absolute path), which `import`s the agent's `workflow.ts`, reads its default export, and emits the IR JSON.
   - **Module-resolution gotcha (IMPORTANT):** the agent's script begins `import { wf } from "pi-wisp"`. A standalone `tsx` subprocess will **not** resolve `pi-wisp` unless it is in `node_modules` (extensions are not installed as resolvable packages). **Fix:** before invoking tsx, wisp **rewrites** the `import ... from "pi-wisp"` specifier(s) in the script to the **absolute path** of wisp's compiled builder module (computed from `import.meta.url` / the extension's own dir at registration time). Alternatively set `NODE_PATH` to wisp's dir. Do not rely on `pi-wisp` being resolvable by name from the project.
   - The harness itself imports the builder via a **relative** path (same package), so it always resolves.
2. `wf(...)` returns a builder that **records** all calls into an in-memory IR and registers the default export.
3. When the module finishes evaluating, the shim **serializes the IR**: structural data → JSON directly; **functions** → wrapped descriptors that reference their source. **Recommended approach for fns:** serialize each fn as `{ __fn: true, src: <stringified source>, kind: "iterate"|"each"|"prompt"|"cond"|"merge" }` via `Function.prototype.toString()`, then **rehydrate them in the executor** via `new Function(...)` in a tightly-scoped context that exposes ONLY the context API + pure JS globals (no `require`, `process`, `fs`, `fetch`). 
   - This is NOT a security sandbox (the trusted main agent authored the script and it runs on the user's machine in a trusted project). The restricted context is to prevent accidental side-effects and to make the "script only builds the graph; fns are pure" contract explicit.
   - Document the threat model in `docs/dsl.md`.
**Fn rehydration details (the riskiest part — prototype it first):**
   - Rehydrate a serialized fn at execution time, passing the live `NodeCtx`: `const fn = new Function("ctx", "return (" + descriptor.src + ")(ctx)"); const out = fn(nodeCtx);`. This works for arrow/expression fns (the DSL style).
   - **Closure limitation (must document in `docs/dsl.md` + the authoring SKILL):** `Function.toString()` captures the fn body but **not** closures over script-scope variables. So `const LIMIT = 5; ... iterate: ctx => items.filter(i => i.x > LIMIT)` breaks on rehydration (no `LIMIT`). **Rule: node fns must be pure with respect to `ctx` only** — inline constants or derive them from `ctx`. If true closures are required, use the **IPC alternative** below.
   - **IPC alternative (optional, heavier):** keep the tsx subprocess alive for the whole run and evaluate fns via a tiny stdin/stdout RPC (`{fnId, ctx}` → `{result}`). Preserves closures, avoids rehydration, at the cost of a long-lived subprocess + protocol. Pick ONE; rehydrate is recommended for simplicity.
   - Validate `outputSchema` with TypeBox's `Value.Check` (see §18) — do not pull in ajv.

4. The child writes the IR JSON to stdout (or an agreed temp path) and exits. The executor parses it and proceeds.

**Why subprocess:** clean isolation (a throw/syntax error in the script can't crash the host pi process), real TS support via tsx, and the executor never `import`s untrusted code in-process.

**Error reporting:** capture the child's stderr; on non-zero exit, classify as *compile error* and return the tsx/ts message to the agent with the offending file/line if extractable.

---

## 7. Engine — DAG executor, scheduler, retry, resume

### 7.1 Execution loop
- Maintain per-node state: `pending | ready | running | completed | failed | skipped`.
- A node is **ready** when all `dep`/`fanOut` predecessors are `completed` (for fanOut, the producing node must be done so `iterate` can run to expand the sub-nodes — fanOut expansion happens lazily at ready-time).
- A ready node is **schedulable** when every concurrency pool it belongs to has capacity (§9).
- Use a **work-stealing worker pool** (port `mapWithConcurrencyLimit` from pi-subagents `src/utils.ts`). Pool accounting: each active node holds a ref in global + each matching byProvider/byModel/byAgentType pool.
- Invoke node fns (`prompt`, `iterate`, `each`, etc.) with the context API at the moment of scheduling, then spawn the agent via the adapter.
- 50ms-debounced TUI update on every event.

### 7.2 Retry / skip
- On node failure: retry up to `retries` (node-level) or `defaultRetries` (config) with exponential backoff. Each retry is a **fresh session** (per the user's "fresh sessions for failed tasks" requirement) — do NOT reuse the failed session id.
- After exhausting retries: mark `failed`; downstream nodes whose deps include it become `skipped`; **independent branches continue**.
- The whole workflow does **not** fail-fast — it runs to completion (or to the point where no remaining node can become ready), then returns a structured summary.

### 7.3 Resume (`run_workflow({ resumeFrom: runId })`)
- Load the prior run's `graph.json` + `audit.jsonl`/`run.json`.
- Mark already-`completed` nodes as completed (skip them — reuse their stored outputs for dependents' context).
- Mark `failed`/`skipped`/unfinished nodes as `pending` (ready to re-run), creating **fresh sessions** for them.
- Re-execute. This is the agent-decided recovery path: the orchestrating pi inspects the audit log / sessions via the built-in `read`/`grep`/`ls` tools, then calls `run_workflow({resumeFrom})` or authors a new workflow. **Never auto-loop infinitely.**
- **Resume ≠ CLI resume.** "Resume" here means: re-run selected nodes with **fresh sessions**. It does **not** use pi's interactive `--resume`. The only place wisp continues an *existing* conversation (rather than starting fresh) is the `.loop`/`reviewLoop` primitive, which feeds the worker node its **prior transcript** (transcript-replay, §8) for continuity — again without CLI session resume.

---

## 8. Adapter layer (v1: pi only; interface designed for codex/claude/gemini)

### 8.1 Normalized event model (adapter target — a pragmatic subset of pi's `docs/json.md`)
```ts
type NormalizedEvent =
  | { type: "session"; id: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; name: string; args: any }
  | { type: "tool_result"; name: string; isError: boolean; content: string }
  | { type: "turn_end" }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "done"; sessionId: string; finalText: string; costUsd?: number; durationMs: number; toolCallCount: number };
```

### 8.2 `AgentAdapter` interface
```ts
interface AgentAdapter {
  readonly type: string;                                                        // "pi" | "codex" | "claude" | ...
  buildInvocation(profile: ResolvedProfile, nodeCtx: NodeCtx): { command: string; args: string[]; env: Record<string,string>; stdinPrompt: string };
  parseEventStreamLine(line: string): NormalizedEvent | null;                   // per-CLI JSONL → normalized
  supportsNativeResume?: boolean; // can this CLI resume a session by id natively?
  resumeArgs?(sessionId: string): string[]; // only when supportsNativeResume (e.g. claude: ["--resume", id]). pi omits this
  buildResumePrompt(priorTranscript: string, newPrompt: string): string; // universal fallback: transcript replay. Used by ALL adapters incl. pi
  extractSessionId(events: NormalizedEvent[]): string | undefined;
  extractFileEdits(events: NormalizedEvent[]): string[] | null;                 // best-effort, for audit; null if unsupported
  // optional: toolCountFromEvents, costFromEvents
}
```

### 8.3 pi adapter (implement this)
- Reuse pi-subagents' invocation: `pi --mode json -p --no-session [profileArgs]`, prompt via **stdin** (not a trailing positional arg — see the `-p` swallowing trap in §1e).
- `profileToArgs()` port (§10) produces `[profileArgs]` from the resolved profile.
- Parse pi JSONL (`session`, `message_end`, `turn_end`, `tool_execution_*`) → NormalizedEvent. `finalText` = last assistant message text. `toolCallCount` = count of `tool_execution_start`. `sessionId` from `session` header.
- `extractFileEdits`: capture `tool_execution_start` where `toolName ∈ {edit, write}` → `args.path`. (Best-effort; this is the "files edited if possible" audit feature.)
- **Resume (`supportsNativeResume: false`):** the pi adapter does NOT implement `resumeArgs` — pi's `--resume` is interactive and incompatible with `--no-session`. It implements `buildResumePrompt(priorTranscript, newPrompt)` = **transcript replay** (port pi-subagents' `formatRunsForResume` from `src/format-transcript.ts`, reading the prior run's stored session `.json`). Used by `.loop`/`reviewLoop` for worker continuity. wisp's general retry policy uses **fresh** sessions (no replay); only `.loop`/`reviewLoop` opt into transcript replay.

---

## 9. Concurrency model (layered pools, AND semantics)

Config (§11) defines `maxAgentConcurrency` (global) + `limits.byProvider` + `limits.byModel` + `limits.byAgentType`. For a given node, determine its pools from its resolved profile: `agentType` (profile field, default `pi`), `provider`, `model`. A node belongs to: **global**, `byAgentType[agentType]` (if defined), `byProvider[provider]` (if defined), `byModel[provider/model or model]` (if defined). It can start only when **all** its pools have a free slot; on start it increments all; on completion it decrements all. Show live pool usage in the TUI footer (e.g. `global 4/12 · zai 5/7`).

---

## 10. Profile system

### 10.1 Format (reuses pi-subagents `.md` + adds `agentType`)
```markdown
---
name: reviewer
agentType: pi            # NEW. default "pi". values: pi | codex | claude | gemini | opencode | ...
provider: anthropic
model: claude-sonnet-4-5
thinkingLevel: high
tools: read,bash,grep
excludeTools: write      # mutually exclusive with tools
noTools: false
noExtensions: false
extensions: []
noSkills: false
suggestedSkills: []
loadSkills: []
noContextFiles: false
appendSystemPrompt: ""
apiKey: ""               # → resolved per-provider (see note below)
extraArgs: []            # adapter-validated
---
You are a code reviewer. (body = systemPrompt)
```
- All frontmatter fields are optional except `name`. The body replaces the default system prompt (use `appendSystemPrompt` to add instead).
- `agentType` selects which adapter handles the profile. Profiles without `agentType` default to `pi` (so all 18 existing profiles in `~/.pi/agent/agent-profiles/` work unchanged).
- Port pi-subagents' `profileToArgs()`, frontmatter parsing, 5s TTL cache, `excludeTools`→computed-`tools` resolution, and the `extraArgs` security validation (block shell metacharacters; block tool-override flags when tool restrictions active). See `pi-subagents/src/profiles.ts` + `docs/profiles.md` §7-8.
- **`apiKey` handling (CORRECTED — pi does NOT read `PI_API_KEY`):** pi resolves keys **per-provider** from env vars like `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / …, or via the `--api-key <key>` CLI flag (→ `authStorage.setRuntimeApiKey(provider, key)`; verified in `dist/core/auth-storage.js` + `dist/main.js`). **Recommended:** map `profile.apiKey` → the provider's env var (`{PROVIDER.toUpperCase()}_API_KEY`) in the spawn `env` (avoids cmdline exposure via `/proc/PID/cmdline`). Fallback: the `--api-key <key>` flag (simpler, but visible in process listings). The `PI_API_KEY` env var that pi-subagents sets is **inert** — do not copy it.

### 10.2 Resolution precedence (most-specific wins)
1. run-artifacts `.wisp/runs/{run}/artifacts/profiles/*.md`
2. project `.pi/agent-profiles/*.md`
3. global `~/.pi/agent/agent-profiles/*.md`
4. inline `wf.profile({...})` (in-workflow only)

### 10.3 Bespoke profile authoring
The agent authors bespoke profiles by writing `.md`+YAML-frontmatter files **into the run's artifacts dir** (or project/global dirs) using the built-in `write` tool. **wisp does not provide a `create_profile` tool** — file writes + `list_profiles` for discovery is the entire surface.

---

## 11. Configuration (`.wisp/config.json`)

Lives at `<cwd>/.wisp/config.json` (project) and optionally `~/.pi/agent/wisp.config.json` (global; project overrides). Suggested schema:
```json
{
  "maxAgentConcurrency": 12,
  "limits": {
    "byProvider":  { "zai": 7 },
    "byModel":     { "deepseek-v4-flash": 3, "anthropic/claude-sonnet-4-5": 4 },
    "byAgentType": { "pi": 8, "codex": 4, "claude": 4 }
  },
  "profilesDirs": ["~/.pi/agent/agent-profiles", ".pi/agent-profiles"],
  "runsDir": ".wisp/runs",
  "defaultRetries": 3,
  "retryBackoffMs": 2000,
  "adapterDefaults": {
    "pi": { "timeoutSec": 600 }
  }
}
```
- Validate with TypeBox's `Value` namespace (see §18); unknown keys ignored; missing file → all defaults.
- `~` expansion in `profilesDirs`/`runsDir`.

---

## 12. On-disk run layout + audit trail

```
.wisp/
├── config.json
└── runs/
    └── 20260707-1030-fix-bugs/           # {YYYYMMDD-HHMM}-{kebab(workflow title)}
        ├── run.json                      # manifest: status, per-node summary, counts, total timing, cost
        ├── audit.jsonl                   # append-only event log (PRIMARY inspection artifact)
        ├── artifacts/
        │   ├── workflow.ts               # the authored script (copied in)
        │   ├── graph.json                # built IR
        │   └── profiles/*.md             # bespoke profiles for this run
        └── sessions/
            └── {sessionId}.json          # per-agent transcript (messages) + metadata
```

### `audit.jsonl` events (one JSON object per line)
- `run.start { runId, title, slug, graph, ts }`
- `node.start { nodeId, sessionId, agentType, provider, model, profile, stage, ts }`
- `node.tool { nodeId, sessionId, tool, argsSummary?, files?: string[], ts }` — best-effort; `files` from adapter `extractFileEdits` when available
- `node.retry { nodeId, attempt, reason, ts }`
- `node.complete { nodeId, sessionId, status:"completed", durationMs, toolCount, costUsd?, ts }`
- `node.fail    { nodeId, sessionId, status:"failed", durationMs, toolCount, error, ts }`
- `node.skip    { nodeId, reason:"dep-failed", ts }`
- `run.complete { runId, summary, ts }` / `run.fail { runId, summary, ts }`

The orchestrating agent inspects runs by reading these files with built-in tools (no dedicated list/get tools — minimal surface).

### `run.json` (manifest)
Summary object: `{ runId, title, slug, status, startedAt, endedAt, nodes: [{id, status, sessionId, durationMs, toolCount, retries, error?}], totals: {nodes, completed, failed, skipped, totalCostUsd, totalDurationMs} }`. Updated at run end (and optionally progressively).

### Session `.json` files
Per-agent: `{ sessionId, nodeId, agentType, profile, provider, model, messages: [...], finalText, toolCallCount, durationMs, costUsd?, error? }`. Reuse pi-subagents' message-capture approach (cap at ~500 messages).

---

## 13. Tool surface (register EXACTLY these two)

### `run_workflow`
- **Params (TypeBox):** `path?: string` (path to `.ts`), `script?: string` (inline script source — use one of `path`/`script`), `resumeFrom?: string` (runId).
- **Behavior:** §3 data flow. Returns a structured result: synthesized output text + summary `{ runId, runPath, nodes:[{id,status,sessionId,durationMs,toolCount,retries,error?}], totals, failed: [...] }`.
- **Errors (agent-actionable, classified):** `compile` (tsx/syntax + IR build), `validation` (graph/profile/concurrency checks), `runtime` (agent failures). Always include the offending nodeId/line/message and a suggested fix where possible.
- **Live TUI:** stream updates to the widget via `onUpdate?.()` (50ms debounce). Tool result `renderResult` shows the final DAG summary.
- Set `terminate: false` (the agent will naturally continue with the result).

### `list_profiles`
- **Params:** `scope?: "global"|"project"|"run"|"all"` (default `all`), `runId?: string` (to include a specific run's artifact profiles).
- **Returns:** resolved profiles with name, agentType, provider, model, thinkingLevel, tool-summary, source location. Include a truncating renderer.

**Tool names must NOT collide with pi-subagents** (`delegate_to_subagents`, `get_subagent_output`, etc.). `run_workflow` and `list_profiles` are safe.

---

## 14. TUI (live widget)

Use `ctx.ui.setWidget("wisp", linesOrComponent, { placement: "belowEditor" })` (or above). Update via a 50ms-debounced invalidate. Clear with `setWidget("wisp", undefined)` when the run ends. Also set `ctx.ui.setStatus("wisp", "one-line summary")` for glanceability and clear it after.

Example widget content:
```
┌─ wisp: fix-bugs · stage: review-fix · 2/5 nodes ──────────┐
│ ✓ review      do-work      4.2s · 11 tools · 2 files      │
│ ⏳ fix#1       do-work      1.1s ·  3 tools                │
│ ⏳ fix#2       do-work      1.1s ·  5 tools                │
│ · fix#3       queued                                     │
│ ◇ verify      review        waiting (dep: fix)            │
└─ pools: global 4/12 · zai 5/7 ────────────────────────────┘
```
- Per-node row: status glyph (`✓ ⏳ ✗ · ◇`), name, **stage** (derived from primitive type: `do-work` for plain nodes, `review` for review-loop gates, `council-synthesis` for council synth, `merge` for review-fix merge; overridable via node `stage:`), elapsed time, tool-call count, files-touched count.
- Footer: global + busy pool usage.
- Colorize via `ctx.ui.theme.fg(...)`. Reuse pi-subagents' per-tool emoji + one-liner formatting (`src/format-tool-call.ts`) for any expanded/per-node tool detail.
- Consider an expandable view (Ctrl+O) showing per-node rolling tool lines, mirroring pi-subagents' collapsed/expanded window pattern.

---

## 15. State & persistence

- **In-memory:** executor run state (node statuses, pool counters, live sessions) held in closure variables in `src/index.ts` (mirror pi-workflows' closure + accessor-callback pattern so tools can read/mutate).
- **`pi.appendEntry`**: persist run summaries as custom entries (customType e.g. `"wisp:run"`) so the in-memory store can be reconstructed on `session_start` (port pi-subagents' serialize/deserialize + LRU pattern). Stale `"running"` runs → `"error"` on reconstruction.
- **Stale-context guards**: wrap all async handlers that touch `ctx`/`pi.*` in `withStaleGuard` (port from pi-workflows `src/index.ts`) — essential because a long `run_workflow` can outlive a session switch.
- **On-disk** (§12) is the durable truth: even if pi crashes mid-run, the run dir + audit.jsonl survive for agent inspection and resume.

---

## 16. Lifecycle hooks to register (in `src/index.ts`)
- `session_start` / `session_tree`: load config, reconstruct in-memory run store from custom entries, clear timers.
- `session_shutdown`: kill any in-flight agent subprocesses (tree-kill), clear widget/status, flush audit.
- (Optional) `tool_call`: none required — wisp doesn't gate the main agent's tools.
- Register the 2 tools, the widget lifecycle, and any `/wisp` slash command (optional: `/wisp runs` to print recent run paths — nice-to-have).

---

## 17. Suggested module / file structure

```
pi-wisp/
├── package.json              # deps: @earendil-works/pi-coding-agent, @earendil-works/pi-tui, @earendil-works/pi-ai, typebox, yaml, tsx, tree-kill; dev: typescript, vitest, eslint, prettier
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js  .prettierrc  .nvmrc
├── README.md
├── docs/  design.md  dsl.md  adapters.md  architecture.md  configuration.md
├── skills/wisp-authoring/SKILL.md   # teaches the orchestrating agent the DSL + when to use wisp
└── src/
    ├── index.ts              # extension entry; closures; event wiring; tool+widget registration
    ├── types.ts              # GraphIR, IRNode, IREdge, NodeState, RunState, NormalizedEvent, etc.
    ├── constants.ts          # paths (getAgentDir-style), limits, defaults
    ├── config.ts             # .wisp/config.json load + validate + defaults + ~ expansion
    ├── dsl/
    │   ├── builder.ts        # wf() fluent builder + atom/macro methods → in-memory IR
    │   ├── ir.ts             # IR types + validateIR (cycles, ids, deps, schemas)
    │   ├── macros.ts         # reviewLoop/council/reviewFix expansion to atoms
    │   ├── fn-serialize.ts   # Function→{__fn,src} + safe rehydrate via new Function w/ restricted ctx
    │   └── compile.ts        # spawn tsx subprocess, capture IR JSON + stderr, classify errors
    ├── engine/
    │   ├── executor.ts       # DAG execution loop (topo, ready/schedulable, fanOut expansion)
    │   ├── scheduler.ts      # work-stealing pool + concurrency-pool accounting
    │   ├── context.ts        # NodeCtx impl (output/fanOut/member/run/raw)
    │   ├── retry.ts          # retry/skip policy + backoff
    │   └── resume.ts         # resumeFrom: load prior run, mark completed/failed, fresh sessions
    ├── adapters/
    │   ├── types.ts          # AgentAdapter, NormalizedEvent
    │   ├── registry.ts       # register/get adapter by type
    │   └── pi.ts             # pi adapter (buildInvocation, parseEventStreamLine, resumeArgs, edits)
    ├── spawn/
    │   ├── spawner.ts        # spawn + line-buffer + JSONL→NormalizedEvent + abort (port pi-subagents)
    │   └── abort.ts          # tree-kill SIGTERM→SIGKILL + timeout
    ├── profiles/
    │   ├── loader.ts         # .md frontmatter parse (port) + agentType; 5s TTL cache
    │   ├── to-args.ts        # profileToArgs (port) + extraArgs security validation
    │   ├── resolve.ts        # precedence: run › project › global › inline
    │   └── inline.ts         # wf.profile handling
    ├── run/
    │   ├── store.ts          # in-memory run store + pi.appendEntry persist/reconstruct (LRU)
    │   ├── layout.ts         # .wisp/runs/{ts}-{slug}/ creation; artifacts/sessions dirs
    │   ├── audit.ts          # audit.jsonl append writer + run.json manifest writer
    │   └── sessions.ts       # per-session .json writer (messages cap)
    ├── tools/
    │   ├── run-workflow.ts   # run_workflow tool (params, execute, renderCall/renderResult, onUpdate)
    │   └── list-profiles.ts  # list_profiles tool
    ├── tui/
    │   ├── widget.ts         # setWidget component: DAG rows + footer (50ms debounce)
    │   └── format.ts         # status glyphs, stage labels, time/tool formatting, per-tool emojis
    └── utils.ts              # mapWithConcurrencyLimit (port), stripAnsi, debounce, kebab/timecode
└── src/__tests__/            # see §19
```

Add a `skills/wisp-authoring/SKILL.md` so the orchestrating pi agent learns the DSL (mirror pi-workflows' `skills/workflow-generation/SKILL.md` structure). This is how "the agent creates workflows" becomes reliable.

---

## 18. Dependencies & conventions

- **Runtime deps:** `@earendil-works/pi-coding-agent` (direct — the ExtensionAPI), plus transitive `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `typebox`, `yaml`. Add `tsx` (for the DSL compile subprocess) and `tree-kill` (cross-platform process-tree kill; pi-subagents depends on `tree-kill@^1.2.2`). **No ajv** — use TypeBox's `Value` namespace (`import { Value } from "typebox/value"`) for runtime config + `outputSchema` validation. (Verified: pi-subagents and pi-workflows both depend on `typebox` only; neither uses ajv.)
- **Dev deps:** `typescript`, `vitest`, `@types/node`, `eslint`, `prettier`.
- **Conventions (match the sibling extensions):** ESM `"type": "module"`, Node 20+ (`.nvmrc`), synchronous file I/O for config/profile loading (acceptable in event handlers — see pi-workflows' rationale), `node:fs`/`node:path`/`node:child_process`/`node:os`, TypeBox for tool schemas, `StringEnum` from `@earendil-works/pi-ai` for enums (Google-compat). Prettier + ESLint configs matching pi-subagents/pi-workflows. CI via GitHub Actions (`.github/workflows/ci.yml` + `publish.yml`).
- **`package.json` `name`:** `pi-wisp`. Export the DSL builder from the package root (`export { wf }`). ⚠️ **But note:** a standalone `tsx` subprocess spawned at runtime will **not** resolve `import { wf } from "pi-wisp"` unless the package is in the project's `node_modules` (extensions are not installed as resolvable packages). So wisp must **rewrite** that import specifier to the **absolute path** of its compiled builder module before handing the script to tsx (see §6 module-resolution gotcha). Do not assume the import resolves by name.

---

## 19. Testing strategy (vitest — port the sibling extensions' test patterns)

- `dsl/`: unit-test the builder (every atom/macro → expected IR), IR validation (cycle detection, dup ids, missing deps, mutual-exclusivity), fn serialize/rehydrate round-trip (pure fns only), and the tsx compile step with fixture `.ts` files (success + syntax-error classification). Use a mock/fake executor.
- `engine/`: test the executor on small graph fixtures — linear, diamond, fanOut expansion, cond branching, loop-until, retry-then-skip, resume (load fixture run dir → re-run only failed). Use a **fake adapter** that emits scripted NormalizedEvents without spawning processes (decouples engine tests from real CLIs). Test concurrency-pool accounting directly (a node blocked until all pools free).
- `adapters/pi.ts`: parse real captured pi `--mode json` JSONL fixtures → assert normalized events, sessionId, toolCount, file-edits extraction.
- `profiles/`: frontmatter parse, `agentType` defaulting, precedence resolution, `excludeTools`→computed-tools, extraArgs security validation (port pi-subagents' test cases).
- `run/`: run-dir layout creation, audit.jsonl append ordering, run.json manifest shape, session .json cap.
- `tools/`: `run_workflow` + `list_profiles` via the pi-subagents test harness pattern (`__tests__/helpers/`), including error classification.
- Add integration tests (gated/slow) that actually spawn a tiny pi subprocess for the pi adapter end-to-end.

---

## 20. Implementation order (suggested)

1. Scaffold: `package.json`, `tsconfig`, vitest/eslint/prettier, `src/index.ts` minimal extension that registers a no-op tool and loads `.wisp/config.json`. Verify it loads in pi (`pi -e ./dist/index.js` or via local install).
2. `types.ts` + `config.ts` + `constants.ts` + `run/layout.ts`.
3. `profiles/` (loader, to-args, resolve, inline) + unit tests — port from pi-subagents, add `agentType`.
4. `adapters/types.ts` + `adapters/pi.ts` + `spawn/` — port spawner; normalize events; test with captured fixtures.
5. `dsl/` (builder, ir, macros, fn-serialize, compile) + tests — this is the trickiest part (tsx subprocess + fn rehydration); nail it early with a fake executor.
6. `engine/` (executor, scheduler w/ pools, context, retry, resume) using the fake adapter.
7. `run/` (store, audit, sessions) + persistence via `pi.appendEntry`.
8. `tui/widget.ts` + `tools/run-workflow.ts` + `tools/list-profiles.ts`.
9. `skills/wisp-authoring/SKILL.md` + `docs/*`.
10. End-to-end: author a small real workflow (the §4.1 example), run it, inspect `.wisp/runs/`, exercise resume.

---

## 21. Definition of done

- `run_workflow` can author (via inline `script` or `path`) → compile (tsx) → validate → execute the §4.1 example end-to-end with the pi adapter, rendering the live widget, writing `audit.jsonl` + `run.json` + sessions, and returning the synthesized result.
- All three macros (`reviewLoop`, `council`, `reviewFix`) and all atoms work; fanOut expands; cond branches; loop resumes a session.
- Concurrency pools enforced (AND semantics) and shown in the TUI footer.
- Retry-then-skip + resume (`resumeFrom`) verified on a fixture where one node is forced to fail.
- `list_profiles` resolves across run/project/global/inline with correct precedence.
- `AgentAdapter` is abstract enough that a codex/claude adapter could be added by implementing the interface alone (documented in `docs/adapters.md`).
- Vitest suite green; ESLint/Prettier clean; loads cleanly alongside pi-subagents with no tool-name collisions.
- README + `docs/` + `skills/wisp-authoring/SKILL.md` complete.

---

## 22. Open clarifications to resolve with the user ONLY IF blocked (don't guess silently)
- Exact `byModel` key format: bare `model` vs `provider/model` — support both (try `provider/model` then `model`).
- Whether `.loop`/`reviewLoop` worker resume reuses the prior sessionId (recommended yes — that's the point of "session resumed" in your review-loop example) vs wisp's general retry policy (fresh sessions). Document both behaviors.
- Whether `run_workflow` should accept the workflow title explicitly or always derive the slug from the `wf(name)` first arg (recommended: derive from `name`, allow override via options).

Everything else is specified. Build it.
