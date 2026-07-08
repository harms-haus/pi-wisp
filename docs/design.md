# Design Decisions

This document records the locked design decisions for pi-wisp, with rationale
and pointers to where each is implemented. These decisions were settled during
the design/interview phase and override the illustrative examples in
`IMPLEMENTATION_PROMPT.md`. The full decision record lives in `DECISIONS.md`;
this file provides the prose, rationale, and impact for each.

---

## D1 — Adapter scope for v1: pi-only

**Decision:** Ship only the `pi` adapter in v1. codex, claude, gemini, and
opencode adapters are documented for later addition but **not built**.

**Rationale:** The pi adapter is the only CLI whose output model wisp needs to
normalize for its own host ecosystem. Web research confirmed all four other CLIs
are now mature with stable headless JSON + native session resume, so the
`AgentAdapter` interface (see [adapters.md](adapters.md)) is verified to
accommodate them with no future engine changes. Building one adapter first keeps
the surface small and the execution path fully testable end-to-end.

**Impact on the codebase:**

- The `AgentAdapter` interface (`src/adapters/types.ts`) is the extension point.
  It defines `buildInvocation`, `parseEventStreamLine`, resume hooks, metadata
  extraction, and an optional native-output-schema hook (D2).
- `src/adapters/pi.ts` is the only concrete adapter. It is registered via the
  adapter registry and is the fallback for any profile whose `agentType` is not
  `"pi"` (with a warning).
- Profiles default `agentType` to `"pi"` when absent (`src/profiles/loader.ts`),
  so the existing global profiles in `~/.pi/agent/agent-profiles/` work
  unchanged. The `agentType` field is still parsed and stored so future adapters
  can be selected per-profile.
- Future adapters are added by implementing the `AgentAdapter` interface alone —
  no engine changes. See [adapters.md](adapters.md) for the canonical CLI
  invocations researched for each.

---

## D2 — Optional native-output-schema hook on AgentAdapter

**Decision:** Add an optional `supportsNativeOutputSchema?: boolean` and
`outputSchemaArgs?(schema: JSONSchema): string[]` to the `AgentAdapter`
interface now.

**Rationale:** codex (`--output-schema`) and claude (`--json-schema`) can
enforce a node's `outputSchema` natively at the CLI level. The pi adapter cannot
(it has no equivalent flag). Adding the optional hooks now is cheap and avoids a
painful interface retrofit later. Default behavior — the hook absent or `false`
— is the existing post-hoc validation path.

**Impact on the codebase:**

- The interface (`src/adapters/types.ts`) carries both optional members.
- The pi adapter leaves them **unset**. The executor therefore performs
  **post-hoc** validation: it JSON-parses the agent's final text and validates it
  against the node's schema with TypeBox `Value.Check` /
  `validateOutputAgainstSchema` (`src/dsl/fn-serialize.ts`). On failure the node
  fails and retries per its policy.
- A future adapter that sets `supportsNativeOutputSchema: true` would emit
  `outputSchemaArgs(schema)` in `buildInvocation`; the executor would then skip
  post-hoc validation (the CLI already constrained the output).

---

## D3 — wisp does not pass API keys; the harness must be pre-configured

**Decision:** wisp does not manage, map, or forward API keys. The spawned `pi`
(and any future adapter's CLI) inherits the host process environment and reads
its own persisted auth storage on startup.

**Rationale:** The `{PROVIDER.toUpperCase()}_API_KEY` env-var mapping problem is
entirely removed. wisp assumes the harness is already authenticated (via
`pi auth`, provider env vars the user already set, etc.). Passing keys on the
command line also exposes them via `/proc/PID/cmdline`; inheriting the host env
avoids that.

**Impact on the codebase:**

- The pi adapter's `buildInvocation` (`src/adapters/pi.ts`) adds **no**
  `--api-key` flag and returns an **empty** `env` object. The spawned process
  inherits the parent environment.
- `profileToArgs` (`src/profiles/to-args.ts`) does **not** emit `--api-key` and
  sets no provider env var. The `apiKey` field is **retained** in the
  `WispProfile` type (`src/profiles/types.ts`) and is still **parsed** by the
  profile loader for format compatibility — but it is **never acted on**.
  Document it as "unused by wisp; configure the harness directly."
- Notably, the `PI_API_KEY` env var that pi-subagents sets is **inert** in pi
  core (pi resolves keys per-provider from `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` / …, or via `--api-key`). wisp does **not** set it.

> **For authors:** to use a different provider/key for spawned agents, configure
> the pi harness directly (`pi auth`, or set the provider's env var in the
> environment wisp inherits). Do not put keys in profile frontmatter — the field
> is ignored.

---

## D4 — Loop/reviewLoop worker resume = transcript-replay; general retry = fresh session

**Decision:** `.loop` / `.reviewLoop` worker nodes receive their **prior
transcript** via transcript-replay for genuine in-conversation continuity across
rounds. General node retries (a node that failed) use **fresh sessions** — the
failed session is discarded.

**Rationale:** A review loop is only useful if the worker can "remember" what it
already did and what the gate said, so subsequent iterations build on prior work.
But retrying a genuinely failed task from a fresh session avoids repeating a
corrupted / error-prone conversation state. These are two distinct needs with two
distinct mechanisms.

**Impact on the codebase:**

- The pi adapter sets `supportsNativeResume: false` and does **not** implement
  `resumeArgs` — pi's `--resume` is interactive (browse/select) and incompatible
  with `--no-session`. wisp never uses it.
- Instead, `buildResumePrompt(priorTranscript, newPrompt)` produces a
  transcript-replay prompt of the form `"Previously:\n\n{prior}\n\nInstructions:\n\n{new}"`
  (`src/adapters/pi.ts`).
- The loop executor (`src/engine/loop.ts`) captures each prior iteration's
  `finalText`, resets the iteration subgraph, and feeds the transcript to the
  body node via a prompt override (`promptOverrides`) on subsequent iterations.
  The gate reviews each iteration independently.
- The retry/skip policy (`src/engine/retry.ts`) computes exponential backoff and
  retry counts; the executor assigns a **fresh** session for every retry attempt
  (no replay). On exhaustion, the node is marked `failed` and its transitive
  dependents are `skipped` (`reason: "dep-failed"`); independent branches
  continue (no fail-fast).
- Resume (`run_workflow({ resumeFrom })`, `src/engine/resume.ts`) re-runs
  failed/skipped/unfinished nodes with **fresh sessions**, while completed nodes
  are preserved so their outputs remain available to dependents via the context
  API. This is consistent with the general-retry behavior.

> **Summary table:**
>
> | Scenario | Session behavior |
> |---|---|
> | General node retry (failure) | Fresh session each retry |
> | `.loop` / `.reviewLoop` worker | Transcript-replay across iterations |
> | `run_workflow({ resumeFrom })` | Fresh sessions for re-run nodes; completed nodes preserved |

---

## Carried-forward defaults (settled in the prompt, not re-litigated)

These were sensible defaults in `IMPLEMENTATION_PROMPT.md` §22 and were not
re-asked during the decision phase:

### byModel key format — support both `provider/model` and bare `model`

The concurrency scheduler resolves the model-pool key by trying
`provider/model` first, then the bare `model` (`src/engine/scheduler.ts`,
`resolveModelKey`). This lets config authors write either:

```json
{ "limits": { "byModel": { "anthropic/claude-sonnet-4-5": 4 } } }
```

or:

```json
{ "limits": { "byModel": { "claude-sonnet-4-5": 4 } } }
```

The composite key wins when both are configured for the same provider+model.

### Workflow title/slug — derive from `wf(name)`, overridable

The run-directory slug is derived from the `wf(name)` first argument via
kebab-case. An explicit `options.title` override replaces both the stored title
and the slug (`src/dsl/builder.ts`, `WorkflowBuilderImpl` constructor). Run
directories are named `{YYYYMMDD-HHMM}-{kebab-title}`, with a `-2`, `-3`, …
suffix appended on same-minute/same-title collisions
(`src/run/layout.ts`, `createRunDir`).

---

## How these decisions fit together

The four decisions are largely independent but share a common theme: **minimize
what wisp owns and maximize reuse of the host pi ecosystem.** D1 ships one
adapter. D3 delegates auth to the harness. D4 reuses pi's transcript model
rather than its interactive resume. D2 forward-compatibly anticipates adapters
that can do more than pi. The net effect is a small, testable surface where the
pi adapter is the single execution path in v1, with clean seams for future
expansion.
