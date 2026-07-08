---
name: wisp-authoring
description: Author and execute multi-agent workflow DAGs with pi-wisp. Use when you need to coordinate multiple agents as a dependency graph — review-loops, councils, parallel fixes, conditional branching, fan-out/map-reduce. Covers the fluent TypeScript DSL (atoms + composite macros), the context API, profiles and outputSchema, the function purity rule, bespoke profile authoring, resume, and inspecting the on-disk audit trail.
---

# Wisp Workflow Authoring

This skill teaches how to author and run **pi-wisp** workflows — scripted
multi-agent DAGs that the orchestrating pi agent compiles, executes, and
synthesizes. wisp is a pi-coding-agent extension that exposes two tools:
`run_workflow` and `list_profiles`.

Read this entire file before writing any workflow.

## When to use wisp

Use wisp when a task benefits from **multiple coordinated agent runs with
dependencies**, structured data passing between agents, or iterative refinement
loops. wisp is overkill for a single delegation — use `delegate_to_subagents`
for that. Reach for wisp when you need:

- **Review-fix loops** — one agent reviews, others fix, a gate re-checks, repeat
  up to N rounds (`.reviewLoop`).
- **Councils** — several agents answer in parallel, a synthesizer merges their
  outputs into one result (`.council`).
- **Review → parallel fix → merge** — a reviewer identifies problems, one worker
  spawns per problem, results are merged (`.reviewFix`).
- **Fan-out / map-reduce** — iterate over a dependency's structured output and
  spawn one agent per item (`.fanOut` + `.reduce`).
- **Conditional routing** — branch to different agents based on a prior output
  (`.cond`).
- **Iteration until convergence** — re-run a body with session continuity until a
  predicate accepts (`.loop`).

When a single sequential subagent call suffices, do not use wisp.

## How a workflow runs

1. You write the workflow source (a TypeScript snippet whose **default
   export** is a `wf()` builder chain) and pass it **inline** to the tool:
   `run_workflow({ script })`.
2. wisp spawns a `tsx` subprocess that evaluates your script, runs the builder,
   and emits a `graph.json` IR. **Your script only builds the graph — it never
   spawns agents.**
3. wisp validates the IR (cycles, dangling references, schema well-formedness),
   creates a run directory under `.wisp/runs/`, **copies your script into that
   run dir as `artifacts/workflow.ts`**, and executes the DAG respecting
   dependencies and layered concurrency pools.
4. Each node spawns a `pi` subprocess; wisp streams its output, renders a live
   TUI widget, writes `audit.jsonl` + `run.json` + per-session files, and returns
   the synthesized result into your context.

> **⚠️ Do not author workflow files in the project.** Always pass the source
> inline via `run_workflow({ script })`. wisp persists the script into the run
> directory (`artifacts/workflow.ts`) for every run — that is the canonical
> place a workflow source lives, and it keeps the project tree clean. Avoid
> `run_workflow({ path })` / creating `.ts` files under the repo unless you are
> deliberately running a pre-existing, version-controlled workflow file.

## Module shape

A workflow is a TypeScript snippet with a default export — passed inline as
`run_workflow({ script })` (not written to a file):

```ts
import { wf } from "pi-wisp";

export default wf("fix-bugs", { maxConcurrency: 6 })
  .node("review", { /* ... */ })
  .fanOut("fix", { /* ... */ })
  .reviewLoop("verify", { /* ... */ });
```

- `wf(name, options?)` — `name` is the workflow title; the run-directory slug is
  derived from it via kebab-case. `options`:
  - `maxConcurrency?: number` — workflow-level global pool override.
  - `defaultRetries?: number` — retry count for nodes without their own.
  - `title?: string` — override the stored title and slug.
- Every builder method returns `this` (fluent chaining).
- Call `export default` on the chain — that builder is what wisp compiles.

> **Import resolution:** your script imports `from "pi-wisp"`. At compile time
> wisp rewrites this to the absolute path of its shipped builder, so the package
> does not need to be installed in the project's `node_modules`. Author the
> import as `import { wf } from "pi-wisp"` and it will resolve.

## Atoms (low-level primitives)

### `.node(id, spec)` — a single agent run

```ts
.node("review", {
  profileRef: "code-reviewer",
  prompt: "Review auth/*.ts for bugs. Return JSON { findings: [{title, file, severity}] }.",
  outputSchema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            file: { type: "string" },
            severity: { type: "string" },
          },
          required: ["title", "file"],
        },
      },
    },
    required: ["findings"],
  },
  dependsOn: ["setup"],
  stage: "review",
  retries: 5,
  timeoutSec: 600,
  cwd: "./src",
})
```

`NodeSpec` fields:

| Field | Type | Notes |
|---|---|---|
| `profileRef` | `string` | Name of a resolved profile (see [Profiles](#profiles)). |
| `agentType` | `string` | Adapter type, default `"pi"`. v1 ships only `pi`. |
| `prompt` | `string` | Static prompt text piped to the agent via stdin. |
| `outputSchema` | `JSON Schema` | When set, the agent's final text is parsed as JSON and validated post-hoc via TypeBox. On failure the node fails (→ retry). On success the parsed value is available to downstream nodes via `ctx.output()`. |
| `dependsOn` | `string[]` | Node ids that must complete first. |
| `stage` | `string` | Stage label shown in the TUI (default derived from primitive kind: `do-work` for plain nodes). |
| `retries` | `number` | Per-node retry override (default from config). |
| `timeoutSec` | `number` | Per-node timeout in seconds. |
| `cwd` | `string` | Working-directory override for the spawned agent (must be inside the project root). |

### `.fanOut(id, { from, iterate, each })` — parallel map

Spawns one child node per item produced by `iterate` over a dependency's output.
Children are named `<id>-0`, `<id>-1`, … and are addressable as an array via
`ctx.fanOut(id)`.

```ts
.fanOut("fix", {
  from: "review",
  iterate: (ctx) => ctx.output("review").findings,
  each: (finding) => ({
    prompt: `Fix ${finding.title} in ${finding.file}`,
    profileRef: "fixer",
  }),
})
```

- `from: string` — the producer node id (must be completed before expansion).
- `iterate: (ctx) => unknown[]` — returns the array of items.
- `each: (item) => NodeSpec` — maps one item to a node spec (prompt,
  profileRef, outputSchema, …). At runtime the `each` fn is called with the
  **item only**; access prior outputs via the `iterate` fn's result or derive
  the prompt from the item itself.

Expansion is **lazy**: children are created when the producer completes, at
ready-time.

### `.cond(id, { on, when, then, else? })` — conditional routing

```ts
.cond("route", {
  on: "triage",
  when: (ctx) => ctx.output("triage").needsHuman, // boolean, or a branch key
  then: "escalate",       // node id, or an inline NodeSpec
  else: { prompt: "Auto-resolve", profileRef: "fixer" },
})
```

- `on: string` — the node whose completion triggers the check.
- `when: (ctx) => boolean | string` — truthy → `then`; falsy → `else`.
- `then` / `else?: string | NodeSpec` — the chosen branch. The non-chosen branch
  is marked `skipped` (`reason: "cond-not-taken"`).

### `.loop(id, { body, until, maxIterations? })` — iterate until accepted

Re-runs the body node (with **session continuity** — see [Session continuity &
fresh sessions](#session-continuity--fresh-sessions)) until `until` returns true.

```ts
.loop("refine", {
  body: "worker",          // node id of the body (must be defined separately)
  until: (ctx) => ctx.output("worker").done,
  maxIterations: 3,
})
```

- `body: string` — node id of the loop body.
- `until: (ctx) => boolean` — called after each iteration; `true` stops the loop.
- `maxIterations?: number` — hard cap (default `3`). The loop completes when
  `until` accepts **or** the cap is reached.

### `.reduce(id, opts)` / `.merge(id, opts)` — fan-in / synthesis

Combines outputs from multiple upstream nodes. Two modes:

- **Agent-run synthesis** (when `profile` is set): spawns a synthesis agent whose
  prompt references all member outputs.
- **Pure-JS merge** (when `merge` is set, no `profile`): rehydrates the `merge`
  fn; plain objects are deep-merged (last-writer-wins on conflicts).

```ts
.reduce("summary", {
  from: ["fix-0", "fix-1", "fix-2"],
  profile: "synthesizer",          // agent-run synthesis
})
// or pure-JS:
.merge("combined", {
  from: ["a", "b"],
  merge: (ctx) => ({ a: ctx.output("a"), b: ctx.output("b") }),
})
```

`ReduceOpts`: `from: string[]`, `merge?: (ctx) => unknown`, `profile?: string`,
`agentType?: string`. (`.merge` is a pure alias for `.reduce`.)

### `.parallel(id, { nodes })` — run independent nodes concurrently

```ts
.parallel("scouts", {
  nodes: [
    { prompt: "Scout module A", profileRef: "scout" },
    { prompt: "Scout module B", profileRef: "scout" },
  ],
})
```

Each `NodeSpec` is materialized inline (auto-generated child ids). String entries
reference already-defined nodes. Concurrency is bounded by the configured pools.

### `.sequence(id, { steps })` — ordered chain

```ts
.sequence("pipeline", {
  steps: [
    { prompt: "Step 1", profileRef: "worker" },
    { prompt: "Step 2", profileRef: "worker" },
  ],
})
```

Each step depends on the prior one.

## Composite macros (sugar over atoms)

Macros expand to the same IR atoms do — the executor treats them uniformly.

### `.reviewLoop(id, { worker, gate, maxRounds, acceptOn? })`

Worker does the task; gate reviews it; repeat until accepted or `maxRounds`.

```ts
.reviewLoop("verify", {
  worker: { prompt: "Implement the feature.", profileRef: "coder" },
  gate: { prompt: "Review the implementation for correctness.", profileRef: "reviewer" },
  maxRounds: 3,
  acceptOn: (ctx) => ctx.output("verify:gate").approved,
})
```

- `worker: string | NodeSpec` — the agent doing the work.
- `gate: string | NodeSpec` — the reviewer.
- `maxRounds: number` — maximum iterations (must be ≥ 1).
- `acceptOn?: (ctx) => boolean` — called after each gate review; `true` breaks the
  loop. When omitted, the loop runs the full `maxRounds` (the gate's verdict alone
  does not short-circuit).

The worker receives **transcript-replay** on subsequent iterations for genuine
in-conversation continuity (see [Session continuity](#session-continuity--fresh-sessions)).

### `.council(id, { members, synthesize })`

Members answer in parallel; the synthesizer merges all outputs.

```ts
.council("design", {
  members: [
    { prompt: "Propose an architecture.", profileRef: "architect" },
    { prompt: "Propose an architecture.", profileRef: "staff-eng" },
    { prompt: "Propose an architecture.", profileRef: "principal" },
  ],
  synthesize: {
    prompt: "Merge the proposed architectures into one recommendation.",
    profile: "synthesizer",
  },
})
```

- `members: NodeSpec[]` — must be non-empty. Each gets an auto-generated id.
- `synthesize: NodeSpec & { profile: string }` — an agent-run synthesis node.
  Its `prompt` is a static instruction (e.g. "Merge the proposals"); wisp
  automatically gathers every member's output and embeds them into the prompt
  sent to the synthesis agent — you do not reference members manually.

### `.reviewFix(id, { reviewer, workers, merge? })`

Reviewer identifies problems; one worker spawns per problem; results are
optionally merged.

```ts
.reviewFix("cleanup", {
  reviewer: { prompt: "List all TODO comments.", profileRef: "reviewer" },
  workers: (ctx) =>
    ctx.output("cleanup:reviewer").todos.map((t) => ({
      prompt: `Resolve TODO in ${t.file}:${t.line}`,
      profileRef: "fixer",
    })),
  merge: { prompt: "Summarize all changes made.", profile: "summarizer" },
})
```

- `reviewer: string | NodeSpec` — identifies the problems.
- `workers: (ctx) => NodeSpec[]` — returns one node spec per problem. This fn
  doubles as the fanOut's iterate fn (so it runs at expansion time, not build
  time).
- `merge?: NodeSpec & { profile: string }` — optional synthesis node.

> **Field naming:** `.node()` / `fanOut.each()` / `cond.then`/`else` /
> macro `worker`/`gate`/`reviewer`/`members` use **`profileRef`**. The synthesis
> inputs (`.reduce`/`.merge` `profile`, council `synthesize.profile`,
> reviewFix `merge.profile`) use **`profile`**. Match these exactly.

## The context API (`ctx`)

Every function you pass (`iterate`, `each`, `when`, `until`, `acceptOn`,
`merge`) receives a context object at **node-ready time** — when all of the
current node's dependencies are completed. This guarantees
`ctx.output("review")` is populated for a node that depends on `review`.

```ts
interface NodeCtx {
  output(nodeId: string): unknown;     // a prior node's parsed outputSchema result (or raw finalText)
  fanOut(nodeId: string): unknown[];   // array of a fanOut node's per-item child results
  member(index: number): { output: unknown }; // inside a council synthesize
  run: { runId: string; title: string; attempt: number; startedAt: number };
  raw(nodeId: string): { text: string; sessionId: string }; // unstructured fallback
}
```

- `output(id)` returns the **parsed** `outputSchema` result when the node has a
  schema; otherwise the raw final text. Throws if the node isn't completed.
- `fanOut(id)` returns the array of child results (`<id>-0`, `<id>-1`, …).
- `member(i)` is used inside council synthesis to access the i-th member's output.
- `raw(id)` gives `{ text, sessionId }` when you need the unstructured text or
  session pointer.

## outputSchema: structured data passing

Declare a `outputSchema` (a plain JSON Schema object) on a node to get parsed,
validated output. wisp JSON-parses the agent's final text and validates it with
TypeBox `Value.Check`. On success, the parsed object is what `ctx.output()`
returns downstream. On parse/validation failure the node **fails** and retries
per its policy — so prompt the agent to return *only* valid JSON.

```ts
.node("analyze", {
  profileRef: "analyst",
  outputSchema: { type: "object", properties: { score: { type: "number" } }, required: ["score"] },
  prompt: "Analyze and return JSON { score: number }.",
})
// downstream:
.each: (item, ctx) => ({ prompt: `Score was ${ctx.output("analyze").score}` })
```

## ⚠️ The function purity rule (critical)

Every function you write (`iterate`, `each`, `when`, `until`, `acceptOn`,
`merge`) is **serialized** via `Function.prototype.toString()` and **rehydrated**
in the executor inside a restricted context. This means:

> **Functions must be pure with respect to `ctx` (and the `item`/`index`
> arguments). They MUST NOT close over script-scope variables.**

✅ Correct — everything derives from `ctx`:

```ts
iterate: (ctx) => ctx.output("review").findings,
each: (finding, _ctx) => ({ prompt: `Fix ${finding.title}`, profileRef: "fixer" }),
```

❌ Broken — `LIMIT` is a closure variable that will not survive serialization:

```ts
const LIMIT = 5;
// ...
iterate: (ctx) => ctx.output("review").findings.filter((f) => f.severity >= LIMIT), // LIMIT is undefined on rehydration!
```

✅ Fix — inline the constant:

```ts
iterate: (ctx) => ctx.output("review").findings.filter((f) => f.severity >= 5),
```

The restricted context also shadows Node globals (`require`, `process`, `fs`,
`fetch`, `Buffer`, `setTimeout`, …) as `undefined`, so accidental use of Node
APIs throws at runtime. This is a **guardrail against authoring mistakes, not a
security sandbox** — the orchestrating (trusted) agent authored the script. Keep
functions as simple arrow/expression functions over `ctx` only.

## Profiles

A profile is a named, reusable agent configuration (model, provider, tools,
system prompt, …). Profiles reuse the pi-subagents `.md` + YAML-frontmatter
format and add an `agentType` field (default `"pi"`).

### Resolution precedence (most-specific wins)

1. **Run-artifact** — `<runDir>/artifacts/profiles/*.md`
2. **Project** — `<cwd>/.pi/agent-profiles/*.md`
3. **Global** — `~/.pi/agent/agent-profiles/*.md`
4. **Inline** — `wf.profile(name, {...})` in the workflow (lowest precedence)

All 18 existing global profiles in `~/.pi/agent/agent-profiles/` work unchanged
(profiles without `agentType` default to `pi`). Use `list_profiles` to discover
available profiles across scopes before creating new ones.

### Reusing existing profiles

Always check existing profiles first. Reuse before creating:

```ts
.node("review", { profileRef: "code-reviewer", prompt: "..." }) // reuse a global profile
```

### Inline profiles

Define a profile inline (scoped to the workflow, never written to disk):

```ts
wf("x")
  .profile("quick-reviewer", {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    thinkingLevel: "high",
    tools: ["read", "grep"],
    systemPrompt: "You are a meticulous code reviewer.",
  })
  .node("review", { profileRef: "quick-reviewer", prompt: "..." })
```

Inline profiles are the **fallback** (lowest precedence), so a project/global
profile with the same name wins.

### Bespoke profile authoring (via the built-in `write` tool)

wisp **does not provide a `create_profile` tool**. To author a bespoke profile,
write a `.md` + YAML-frontmatter file with the built-in `write` tool into a
profiles directory:

```markdown
---
name: bug-reviewer
agentType: pi
provider: anthropic
model: claude-sonnet-4-5
thinkingLevel: high
tools: read,bash,grep
---
You are a bug reviewer. Find concrete, actionable defects only.
```

Write it to one of:

- `<runDir>/artifacts/profiles/bug-reviewer.md` — scoped to a single run
  (highest precedence; write into the run's artifacts dir before calling
  `run_workflow({ resumeFrom })` or alongside a fresh run).
- `<cwd>/.pi/agent-profiles/bug-reviewer.md` — project-scoped.
- `~/.pi/agent/agent-profiles/bug-reviewer.md` — global (reusable everywhere).

**Key frontmatter fields** (all optional except `name`):

| Field | Notes |
|---|---|
| `name` | Profile name (must be unique within its scope). |
| `agentType` | Adapter type, default `pi`. |
| `provider` | e.g. `anthropic`, `openai`, `dashscope` → `--provider`. |
| `model` | Model id → `--model`. |
| `thinkingLevel` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh`. |
| `tools` | Comma-separated allowlist (mutually exclusive with `excludeTools`). |
| `excludeTools` | Blacklist resolved against the full tool set at run time. |
| `systemPrompt` | The Markdown body **replaces** the default system prompt. |
| `appendSystemPrompt` | Appends to the default instead of replacing. |
| `noTools` / `noExtensions` / `noSkills` / `noContextFiles` | Boolean flags. |
| `suggestedSkills` / `loadSkills` | Skill names/paths. |
| `extraArgs` | Additional CLI args (validated for shell-safety + override-blocking). |

> **`apiKey` is unused by wisp.** The profile format retains it for
> compatibility, but the pi adapter does not forward credentials. Configure the
> pi harness directly (`pi auth`, provider env vars) — the spawned agents inherit
> the host environment.

## Session continuity & fresh sessions

Two distinct behaviors — do not confuse them:

| Scenario | Behavior |
|---|---|
| **General node retry** (node failed) | **Fresh session** each retry. The failed session is discarded; the node re-runs from scratch. |
| **`.loop` / `.reviewLoop` worker** | **Transcript-replay.** The worker's prior iteration text is prepended to the new prompt for genuine in-conversation continuity across rounds. The gate reviews each iteration. |

Loop/reviewLoop resume does **not** use pi's interactive `--resume`; it feeds the
prior transcript into a fresh `--no-session` process (transcript-replay).

## Resume a failed run

When a run completes with failed/skipped nodes, inspect the audit trail, fix the
root cause (e.g. a broken profile, a too-strict schema, a flaky agent), then
resume:

```ts
run_workflow({ resumeFrom: "20260707-1030-fix-bugs" })
// resumeFrom accepts the run directory slug or full path.
```

On resume, wisp:

1. Loads the prior run's `artifacts/graph.json` + `run.json`.
2. Keeps already-**completed** nodes completed (their outputs are reused —
   dependents see them via the context API without re-running).
3. Resets **failed / skipped / unfinished** nodes to `pending` with **fresh
   sessions** and re-executes them.
4. Independent branches that already succeeded are not re-run.

`resumeFrom` accepts the run-dir slug (e.g. `20260707-1030-fix-bugs`) or an
absolute/relative path. Find run slugs under `.wisp/runs/`.

## Inspecting runs (built-in tools)

wisp writes a durable on-disk record for every run. Inspect it with the built-in
`read`, `grep`, and `ls` tools — there are no dedicated list/get tools.

```
.wisp/
├── config.json
└── runs/
    └── 20260707-1030-fix-bugs/      # {YYYYMMDD-HHMM}-{kebab-title}
        ├── run.json                 # manifest: per-node status + totals
        ├── audit.jsonl              # append-only event log (PRIMARY artifact)
        ├── artifacts/
        │   ├── workflow.ts          # the authored script (copied in)
        │   ├── graph.json           # the compiled IR
        │   └── profiles/*.md        # bespoke profiles for this run
        └── sessions/
            └── {sessionId}.json     # per-agent transcript + metadata
```

- **`audit.jsonl`** — one JSON object per line: `run.start`, `node.start`,
  `node.tool`, `node.retry`, `node.complete`, `node.fail`, `node.skip`,
  `run.complete` / `run.fail`. Use `grep` to find failures
  (`grep '"node.fail"' .wisp/runs/<slug>/audit.jsonl`).
- **`run.json`** — the manifest: `{ runId, title, status, nodes: [...], totals }`.
  Read this first for a per-node status summary.
- **`sessions/*.json`** — per-agent transcripts (messages, finalText,
  toolCallCount, durationMs, error).

## Building a workflow — checklist

1. **Decide the shape** — Is it a review-loop? A council? A fan-out? Plain DAG?
   Pick the smallest primitive that fits.
2. **Check existing profiles** — call `list_profiles` and scan
   `~/.pi/agent/agent-profiles/` before creating any.
3. **Author bespoke profiles** (if needed) — write `.md` files with `write` into
   the appropriate profiles dir. One responsibility per profile; restrict tools
   to the minimum; set `thinkingLevel` appropriately.
4. **Write the workflow source** — chain atoms/macros off `wf(name)`. Keep all
   functions **pure w.r.t. `ctx`** (no closure-captured outer variables).
5. **Add `outputSchema`** where you need structured data to flow between nodes.
6. **Export default** the builder chain.
7. **Run it** — `run_workflow({ script })` with the source passed **inline**.
   Do not write the workflow to a file in the project; wisp persists it into the
   run dir (`artifacts/workflow.ts`) for you.
8. **Inspect** — read `run.json` and `audit.jsonl`; if nodes failed, fix the
   cause and `run_workflow({ resumeFrom })`.

## Common patterns

### Review → parallel fix → verify loop

```ts
import { wf } from "pi-wisp";

export default wf("fix-bugs", { maxConcurrency: 6 })
  .node("review", {
    profileRef: "code-reviewer",
    outputSchema: { type: "object", properties: { findings: { type: "array", items: { type: "string" } } }, required: ["findings"] },
    prompt: "Review auth/*.ts for bugs. Return JSON { findings: [\"...\"] }.",
  })
  .fanOut("fix", {
    from: "review",
    iterate: (ctx) => ctx.output("review").findings,
    each: (finding) => ({ prompt: `Fix: ${finding}`, profileRef: "fixer" }),
  })
  .reviewLoop("verify", {
    worker: "fix",
    gate: { prompt: "Verify all bugs are fixed. Return JSON { allFixed: boolean }.", profileRef: "reviewer" },
    maxRounds: 3,
    acceptOn: (ctx) => ctx.output("verify:gate").allFixed,
  });
```

### Council of three

```ts
export default wf("design-council")
  .council("design", {
    members: [
      { prompt: "Propose an architecture for the auth service.", profileRef: "architect" },
      { prompt: "Propose an architecture for the auth service.", profileRef: "staff-eng" },
    ],
    synthesize: { prompt: "Merge the two proposals into one.", profile: "synthesizer" },
  });
```

### Conditional routing

```ts
export default wf("triage")
  .node("classify", { profileRef: "classifier", prompt: "Classify the issue severity.", outputSchema: { type: "object", properties: { severity: { type: "string" } }, required: ["severity"] } })
  .cond("route", {
    on: "classify",
    when: (ctx) => ctx.output("classify").severity === "critical",
    then: { prompt: "Escalate immediately.", profileRef: "oncall" },
    else: { prompt: "Queue for normal handling.", profileRef: "worker" },
  });
```
