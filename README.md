# pi-wisp

**pi-wisp** is a multi-agent workflow orchestrator extension for the
[pi coding agent](https://github.com/harms-haus/pi-coding-agent). It lets an
orchestrating pi agent author scripted multi-agent workflows as a directed
acyclic graph (DAG) via a fluent TypeScript DSL. wisp compiles the authored
script to a serializable intermediate representation (IR), executes it
respecting dependencies and layered concurrency pools, spawns `pi` subprocesses
for each node, renders a live TUI widget, persists an on-disk audit trail, and
returns synthesized results.

> **Status:** early development. The DSL, engine, pi adapter, TUI, and tools are
> implemented; see `PLAN.md` for the full roadmap.

## What it does

- **TypeScript DSL** — author a graph of agent runs with fluent atoms
  (`node`, `fanOut`, `cond`, `loop`, `reduce`, `parallel`, `sequence`) and
  composite macros (`reviewLoop`, `council`, `reviewFix`).
- **DAG execution** — topological scheduling, lazy fan-out expansion,
  conditional branching, iteration-until-convergence, and retry-then-skip
  (independent branches keep running — no fail-fast).
- **Layered concurrency pools** — global + per-provider + per-model +
  per-agent-type limits with AND semantics, shown live in the TUI footer.
- **Structured data passing** — declare a JSON `outputSchema` per node; outputs
  are parsed/validated and available to downstream nodes via a context API.
- **Live TUI** — a widget shows per-node status, stage, elapsed time, tool-call
  counts, files touched, and pool usage with 50ms-debounced updates.
- **Durable audit trail** — every run writes `audit.jsonl`, `run.json`, and
  per-session transcripts under `.wisp/runs/`. Failed runs resume via
  `run_workflow({ resumeFrom })`.
- **pi adapter (v1)** — v1 ships only the `pi` adapter; the `AgentAdapter`
  interface is designed so codex/claude/gemini can be added later without engine
  changes.

## Install

### As a pi extension

wisp is a pi-coding-agent extension. Install it as a package and pi auto-loads
it via the `pi.extensions` field in its `package.json`:

```bash
npm install pi-wisp
```

Or load it directly during development:

```bash
pi -e ./src/index.ts
```

This registers two tools — `run_workflow` and `list_profiles` — that do not
collide with the `pi-subagents` tool names, so both extensions can coexist.

### Requirements

- Node.js ≥ 22
- A configured pi harness (`pi auth`, provider env vars) — wisp does **not**
  pass API keys to spawned agents (see [Design decisions](docs/design.md#d3)).

## Quickstart

Author a workflow as a `.ts` file whose **default export** is a `wf()` builder:

```ts
// fix-bugs.ts
import { wf } from "pi-wisp";

export default wf("fix-bugs", { maxConcurrency: 6 })
  .node("review", {
    profileRef: "code-reviewer",
    outputSchema: {
      type: "object",
      properties: { findings: { type: "array", items: { type: "string" } } },
      required: ["findings"],
    },
    prompt: "Review auth/*.ts for bugs. Return JSON { findings: [\"...\"] }.",
  })
  .fanOut("fix", {
    from: "review",
    iterate: (ctx) => ctx.output("review").findings,
    each: (finding) => ({ prompt: `Fix: ${finding}`, profileRef: "fixer" }),
  })
  .reviewLoop("verify", {
    worker: "fix",
    gate: {
      prompt: "Verify all bugs are fixed. Return JSON { allFixed: boolean }.",
      profileRef: "reviewer",
    },
    maxRounds: 3,
    acceptOn: (ctx) => ctx.output("verify:gate").allFixed,
  });
```

Then run it (the orchestrating pi agent calls the `run_workflow` tool):

```
run_workflow({ path: "fix-bugs.ts" })
```

Or pass the source inline:

```
run_workflow({ script: "import { wf } from \"pi-wisp\";\nexport default wf(\"demo\").node(\"a\", { prompt: \"hi\", profileRef: \"default\" });" })
```

wisp compiles the script to an IR, validates it, executes the DAG, and returns
the synthesized result plus a structured per-node summary. Every run lands under
`.wisp/runs/{timestamp}-{slug}/` with a full audit trail.

**Return value:** `run_workflow` returns the **terminal DAG-sink node's** output
as the synthesized result — `findTerminalNode()` selects the unique completed
node with no outstanding (incomplete) downstream dependency; if there is no
unique sink it falls back to the last completed node in iteration order. When
the run **fails** with multiple failed nodes, the result text additionally
includes a per-node summary, one line per failure:

```
  ✗ <nodeId>: <error>
```

The structured `details` object always carries the full `nodes`, `totals`, and
`failed` arrays regardless of outcome.

## Profiles

Nodes reference profiles by name (`profileRef`). Profiles are `.md` + YAML
frontmatter files resolved from (most-specific wins): run-artifact › project
(`.pi/agent-profiles/`) › global (`~/.pi/agent/agent-profiles/`) › inline. All
existing pi-subagents profiles work unchanged (they default to the `pi`
adapter). Discover them with `list_profiles`.

## Configuration

wisp reads `<cwd>/.wisp/config.json` (project) and
`~/.pi/agent/wisp.config.json` (global; project overrides). Missing files yield
defaults. See [docs/configuration.md](docs/configuration.md) for the full schema.

## Documentation

- [docs/dsl.md](docs/dsl.md) — DSL reference, the function purity rule, and the
  threat model.
- [docs/adapters.md](docs/adapters.md) — the `AgentAdapter` interface and the
  pi adapter; future codex/claude/gemini adapter notes.
- [docs/architecture.md](docs/architecture.md) — the four-layer architecture,
  executor, scheduler, and persistence.
- [docs/configuration.md](docs/configuration.md) — `.wisp/config.json` schema
  and concurrency-pool semantics.
- [docs/design.md](docs/design.md) — locked design decisions and rationale.

The authoring skill at [skills/wisp-authoring/SKILL.md](skills/wisp-authoring/SKILL.md)
teaches the orchestrating agent the DSL and when to reach for wisp.

## License

MIT
