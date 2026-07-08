# DSL Reference

The wisp DSL is a fluent TypeScript builder. An orchestrating pi agent authors a
`.ts` script that describes a directed acyclic graph (DAG) of agent runs. wisp
**compiles** that script to a serializable Graph IR (via a `tsx` subprocess),
then **executes** the IR — the script itself never spawns agents.

> See also: [architecture.md](architecture.md) for the compile → execute data
> flow, [configuration.md](configuration.md) for profile resolution, and
> [adapters.md](adapters.md) for the adapter layer.

---

## Table of Contents

- [Module Shape](#module-shape)
- [Entry Point: `wf()`](#entry-point-wf)
- [Atoms](#atoms)
  - [`node()`](#node)
  - [`fanOut()`](#fanout)
  - [`cond()`](#cond)
  - [`loop()`](#loop)
  - [`reduce()` / `merge()`](#reduce--merge)
  - [`parallel()`](#parallel)
  - [`sequence()`](#sequence)
- [Composite Macros](#composite-macros)
  - [`reviewLoop()`](#reviewloop)
  - [`council()`](#council)
  - [`reviewFix()`](#reviewfix)
- [Context API](#context-api)
- [Inline Profiles](#inline-profiles)
- [`outputSchema`](#outputschema)
- [Stage Labels](#stage-labels)
- [Function Serialization & the Closure Limitation](#function-serialization--the-closure-limitation)
- [Threat Model](#threat-model)
- [Resume Behaviors](#resume-behaviors)
- [Graph IR](#graph-ir)
- [IR Validation](#ir-validation)
- [Compilation Subprocess](#compilation-subprocess)

---

## Module Shape

```ts
import { wf } from "pi-wisp";

export default wf("fix-bugs", { maxConcurrency: 6 })
  .node("review", { /* … */ })
  .fanOut("fix", { /* … */ });
```

The `export default` value **must** be the `WorkflowBuilder` returned by `wf()`.
The compile harness reads this default export and calls `.toIR()`.

> **Import resolution:** a standalone `tsx` subprocess cannot resolve
> `"pi-wisp"` by name (extensions are not installed as resolvable packages).
> wisp rewrites the `import … from "pi-wisp"` specifier to the absolute
> `file://` URL of the shipped builder module before invoking tsx. You author
> scripts with `import { wf } from "pi-wisp"` as normal.

---

## Entry Point: `wf()`

```ts
function wf(name: string, options?: WfOptions): WorkflowBuilder;
```

**`WfOptions`:**

| Field             | Type     | Description                                                         |
| ----------------- | -------- | ------------------------------------------------------------------- |
| `maxConcurrency`  | `number` | Overrides the global concurrency cap for this workflow's nodes.     |
| `defaultRetries`  | `number` | Overrides the config-level `defaultRetries` for this workflow.      |
| `title`           | `string` | Overrides the workflow title and slug (slug = kebab-case of title). |

When `title` is absent, both the stored title and the slug are derived from
`name`.

The returned `WorkflowBuilder` exposes fluent methods (atoms, macros, inline
profiles) and a terminal `.toIR()`.

---

## Atoms

Atoms are the low-level building blocks. Each appends nodes and edges to an
internal IR and returns `this` for chaining.

### `node()`

A single agent run.

```ts
node(id: string, spec: NodeSpec): WorkflowBuilder;
```

**`NodeSpec` fields:**

| Field          | Type                  | Description                                                        |
| -------------- | --------------------- | ------------------------------------------------------------------ |
| `agentType`    | `string`              | Adapter type (default `"pi"`). Selects which adapter is used.      |
| `profileRef`   | `string`              | Name of a resolved profile (see [configuration.md](configuration.md)). |
| `prompt`       | `string`              | Static prompt text (see note below on `promptFn`/`promptFnRef`). |
| `outputSchema` | `JSON Schema`         | Post-hoc structured-output schema (see [outputSchema](#outputschema)). |
| `dependsOn`    | `string[]`            | Node ids that must complete before this node can run.              |
| `stage`        | `string`              | Override the auto-derived stage label.                             |
| `retries`      | `number`              | Per-node retry count (overrides config `defaultRetries`).          |
| `timeoutSec`   | `number`              | Per-node timeout.                                                  |
| `cwd`          | `string`              | Working directory override (must be within the project root).      |

> **`promptFn` / `promptFnRef` is internal.** The `NodeSpec` type exposed to
> users carries only the static `prompt` field. `promptFn` (live fn) and
> `promptFnRef` (serialized `FnDescriptor`) exist on the internal `BuilderNode`
> and `IRNode` types — they are populated during macro expansion, not by user
> code. An `IRNode` with both `prompt` and `promptFnRef` is a validation error.

```ts
wf("example")
  .node("review", {
    agentType: "pi", profileRef: "reviewer",
    outputSchema: {
      type: "object",
      properties: { findings: { type: "array", items: { type: "string" } } },
      required: ["findings"],
    },
    prompt: "Find bugs in auth/*.ts. Return JSON {findings:[...]}.",
  });
```

### `fanOut()`

Parallel map: iterates over a dependency's output and spawns one child node per
item. Children are named `<fanOutId>-<index>` and added to the graph **lazily at
ready-time** (after the producer completes).

```ts
fanOut(
  id: string,
  opts: {
    from: string;                                        // producer node id
    iterate: (ctx: unknown) => unknown[];                // produce item array
    each: (item: unknown, ctx: unknown) => NodeSpec;     // map item → node spec
  },
): WorkflowBuilder;
```

Results are addressable via `ctx.fanOut(id)` (an array).

```ts
wf("example")
  .fanOut("fix", {
    from: "review",
    iterate: (ctx) => ctx.output("review").findings,
    each: (f) => ({ agentType: "pi", profileRef: "fixer", prompt: `Fix ${f.title} in ${f.file}` }),
  });
```

### `cond()`

Conditional routing. After the `on` node completes, the `when` predicate is
evaluated; the chosen branch runs and the non-chosen branch is skipped
(`"cond-not-taken"`).

```ts
cond(
  id: string,
  opts: {
    on: string;                                  // upstream node id
    when: (ctx: unknown) => boolean | string;    // predicate (or branch key)
    then: string | NodeSpec;                     // taken when truthy
    else?: string | NodeSpec;                    // taken when falsy
  },
): WorkflowBuilder;
```

When `when` returns a `boolean`, `true` selects `then` and `false` selects
`else`. Both targets may be a node id (string) or an inline `NodeSpec`.

### `loop()`

Runs the body node repeatedly until `until` returns `true` or `maxIterations` is
reached. On subsequent iterations the body receives its **prior transcript via
transcript-replay** (see [Resume Behaviors](#resume-behaviors)).

```ts
loop(
  id: string,
  opts: {
    body: string;                              // body node id
    until: (ctx: unknown) => boolean;          // stop condition
    maxIterations?: number;                    // hard cap (default 3)
  },
): WorkflowBuilder;
```

### `reduce()` / `merge()`

Fan-in: combines outputs from multiple upstream nodes. With a `profile` it is an
**agent-run synthesis**; without one it is a **pure-JS merge**.

```ts
reduce(
  id: string,
  opts: {
    from: string[];                          // upstream node ids
    merge?: (ctx: unknown) => unknown;       // pure-JS merge fn
    profile?: string;                        // agent-run synthesis profile
    agentType?: string;                      // adapter type (default "pi")
  },
): WorkflowBuilder;

merge(id: string, opts: ReduceOpts): WorkflowBuilder;  // alias for reduce()
```

### `parallel()`

Run N independent nodes concurrently. Each child may be a node id (reference to
an existing node) or an inline `NodeSpec` (materialized as `${id}:node:${i}`).

```ts
parallel(
  id: string,
  opts: { nodes: (string | NodeSpec)[] },
): WorkflowBuilder;
```

### `sequence()`

Chain nodes in order; each step depends on the prior. Inline `NodeSpec` children
are materialized as `${id}:step:${i}`.

```ts
sequence(
  id: string,
  opts: { steps: (string | NodeSpec)[] },
): WorkflowBuilder;
```

---

## Composite Macros

Macros are **sugar over atoms** — each expands to a subgraph of atoms (nodes +
edges + conditions) at build time and records its provenance in `PrimitiveMeta`
for stage labeling. Macros exist as expansion functions in
`src/dsl/macros.ts`:

The expanders (`expandReviewLoop`, `expandCouncil`, `expandReviewFix`) live in
`src/dsl/macros.ts` as **internal functions** — they are not re-exported by the
builder and there is no user-importable `pi-wisp/macros` subpath. Each expander
returns a `MacroExpansion` (`{ nodes, edges, conditions }`) of builder-level
nodes that can be spliced into a `WorkflowBuilder`. The structures documented
below describe the expansion each macro produces; consult `src/dsl/macros.ts`
for the authoritative source.

### `reviewLoop()`

A worker does a task, a gate reviews it, and the loop repeats until `acceptOn`
returns `true` or `maxRounds` is reached. The worker receives transcript-replay
for in-conversation continuity across rounds.

**Options (`ReviewLoopOptions`):**

| Field       | Type                          | Description                                      |
| ----------- | ----------------------------- | ------------------------------------------------ |
| `worker`    | `string \| NodeSpec`          | The agent doing the task.                        |
| `gate`      | `string \| NodeSpec`          | The reviewer agent.                              |
| `maxRounds` | `number`                      | Maximum review rounds (must be ≥ 1).             |
| `acceptOn`  | `(ctx) => boolean`            | Accept predicate after each gate review. When absent, runs until `maxRounds`. |

**Expansion:** `loop` whose body is `[worker] → [gate]`, with the loop's `until`
set to `acceptOn` (or `() => false` when absent). The worker's primitive kind is
`"reviewLoopWorker"`, marking it for transcript-replay on loop re-entry.

```ts
expandReviewLoop("verify", {
  worker: { profileRef: "fixer", prompt: "Fix the bugs." },
  gate:   { profileRef: "reviewer", prompt: "Review the fixes." },
  maxRounds: 3,
});
```

### `council()`

Multiple members run concurrently; their outputs are synthesized into a single
consolidated result.

**Options (`CouncilOptions`):**

| Field        | Type                                | Description                             |
| ------------ | ----------------------------------- | --------------------------------------- |
| `members`    | `NodeSpec[]`                        | Member node specs (ids auto-generated). |
| `synthesize` | `NodeSpec & { profile: string }`    | Synthesizer profile + prompt.           |

**Expansion:** `parallel(members) → reduce(synthesize)`. Member ids are
`${id}:member:${i}`; the synthesizer is `${id}:synthesize`. Member outputs are
accessed via the reduce node's `from` array — the engine calls
`ctx.output(from[i])` for each fully-qualified member id (council + general
merge are unified — the `isCouncil` special case was removed).
`ctx.member(i)` remains available inside user-provided DSL functions as a
convenience.

```ts
expandCouncil("design", {
  members: [
    { profileRef: "architect", prompt: "Propose an architecture." },
    { profileRef: "security", prompt: "Propose a security model." },
  ],
  synthesize: { profile: "lead", prompt: "Merge the proposals into one design." },
});
```

### `reviewFix()`

A reviewer identifies problems; one worker is spawned per problem via fanOut;
results are optionally merged.

**Options (`ReviewFixOptions`):**

| Field      | Type                                  | Description                                                   |
| ---------- | ------------------------------------- | ------------------------------------------------------------- |
| `reviewer` | `string \| NodeSpec`                  | The reviewer node.                                            |
| `workers`  | `(ctx) => NodeSpec[]`                 | Returns per-fix NodeSpecs from the reviewer's findings.       |
| `merge`    | `NodeSpec & { profile: string }`      | Optional merge/synthesis node.                                |

**Expansion:** `[reviewer] → fanOut(workers) → merge?`. The `workers` fn doubles
as the fanOut's `iterate` fn (returning per-fix NodeSpecs); `each` is the
identity. A best-effort static guard calls `workers()` at expansion time; if it
returns an empty array (without throwing), the expansion is rejected early.

```ts
expandReviewFix("bugfix", {
  reviewer: { profileRef: "reviewer", prompt: "Find all bugs." },
  workers: (ctx) => ctx.output("reviewer").findings.map((f) => ({
    profileRef: "fixer", prompt: `Fix ${f.title} in ${f.file}`,
  })),
  merge: { profile: "lead", prompt: "Summarize all fixes." },
});
```

---

## Context API

All DSL functions (`iterate`, `each`, `when`, `until`, `merge`, `acceptOn`) are
invoked with a `NodeCtx` at the moment the owning node becomes ready. The
executor guarantees that dependency nodes are completed before a function runs.

```ts
interface NodeCtx {
  /** A prior single node's parsed outputSchema result (or raw text). */
  output(nodeId: string): unknown;
  /** Array of a fanOut node's per-item results (child outputs). */
  fanOut(nodeId: string): unknown[];
  /** Inside a council synthesize — access a member's output by index. */
  member(index: number): { output: unknown };
  /** Metadata about the current run + this attempt. */
  run: { runId: string; title: string; attempt: number; startedAt: number };
  /** Unstructured fallback: raw text + session id for a prior node. */
  raw(nodeId: string): { text: string; sessionId: string };
}
```

- `output()` returns `parsedOutput` when a node has an `outputSchema`, otherwise
  `finalText`.
- `fanOut()` collects child results via the `<parentId>-<index>` naming
  convention.
- `member()` accesses council members by index (`member-<index>`).
- `output()` and `raw()` throw a descriptive error if the referenced node is not
  found or not completed (a caller bug — in practice deps are always populated).

---

## Inline Profiles

Profiles can be defined inline within the workflow via `.profile()`. They are
scoped to the workflow run only (lowest precedence in resolution).

```ts
profile(name: string, config: Record<string, unknown>): WorkflowBuilder;
```

```ts
wf("x")
  .profile("quick-reviewer", {
    agentType: "pi",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    thinkingLevel: "high",
    tools: ["read", "grep"],
    systemPrompt: "You are a reviewer.",
  })
  .node("review", { profileRef: "quick-reviewer", prompt: "…" });
```

`agentType` defaults to `"pi"` when absent. Inline profiles use the same field
set as `.md` profile files — see [configuration.md](configuration.md) for the
full format.

---

## outputSchema

Any `node` may declare an `outputSchema` (a JSON Schema). When present, the
adapter's final text is **JSON-parsed and validated** against the schema
post-hoc using TypeBox's `Value.Check` (the pi adapter does not support native
schema enforcement; adapters that do are documented in
[adapters.md](adapters.md)).

On success, the parsed value is stored as the node's `parsedOutput` and is
available to downstream nodes via `ctx.output()`. On failure (invalid JSON or
schema violation), the node **fails** and is retried per policy (fresh session)
or marked failed.

```ts
node("review", {
  profileRef: "reviewer",
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
  prompt: "Find bugs. Return JSON {findings:[{title,file,severity}]}.",
});
```

Validation uses `validateOutputAgainstSchema(value, schema)` from
`src/dsl/fn-serialize.ts`, which returns `{ ok: true }` or `{ ok: false, errors:
string[] }` with one descriptive entry per schema violation. This function never
throws.

---

## Stage Labels

Each node has a **stage** label shown in the TUI widget, derived from its
primitive metadata:

| Primitive kind / role           | Stage             |
| ------------------------------- | ----------------- |
| Plain node / `"node"`           | `do-work`         |
| `reviewLoop` gate               | `review`          |
| `reviewLoopWorker`              | `do-work`         |
| `council` synthesis             | `council-synthesis` |
| `reviewFix` merge               | `merge`           |
| fanOut child                    | `do-work`         |

A per-node `stage:` override always wins. Per-node derivation logic lives in
`src/tui/format.ts` (`stageLabel()`).

### Header stage

The widget header also shows a single aggregate **header stage** for the whole
run, derived by `deriveHeaderStage()` (`src/tui/widget.ts`):

| Condition                              | Header stage |
| -------------------------------------- | ------------ |
| Any node currently `running`           | that node's stage |
| Else any node `pending` / `ready`      | that node's stage |
| Else any node `failed`                 | `failed`     |
| Else (all completed)                   | `done`       |

---

## Function Serialization & the Closure Limitation

DSL functions (`iterate`, `each`, `prompt`, `when`, `merge`, `until`,
`acceptOn`) are authored as real TypeScript in the workflow script. They cannot
be serialized to plain JSON. wisp handles this in two phases:

### Serialization (at `toIR()` time)

Each function is captured via `Function.prototype.toString()`, which returns the
**exact source** since ES2019. The result is stored as an `FnDescriptor`:

```ts
interface FnDescriptor {
  __fn: true;
  src: string;       // the exact function source
  kind: FnKind;      // "iterate" | "each" | "prompt" | "cond" | "merge" | "until" | "acceptOn" | "synthesize"
}
```

### Rehydration (at execution time)

At node-ready time, the executor rehydrates the function and calls it with the
live `NodeCtx`:

```ts
const result = rehydrateFn(descriptor, nodeCtx);
```

Internally this constructs `new Function(...SHADOWABLE_PARAMS, ...paramNames,
'"use strict"; return (src)(args)')` and calls it. The `return ( ... )(ctx)`
wrapper correctly handles object-literal arrow functions like
`(ctx) => ({ a: 1 })`.

### The Closure Limitation ⚠️

`new Function()` creates a function whose `[[Environment]]` is the **global
scope**, not the lexical environment where the function was authored. This means
**closures over script-scope variables do not survive serialization + rehydration.**

```ts
// ❌ BREAKS: LIMIT is not visible at rehydration time
const LIMIT = 5;
wf("broken").fanOut("x", {
  from: "src",
  iterate: (ctx) => ctx.output("src").filter((i) => i.value > LIMIT),
  each: (item) => ({ prompt: `Process ${item.id}` }),
});
```

```ts
// ✅ WORKS: inline the constant or derive from ctx
wf("ok").fanOut("x", {
  from: "src",
  iterate: (ctx) => ctx.output("src").filter((i) => i.value > 5),
  each: (item) => ({ prompt: `Process ${item.id}` }),
});
```

**Rule: node functions must be pure with respect to `ctx` only.** Inline
constants directly, or derive them from `ctx`. Do not reference outer-scope
variables, imported modules, or runtime APIs.

---

## Threat Model

The rehydrated function runs inside a **restricted context** where Node.js /
runtime globals (`require`, `process`, `fs`, `fetch`, `Buffer`, `setTimeout`,
etc.) are shadowed as `undefined` parameters. This means accidental use of a
Node API throws a `TypeError` at call-time.

**This is a guardrail, NOT a sandbox.** The restricted context is escapable
(e.g., via constructor-rebinding: `(()=>{}).constructor.constructor("return
process")()`). The threat model assumes:

- The **orchestrating agent** (a trusted pi instance) authored the DSL script.
- The script runs on the user's own machine in a trusted project.
- The restriction exists to **catch authoring mistakes** and make the "pure w.r.t.
  `ctx`" contract explicit — not to defend against adversarial code.

The shadowed globals (defined in `SHADOWED_GLOBALS`, filtered by
`SHADOWABLE_PARAMS` to exclude reserved keywords like `import`) are:

```
require, process, fs, fetch, globalThis, Buffer,
setTimeout, setInterval, clearTimeout, clearInterval,
__dirname, __filename, URL
```

---

## Resume Behaviors

wisp has two distinct "resume" mechanisms — do not conflate them:

### 1. General node retry → **fresh session** (D4)

When a node fails and is retried (per the retry policy), each retry uses a
**brand-new session**. The failed session's transcript is discarded. This is the
default for all node failures during execution and for all nodes re-run via
`run_workflow({ resumeFrom })`.

### 2. `.loop()` / `reviewLoop()` worker → **transcript-replay** (D4)

Loop body nodes receive their **prior iteration's transcript** via
`buildResumePrompt()`, prepended to the new prompt for genuine in-conversation
continuity:

```
Previously:

${priorTranscript}

Instructions:

${newPrompt}
```

The transcript is produced by `formatRunsForResume()` (`src/engine/transcript.ts`),
which formats prior session messages with role prefixes (`User:`, `Assistant:`,
`Tool Call:`, `Tool Result:`) and truncates tool call arguments (120 chars) and
tool results (500 chars).

This is the **only place** wisp continues an existing conversation rather than
starting fresh. It does **not** use pi's CLI `--resume` (which is interactive and
incompatible with `--no-session`).

---

## Graph IR

The `.toIR()` method produces a serializable `GraphIR` — the engine-facing
representation. Functions are serialized to `FnDescriptor`s at this point.

```ts
interface GraphIR {
  title: string;
  slug: string;
  options: { maxConcurrency?: number; defaultRetries?: number };
  nodes: IRNode[];                          // flattened, including macro-expanded sub-nodes
  edges: IREdge[];                          // { from, to, kind }
  conditions: IRCondition[];                // { id, on, expr: FnDescriptor }
  schemas: Record<string, unknown>;         // JSON Schema per node id
  primitives: Record<string, PrimitiveMeta>; // macro provenance per node id
  inlineProfiles?: Record<string, WispProfile>;
}
```

**Edge kinds:** `"dep"` | `"fanOut"` | `"cond:branch"` | `"loop"`

**`IRNode` is a discriminated union by `kind`:** `"node"` | `"fanOut"` | `"cond"`
| `"loop"` | `"reduce"` | `"parallel"` | `"sequence"`. Kind-specific fields
(e.g., `fanOut.from` + `fanOut.iterateFnRef` + `fanOut.eachFnRef`) are present
only on the matching member.

---

## IR Validation

`validateIR(ir)` returns a `WispError[]` (empty = valid). Each error is
`{ kind: "validation", nodeId?, message, location? }`. Checks performed:

1. **Unique node ids** — duplicate detection.
2. **Reference resolution** — all `dependsOn`, `fanOut.from`, `cond.on` references
   resolve to existing nodes.
3. **`outputSchema` well-formedness** — must be a JSON-Schema object.
4. **Concurrency sanity** — `maxConcurrency` ≥ 1 when set.
5. **Mutual exclusivity** — a node may not have both `prompt` and `promptFnRef`.
6. **Path traversal** — a node `cwd` must resolve within the project root.
7. **Edge consistency** — every edge `from`/`to` resolves to a node.
8. **Cycle detection** — iterative DFS with 3-color marking; the cycle path is
   reconstructed and reported.

---

## Compilation Subprocess

The authored `.ts` script is compiled to a Graph IR via a `tsx` subprocess (not
in-process). This provides isolation (a syntax error can't crash the host pi
process) and real TypeScript support.

**Process:** `node --import tsx --no-warnings <harnessPath> <rewrittenScriptPath>`

`builderPath` and `harnessPath` are **absolute paths** to the shipped builder
(`src/dsl/builder.ts`) and compile harness (`src/dsl/compile-harness.ts`)
modules, resolved at load time via `import.meta.url` in `src/constants.ts`.
Absolute paths are required because the tsx subprocess runs from the user's
project cwd — a relative path would resolve against the wrong directory and
ENOENT.

1. wisp rewrites `from "pi-wisp"` → `from "<file:// builderPath>"` in the script.
2. The rewritten script is written to a temp `.ts` next to the original (so
   relative imports resolve).
3. The compile harness (`src/dsl/compile-harness.ts`) dynamically imports the
   rewritten script, reads its `default` export, calls `.toIR()`, and writes the
   IR JSON to **stdout** (clean-stdout protocol — all diagnostics go to stderr).
4. wisp captures stdout + stderr + exit code.

**Error classification** (`classifyStderr` in `src/dsl/compile.ts`):

| Signal                                        | Classified as |
| --------------------------------------------- | ------------- |
| esbuild transform error (`path:line:col: ERROR:`) | `compile`     |
| `✘ [ERROR]`, `error TS…`, `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | `compile` |
| `ReferenceError`, `TypeError`, `Error: …` at runtime | `runtime`     |
| Unrecognized / empty stderr                   | `compile` (generic) |

Validation errors (from `validateIR`) are classified as `validation`. All errors
include the offending `nodeId`/`location` when extractable, so the agent can
inspect further with `read`/`grep`.

The compile subprocess has a **30-second timeout**.
