# Plan: Optional Git Worktree Integration for wisp

> **Status:** Ready for execution · **Owner:** orchestrating pi agent · **Scope:** full depth-agnostic vision
> **Estimated effort:** ~16 days (single workflow; critical path ~9 tasks deep)
> **How to execute:** ONE `run_workflow` with all tasks as nodes wired by `dependsOn` (see §3 + §7).
> wisp's scheduler runs each task the instant its dependencies complete; `resumeFrom` re-runs only
> failed/unfinished nodes. Each task is a self-contained impl→tests→verify subgraph wrapped in
> review loops.

This plan is **designed to be executed by wisp itself**. All scouting is baked in (§4) so worker
agents do not re-investigate. Tasks are sequenced by a file-ownership matrix (§6) and dependency
DAG (§7) so no two concurrent tasks edit the same file.

---

## 1. Summary

Add an **optional, nesting-doll git worktree** facility to wisp. A `WorktreeTracker` component owns
a registry of *scopes* (the workflow + any node/macro declaring `{ worktree }`). Each scope gets its
own worktree; work happens in leaf scopes; on completion a scope **merges into its parent scope's
worktree** (never `main`). Depth is unbounded — the author decides how many dolls to nest.

**Why optional:** if no scope declares `{ worktree }`, the tracker is a no-op and behavior is
byte-identical to today.

---

## 2. The locked design (all decisions confirmed)

| # | Decision | Rationale (validated) |
|---|---|---|
| D1 | **Nesting-doll + `WorktreeTracker`**, not fixed tiers | One depth-agnostic mechanism; parent chain resolved from a build-time `scopePath` stamped on every node. |
| D2 | **`scopePath`** stamped at build time | Trivial runtime parent resolution (array read); survives serialization. |
| D3 | **All-or-none rule** (compile-time validation): if a scope has a worktree, every child must be a worktree scope | Guarantees a merge-target worktree is **never an edit site** → its tree is always clean → simple queue works, no throwaway worktrees. |
| D4 | **Per-parent merge queue**: dequeued merges run directly in the (clean) parent worktree against the **current** tip; agent resolves content conflicts in-queue | Supersession is trivial (always current). Validated: concurrent merges into one worktree *fail* on `index.lock`; a conflicted worktree *blocks* — so serialization is mandatory. |
| D5 | **Never merge to `main`.** When any descendant declares a worktree, the workflow's root worktree is **auto-created** as the merge hub. | Removes the dirty-`main` failure class entirely. |
| D6 | **Hand-off, not mutate:** `run_workflow` reports final branch + base branch + run id; the orchestrating agent decides to merge or PR. | wisp stays a hand-off orchestrator. |
| D7 | **Cleanup = remove checkouts, keep branches** at run end | The branch is the durable, PR-able artifact. |
| D8 | **Location:** flat siblings in `.wisp/runs/{run-id}/worktrees/` | Validated: git allows worktrees under the project; doesn't pollute main tree (`.wisp/` gitignored); must be under `$HOME` to pass `isCwdWithinRoot`. |
| D9 | **Resume "as they lie":** persist a `worktree-registry.json` in the run dir; reconcile against `git worktree list`; recreate missing, clean orphans | Robust to crashes/manual edits. |
| D10 | **Recreation granularity = per scope restart** | A node retrying inside a running scope keeps the worktree; a failed/restarted scope (resume, or retries exhausted) is deleted + recreated fresh. Loop iterations share one worktree. |
| D11 | **Interrupted merge on resume = abort + redo** | Safe because a merge-target worktree is never an edit site (D3), so abort loses no work. |
| D12 | **One worktree per macro:** a `reviewLoop`/`council`/`reviewFix` with `{ worktree }` is a single scope; worker+gate share it and iterate inside it | Matches "a loop gets its own space." |

---

## 3. How to execute this plan with wisp

### 3.0 Prerequisites — LANDED in wisp

Two wisp bugs that this plan's single-workflow orchestration depends on have been **found,
fixed, and covered by regression tests** (see `src/__tests__/engine/loop-sequence-gating.test.ts`
and `plan-pattern-integration.test.ts`). They are committed prerequisites — the plan does NOT need
to fix them as tasks:

1. **Loop/reviewLoop now accept `dependsOn`** (gates the loop node) — this is how cross-task
   dependencies gate a `reviewLoop`. Previously a bare loop started at t=0 and ignored upstream.
2. **Loop bodies no longer leak** — the loop's body is gated on the loop via a `loop→body` dep
   edge, so it runs only via the loop handler (and skip propagates loop→body→gate).
3. **`.sequence()` now runs steps in order** (step[i]→step[i+1] dep edges); previously steps ran
   concurrently.

The plan below therefore uses gated `reviewLoop`s and ordered sequences freely. (Note: a workflow
still cannot use a wisp *feature* it produces mid-run — the engine loads once per session — but
the worktree feature built here is consumed in a *later* session, so that is not a constraint on
this build.)

### 3.1 Execution model — ONE workflow, maximal parallelism

- **A single workflow.** All 16 tasks are nodes in ONE `run_workflow({ script })`, wired with
  `dependsOn` edges equal to the dependency graph (§7). wisp's scheduler runs every node the
  instant its dependencies complete — no manual "waves," no start-gates. This is **strictly more
  parallel** than a wave decomposition: a task never waits for an unrelated sibling to finish, only
  for its actual dependencies. (E.g. task 5a needs only 2a; under waves it waited for all of wave 3;
  in this DAG it starts the moment 2a-verify completes, overlapping 3b/4a.)
- **Resume is node-granular.** If the run is interrupted (or the orchestrating session dies),
  `run_workflow({ resumeFrom })` re-runs only failed/skipped/unfinished nodes; completed nodes are
  reused. A single long-running workflow is the intended wisp use — TUI streaming keeps it
  observable, and resume covers interruptions.
- **A task = impl-reviewLoop → tests-reviewLoop → verify**, chained by `dependsOn` (§3.2).
  **Cross-task dependencies target the upstream task's `<id>-verify` node**, so a dependent task
  can't start until the upstream work is reviewed AND its scoped tests pass.
- **Scoped verifies mid-run; full checks only at the end.** Intermediate verify nodes run ONLY
  their own task's test file. Whole-project `typecheck`/`lint` would trip on a sibling task's
  half-written file under concurrency, so they are deferred to the final SERIAL gate (Task 11a)
  after all edits settle. This scoping is what makes wide parallelism safe — do not add
  typecheck/lint back to intermediate verifies.

### 3.2 The canonical task pattern (reusable template)

Every coding task is built from this shape. **Impl, tests, AND prep/cleanup each get their own
review loop** (per the plan's hard requirement). Substitute the `<...>` fields from each task spec
in §8.

```ts
import { wf } from "pi-wisp";

// One task = sequence( impl-reviewLoop → tests-reviewLoop → verify )
// The template below is for task "2a" (the tracker). Other tasks swap the fields.
export default wf("example-task-2a-tracker", { maxConcurrency: 3 })
  // ── (a) Implementation review loop ──────────────────────────────
  .reviewLoop("impl", {
    worker: {
      profileRef: "task-worker",
      prompt: `<TASK 2a implementation spec — see §8>`,
    },
    gate: {
      profileRef: "wisp-arch-reviewer",   // bespoke, see §5
      outputSchema: {
        type: "object",
        properties: { approved: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } },
        required: ["approved"],
      },
      prompt: `Review the WorktreeTracker implementation against the §8 spec and wisp invariants (§4.4). Return JSON {approved, issues}. approved=false if ANY: function-purity violated, real git/fs side effects in unit-tested paths (must be injected), parent-chain resolution wrong, registry not serializable, missing cleanup. Cite file:line for each issue.`,
    },
    maxRounds: 3,
    acceptOn: (ctx) => ctx.output("impl:gate").approved === true,
  })
  // ── (b) Tests review loop (only for code tasks) ─────────────────
  .reviewLoop("tests", {
    worker: {
      profileRef: "task-worker-tests",
      prompt: `<TASK 2a test spec — see §8; use createFakeAdapter/makeExecutorContext from §4.5>`,
    },
    gate: {
      profileRef: "task-reviewer",
      outputSchema: { type: "object", properties: { approved: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } }, required: ["approved"] },
      prompt: `Review the tests for task 2a. approved=false if ANY: no coverage for ensureActive recursion up the parent chain, no test for effectiveCwd resolution, no test for per-parent merge-queue ordering, no test for registry round-trip (serialize→load), no test for failed-scope discard, tests touch real git (must inject a vcs interface). Return JSON {approved, issues}.`,
    },
    maxRounds: 3,
    acceptOn: (ctx) => ctx.output("tests:gate").approved === true,
  })
  // ── (c) Verify: run the real checks ─────────────────────────────
  .node("verify", {
    profileRef: "task-worker-lite",
    dependsOn: ["tests"],
    outputSchema: { type: "object", properties: { passed: { type: "boolean" }, summary: { type: "string" } }, required: ["passed"] },
    prompt: `Run ONLY this task's scoped test (concurrency-safe — NEVER whole-project typecheck/lint mid-run): \`npm test -- src/__tests__/engine/worktree-tracker.test.ts\`. Fix nothing — just report. Return JSON {passed, summary}. passed=false on any non-zero exit or failed test.`,
  });
```

**Prep / cleanup tasks** (e.g. 0a profile install) use the same shape but with only an
**impl-reviewLoop + verify** (no tests): worker performs the prep, gate verifies it was done
correctly (files exist / well-formed / idempotent), verify confirms.

### 3.2.1 Authoring all 16 tasks in one script

The single workflow has ~48 nodes (16 tasks × 3). To keep the script readable, define a **build-
time** `task()` helper in the script (plain TS — it runs in the tsx compile subprocess, NOT a
serialized DSL fn, so closures are fine):

```ts
import { wf, type WorkflowBuilder } from "pi-wisp";

interface TaskOpts {
  implPrompt: string;  testPrompt?: string;  ownsFiles: string;
  implGate: string;  implGatePrompt: string;  testGatePrompt?: string;
  // acceptOn fns MUST be supplied by the caller with a LITERAL node id baked into
  // the source — they are serialized DSL fns, so they CANNOT close over `id`
  // (purity rule). The helper only passes them through; it must not build them.
  implAcceptOn: (ctx: unknown) => boolean;
  testAcceptOn?: (ctx: unknown) => boolean;
}
// Emits <id>-impl (reviewLoop) → <id>-tests (reviewLoop) → <id>-verify (node).
function task(b: WorkflowBuilder, id: string, deps: string[], o: TaskOpts): WorkflowBuilder {
  const verifyDeps = deps.map((d) => `${d}-verify`);   // cross-task deps target upstream VERIFY
  // dependsOn is on the REVIEWLOOP (gates the loop node); the worker/gate are
  // auto-gated on the loop via its loop→body dep edge — NO per-worker dependsOn.
  b = b.reviewLoop(`${id}-impl`, {
    dependsOn: verifyDeps,
    worker: { profileRef: "task-worker", prompt: o.implPrompt },
    gate: { profileRef: o.implGate, outputSchema: APPROVED_SCHEMA, prompt: o.implGatePrompt },
    maxRounds: 3,
    acceptOn: o.implAcceptOn,
  });
  if (o.testPrompt) {
    b = b.reviewLoop(`${id}-tests`, {
      dependsOn: [`${id}-impl`],
      worker: { profileRef: "task-worker-tests", prompt: o.testPrompt },
      gate: { profileRef: "task-reviewer", outputSchema: APPROVED_SCHEMA, prompt: o.testGatePrompt! },
      maxRounds: 3,
      acceptOn: o.testAcceptOn!,
    });
  }
  return b.node(`${id}-verify`, {
    profileRef: "task-worker-lite",
    dependsOn: [`${id}${o.testPrompt ? "-tests" : "-impl"}`],
    outputSchema: PASSED_SCHEMA,
    prompt: `Run ONLY this task's scoped check: \`npm test -- <its test file>\` (or, for 0b, \`npm run typecheck\`). Never whole-project typecheck/lint. Return JSON {passed, summary}.`,
  });
}

const b = wf("worktrees-feature", { maxConcurrency: 6 });
// Each task() call supplies a LITERAL acceptOn (id baked into the fn source):
//   task(b, "0b", [], { /*…*/, implAcceptOn: (ctx) => (ctx as any).output("0b-impl:gate").approved === true });
//   task(b, "1a", ["0b"], { /*…*/, implAcceptOn: (ctx) => (ctx as any).output("1a-impl:gate").approved === true });
// …one task() call per task; deps wires the single DAG…
export default b;
```
Each `task(b, "<id>", [<deps>], {...})` call contributes its 3 nodes; `deps` wires the single DAG.
`maxConcurrency` caps how many agents run at once (set to your API budget); the scheduler queues
the rest. Remember: every `acceptOn` must be a literal fn (id baked in) — never interpolated.

### 3.3 Profile resolution

- Reuse **global profiles** (`~/.pi/agent/agent-profiles/`) for workers/testers/generic reviewers.
- **Bespoke profiles** are written to `<cwd>/.pi/agent-profiles/` by **Task 0a** (project-scoped,
  available to every subsequent task). Defined in full in §5.
- The feature's own runtime **default merge-resolver profile** (`wisp-merge-resolver`) is a
  *deliverable* shipped by Task 0a (the `mergeProfile` users opt into).

### 3.4 Dependency discipline (anti-toe-stepping)

- Every task lists **Owns files** (§6). The dependency DAG (§7) guarantees that any two tasks
  sharing a file have a `dependsOn` edge between them, so wisp serializes them — concurrency never
  edits the same file. Tasks with NO edge between them own disjoint files and run fully parallel.
- The only file-sharing pairs are strictly sequenced via dep edges: `executor.ts` (5a
  type-additive → 6a logic) and `run.ts` (7a → 8a). These are the irreducible serialization points
  on the critical path.
- A task's worker may **read** any file but may **write** only its Owned files. The impl gate
  (§3.2) enforces this: `approved=false` if the diff touches files outside the task's Owned list.
- Don't fight the DAG for more parallelism: where two tasks share a file they CANNOT overlap
  without worktree isolation — which is exactly the feature being built (you can't bootstrap it on
  itself). The parallelism win comes from non-sharing tasks starting earlier, which the single DAG
  already captures.

---

## 4. Scouting (baked in — workers do NOT re-investigate)

### 4.1 Validated git mechanics (run in temp repos)

1. **Concurrent merges into one worktree FAIL** (`Unable to create '.../index.lock': File exists`,
   exit 1) — even with zero content conflict. Git errors; it does not queue. → per-parent queue is
   mandatory (D4).
2. **A conflicted worktree BLOCKS**: after a content conflict, `git merge` refuses
   *"Merging is not possible because you have unmerged files"* until resolved. → agent resolution
   must complete (or abort) before the next merge in that worktree.
3. **Worktrees under `<project>/.wisp/runs/<run>/worktrees/` work** as flat siblings: `git worktree
   add` succeeds, agent edit+commit inside behaves normally, main tree `git status` stays clean
   (`.wisp/` gitignored), `git worktree remove` cleans up.
4. **`isCwdWithinRoot`** (`src/dsl/validate.ts`) uses `dirname(homedir())` (`/home`) as root →
   worktree paths under the project pass; `/tmp`, `/etc` fail. Runtime-injected worktree paths are
   NOT in the IR, so IR-level validation won't see them, but the fanOut guard
   (`src/engine/fanout.ts`) WILL → it needs an allowlist carve-out (Task 3b).

### 4.2 Codebase map (key files + current signatures)

| Concern | File | Notes |
|---|---|---|
| Core types | `src/types.ts` | `NodeSpec`, `IRNodeBase` (has `cwd?`), `GraphIR`, `RunSummary` (in `engine/events.ts`), `NodeRuntime`. **Add:** `WorktreeConfig`, `scopePath` on `IRNodeBase`, `WorktreeLocation` on `RunSummary`. |
| DSL builder | `src/dsl/builder.ts` | `WorkflowBuilderImpl` holds `state: BuilderIR`; methods return `this`. **Add:** a `scopeStack` + `worktree` on `WfOptions`/`NodeSpec`; stamp `scopePath` on every added node. |
| Macros | `src/dsl/macros.ts` | `materializeNode`, `expandReviewLoop/Council/ReviewFix` produce `MacroExpansion`. **Add:** push/pop the macro's scope around expansion so its nodes inherit the chain. |
| Builder IR | `src/dsl/ir.ts` | `BuilderNode`, `BuilderIR`, `live()`. Carries live fns. |
| Serialization | `src/dsl/serialize.ts` | `pickBaseFields`, `serializeNode` map BuilderNode→IRNode. **Add:** carry `scopePath` + `worktree`. |
| Validation | `src/dsl/validate.ts` | `validateIR`, `isCwdWithinRoot`. **Add:** all-or-none rule (D3) + worktree-roots allowlist for `isCwdWithinRoot`. |
| Executor context | `src/engine/executor-types.ts` | `ExecutorContext` bundle. **Add:** `worktreeTracker?: WorktreeTracker`. |
| Executor options | `src/engine/executor.ts` | `ExecuteDAGOptions` (defined here). **Add:** `worktreeTracker?`. (Co-owned 5a→6a, sequenced.) |
| Executor loop | `src/engine/executor.ts` | `markReadyNodes`, `scheduleReadyNode`, `schedulePlainNode`. **Add:** `ensureActive(scope)` on ready; enqueue-merge on scope sink complete. |
| Per-node run | `src/engine/run-node.ts` | `invokeAdapter({ ..., cwd: node.cwd })` at ~L391. **Change:** `cwd: effectiveCwd(node)`. |
| Loop/cond | `src/engine/loop.ts` | `materializeCondBranch` copies `spec.cwd`; `executeLoop` resets/re-runs body via `runNodeWrapper`. Body scope is static → worktree persists across iterations automatically once `runNode` resolves effective cwd. |
| Reduce/synthesis | `src/engine/reduce-node.ts` → `src/engine/synthesize.ts` | **`synthesize.ts` has NO cwd today** (gap). **Add:** thread effective cwd so a reduce node in a worktree scope runs there. |
| Pi adapter | `src/adapters/pi.ts` | `buildInvocation` uses `ctx.cwd` for skill-path containment only. Likely **no change** (worktree path is valid for containment) — verify in 5a. |
| Run lifecycle | `src/engine/run.ts` | `runWorkflow()`: `resolveIR` → `setupRunEnv` → `executeDAG` → finalize. **Add:** instantiate tracker, auto-root, hand-off, cleanup in `finally`. |
| Run summary | `src/engine/events.ts` | `RunSummary`, `summarizeNode`, `computeTotals`. **Add:** `workLocations: WorktreeLocation[]`. |
| Tool entry | `src/tools/run-workflow.ts` | Builds result `details`. **Add:** surface `workLocations`. `ctx.cwd` = project root = git base. |
| Resume | `src/engine/resume.ts` | `prepareResume(runDir)`. **Add:** reconstruct tracker from registry + `git worktree list`; failed-scope recreate; abort+redo stuck merge. |
| Persistence | `src/run/store.ts` | `serializeRunState`, `RUN_ENTRY_KEY`. Registry kept as a **separate `worktree-registry.json`** in runDir (not in the append-entry stream). |
| Run layout | `src/run/layout.ts` | `createRunDir`. **Add:** `RUN_WORKTREES_DIR` constant + ensure `worktrees/` subdir. |
| Audit | `src/run/audit.ts` | `AuditLogger` (fd-based, append). **Add:** `worktreeCreate/Merge/Conflict/Cleanup/Discard` methods + event lines. |
| TUI | `src/tui/widget.ts`, `format.ts` | **Add:** active-scope row. |
| Constants | `src/constants.ts` | `WISP_CONFIG_DIR="..wisp"`, runsDir = `join(cwd, ".wisp", "runs")`. **Add:** `RUN_WORKTREES_DIR = "worktrees"`. |
| Utils | `src/utils.ts` | `kebabCase`, `timecode` (reuse for branch names). |

### 4.3 The five effective-cwd sites (Task 5a)

1. `run-node.ts` invokeAdapter `cwd` (primary).
2. `synthesize.ts` synthesis invocation (currently none — add).
3. `executor-types.ts` `ExecutorContext.worktreeTracker` (plumb).
4. `executor.ts` `ExecuteDAGOptions.worktreeTracker` + wiring into `ExecutorContext`.
5. `pi.ts` `buildInvocation` — verify only (likely no change).
(`loop.ts` needs no change: body nodes resolve effective cwd via `runNode`.)

### 4.4 wisp invariants every impl gate must enforce

- **Function purity:** DSL fns (`iterate`, `each`, `when`, …) serialized via `toString()` and
  rehydrated in a restricted context — must not close over outer vars or use Node globals.
- **D3:** never forward credentials; spawned agents inherit host env.
- **D4:** fresh session per retry; loops use transcript-replay.
- **Adapter-agnostic:** engine dispatch via `invokeAdapter` (duck-typed `emitEvents` for fakes).
- **No fail-fast:** a failed node propagates skip to dependents; independent branches continue.
- **Resume safety:** completed nodes reused; failed/skipped reset to pending with fresh session.
- **New (this feature):** all-or-none (D3 above), never merge to main (D5), merge-target worktrees
  are never edit sites (D3 consequence).

### 4.5 Test harness (reuse, don't reinvent)

- `createFakeAdapter(opts)` (`__tests__/helpers/fake-adapter.ts`) — scripted in-process adapter;
  duck-typed `emitEvents`; per-attempt factories, `fileEdits`, `sessionId`, modes.
- `makeExecutorContext({ ir, runState, getAdapter, ... })` (`__tests__/helpers/executor-context.ts`)
  — builds a real `ExecutorContext`; **must be updated in 5a** to seed `worktreeTracker`.
- `makeFakeAudit()` — spy `AuditLogger`.
- `createMockProcess()` — for spawner tests.
- **Real git in tests** is OK for `vcs/worktree.test.ts` and the e2e test — spin up temp repos under
  `os.tmpdir()` and clean up in `afterEach`. Engine/tracker/merge tests MUST inject a `vcs` interface
  (no real git) so they're hermetic and fast.
- Commands: `npm test` (vitest run), `npm run typecheck` (tsc --noEmit), `npm run lint` (eslint).

### 4.6 Available profiles (global, reuse)

`task-worker` · `task-worker-tests` · `task-worker-lite` · `task-reviewer` ·
`code-quality-reviewer` · `bug-scout` · `doc-writer` · `doc-reviewer` · `plan-reviewer`

---

## 5. Bespoke profiles (installed by Task 0a → `<cwd>/.pi/agent-profiles/`)

### 5.1 `wisp-arch-reviewer` — impl gate for engine/DSL core tasks

```markdown
---
name: wisp-arch-reviewer
agentType: pi
provider: anthropic
model: claude-sonnet-4-5
thinkingLevel: high
tools: read,bash,grep
---
You are a meticulous architecture reviewer for the **pi-wisp** codebase. You review diffs against
a fixed set of invariants and reject anything that violates them.

Hard invariants (reject if violated):
- **Function purity:** any DSL fn (`iterate`/`each`/`when`/`until`/`acceptOn`/`merge`) must not
  close over outer-scope variables or use Node globals (`require`, `process`, `fs`, `fetch`, …).
- **D3 credentials:** never emit `--api-key` or set `PI_API_KEY`.
- **D4 sessions:** retries use fresh sessions; loops use transcript-replay (never pi `--resume`).
- **Adapter-agnostic:** engine code dispatches only via `invokeAdapter`; never imports a concrete
  adapter. Fake adapters are detected by duck-typing `emitEvents`.
- **No fail-fast:** a node failure propagates skip to transitive dependents via dep+fanOut+cond
  edges; independent branches must keep running.
- **Resume safety:** completed nodes are reused on resume; failed/skipped reset to pending.
- **Worktree feature rules:** all-or-none (a worktree scope's children must all be worktree scopes);
  wisp NEVER merges to `main`; a merge-target worktree is never an edit site; merges serialize
  per-parent through one index; cleanup removes checkouts but keeps branches.

Procedure: read the diff with `git diff`, read the surrounding code for context, and check every
invariant. Verify the diff touches ONLY the task's Owned files. Return ONLY JSON:
`{"approved": boolean, "issues": ["file:line — explanation", ...]}`. `approved` is false if there
is ANY invariant violation, ANY out-of-scope file edit, or ANY correctness defect. Do not fix
anything.
```

### 5.2 `wisp-merge-resolver` — the feature's default runtime merge-conflict resolver (deliverable)

This is the profile users reference as `mergeProfile` (or the built-in default). It is a *product*
of this feature, installed alongside the code.

```markdown
---
name: wisp-merge-resolver
agentType: pi
provider: anthropic
model: claude-sonnet-4-5
thinkingLevel: high
tools: read,edit,bash,grep
---
You resolve git merge conflicts inside a wisp worktree. You are run with `cwd` set to the parent
worktree, which is mid-merge (conflict markers present).

Procedure:
1. Run `git status` and `git diff --diff-filter=U` to enumerate conflicted files.
2. For each conflict, read both sides (`git log -p`, the conflict markers) and the surrounding
   context. Determine the intent of EACH change.
3. Resolve by preserving the intent of both sides where they are independent. When one change
   genuinely supersedes or makes another obsolete, keep the supersedING change and drop the
   superseded one — explain why in the resolved file's commit or a brief note.
4. Never delete work silently. If two changes are irreconcilable, prefer the child scope's change
   (it is the newer work being merged in) unless the parent change is clearly a correction.
5. Remove all conflict markers, `git add` each resolved file, then `git commit` with a clear
   message summarizing the resolution. Do NOT push. Do NOT touch unrelated files.
6. If resolution is impossible (e.g. you cannot determine intent), leave the merge unresolved and
   exit non-zero with an explanation — wisp will treat the scope as failed.

You may run git read commands and edit files. You must finish the commit or exit non-zero.
```

> **Note:** Task 0a writes BOTH profiles. `wisp-arch-reviewer` is used by impl gates during the
> build; `wisp-merge-resolver` is the shipped default the feature invokes at runtime.

---

## 6. File-ownership matrix (concurrent tasks never share a file)

| Task | Owns files | Co-owned (sequenced) |
|---|---|---|
| 0a | `.pi/agent-profiles/wisp-arch-reviewer.md`, `.pi/agent-profiles/wisp-merge-resolver.md` | — |
| 0b | `src/types.ts` | — (root dependency) |
| 1a | `src/vcs/worktree.ts`, `src/__tests__/vcs/worktree.test.ts` | — |
| 2a | `src/engine/worktree-tracker.ts`, `src/__tests__/engine/worktree-tracker.test.ts` | — |
| 3a | `src/dsl/builder.ts`, `src/dsl/macros.ts`, `src/dsl/ir.ts`, `src/dsl/serialize.ts` | — |
| 3b | `src/dsl/validate.ts` | after 3a |
| 4a | `src/engine/merge.ts`, `src/__tests__/engine/merge.test.ts` | — |
| 5a | `src/engine/run-node.ts`, `src/engine/synthesize.ts`, `src/engine/executor-types.ts`, `src/engine/executor.ts` *(type-additive only)*, `src/__tests__/helpers/executor-context.ts` | `executor.ts` → then 6a |
| 6a | `src/engine/executor.ts` *(runtime logic)* | after 5a |
| 7a | `src/engine/run.ts`, `src/engine/events.ts`, `src/tools/run-workflow.ts`, `src/constants.ts` | `run.ts` → then 8a |
| 8a | `src/engine/resume.ts`, `src/run/store.ts`, `src/run/layout.ts` | after 7a |
| 9a | `src/run/audit.ts` | — |
| 9b | `src/tui/widget.ts`, `src/tui/format.ts` | after 6a |
| 10a | `src/__tests__/e2e/worktrees.test.ts` | — |
| 10b | `skills/wisp-authoring/SKILL.md`, `docs/dsl.md`, `docs/architecture.md`, `docs/design.md` | — |
| 11a | *(verification only — no edits outside fixes the gate approves)* | — |

---

## 7. Dependency DAG (single workflow)

One workflow; `dependsOn` = this graph. Cross-task edges target the upstream task's `<id>-verify`
node (reviewed + scoped-tests-green). wisp runs each task the instant its deps complete.

| Task | Depends on | Owns (shared file noted) | Notes |
|------|------------|--------------------------|-------|
| **0a** | — | `.pi/agent-profiles/*` | installs `wisp-arch-reviewer` + `wisp-merge-resolver`; root, parallel with 0b |
| **0b** | — | `src/types.ts` | types foundation; root, parallel with 0a (gate: `code-quality-reviewer`, no dep on 0a) |
| **1a** | 0b | `src/vcs/*` | git facade; real-git tests |
| **3a** | 0b | `src/dsl/{builder,macros,ir,serialize}.ts` | scopePath stamping |
| **9a** | 0b | `src/run/audit.ts` | audit methods — MUST ship before 2a/4a/6a |
| **2a** | 0b, 1a, 9a | `src/engine/worktree-tracker.ts` | the nesting-doll component |
| **3b** | 3a | `src/dsl/validate.ts` | all-or-none rule |
| **4a** | 0b, 1a, 9a | `src/engine/merge.ts` | merge engine (parallel with 2a — disjoint files) |
| **5a** | 2a | `run-node.ts`, `synthesize.ts`, `executor-types.ts`, `executor.ts` *(types)* | effective-cwd plumbing |
| **6a** | 5a, 4a, 9a | `src/engine/executor.ts` *(logic)* | executor lifecycle — hardest task; shares `executor.ts` with 5a (sequenced) |
| **7a** | 6a, 2a | `run.ts`, `events.ts`, `tools/run-workflow.ts`, `constants.ts` | run/handoff/cleanup; shares `run.ts` lineage with 8a |
| **9b** | 6a, 9a | `src/tui/widget.ts`, `format.ts` | TUI (parallel with 7a/8a) |
| **8a** | 7a, 2a | `resume.ts`, `store.ts`, `layout.ts` | resume (logical dep on 7a, not a file conflict) |
| **10b** | 6a, 7a | `skills/`, `docs/` | docs (parallel with 8a/10a) |
| **10a** | 6a, 7a, 8a | `src/__tests__/e2e/worktrees.test.ts` | end-to-end integration test |
| **11a** | 10a, 10b | *(verification only)* | FINAL SERIAL GATE: full `typecheck` + `lint` + `test` |

**Critical path** (sets wall-clock): `0b → 1a → 2a → 5a → 6a → 7a → 8a → 10a → 11a` (9 tasks deep).
Everything off this path (0a, 3a, 3b, 4a, 9a, 9b, 10b) overlaps it fully instead of idling at wave
boundaries — the single-DAG win.

**Irreducible serialization (shared files — do NOT try to parallelize):** `executor.ts` (5a→6a),
`run.ts` lineage (7a→8a). These ARE the edges above.

---

## 8. Phases & task specs

> Each task below is realized via the §3.2 template / §3.2.1 helper. Only the per-task fields are given.
> **Gate prompts** always end with the standard JSON schema `{approved:boolean, issues:string[]}`
> and the instruction to reject out-of-scope file edits.
>
> **Execution is the SINGLE DAG in §7** — the "Phase N" headers below are logical groupings only,
> NOT execution batches. Cross-task `dependsOn` targets the upstream task's `<id>-verify` node.
> **Intermediate verifies run scoped tests only** (concurrency-safe); whole-project typecheck/lint
> runs once at the final serial gate (11a).

### Phase 0 — Foundation

#### Task 0a — Install bespoke profiles *(prep; impl-reviewLoop + verify; no tests)*
- **Depends on: — · Owns:** `.pi/agent-profiles/wisp-arch-reviewer.md`, `wisp-merge-resolver.md`
- **Worker:** `task-worker` · **Gate:** `plan-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:** Write the two profile files exactly as specified in §5.1 and §5.2 (frontmatter +
  body) into `<cwd>/.pi/agent-profiles/`. Create the directory if absent. Do not modify any other
  profile.
- **Gate spec:** Confirm both files exist, parse as valid YAML frontmatter + markdown, have the
  exact `name`/`agentType`/`tools` fields specified, and the bodies match §5. Reject if either is
  missing a hard invariant from §4.4.
- **Verify spec:** `ls .pi/agent-profiles/wisp-*.md` succeeds; run `list_profiles` and confirm both
  resolve. Return `{passed, summary}`.

#### Task 0b — Types foundation *(code; full template)*
- **Depends on: — · Owns:** `src/types.ts`
- **Worker:** `task-worker` · **Test writer:** `task-worker-tests` · **Impl gate:** `code-quality-reviewer` (deliberately NOT `wisp-arch-reviewer`, so 0b has no dep on 0a and runs parallel with it)
  · **Test gate:** `task-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:** Add to `src/types.ts`:
  - `WorktreeConfig { name?: string; mergeProfile?: string; base?: string }` (kebab `name` for
    branch + display; `mergeProfile` defaults to `wisp-merge-resolver`; `base` usually unset =
    auto-detect current branch).
  - `scopePath?: string[]` on `IRNodeBase` (chain of enclosing scope ids, outer→inner).
  - `worktree?: WorktreeConfig` on `NodeSpec` and on `WfOptions` (the latter becomes
    `GraphIR.options.worktree`).
  - `WorktreeScopeState` type for the runtime registry entry (`{scopeId, branch, worktreePath,
    parentScopeId|null, state}`).
  - `WorktreeLocation { branch: string; base: string; scopeId: string }` and add
    `workLocations?: WorktreeLocation[]` to `RunSummary` (in `engine/events.ts` is fine, but the
    *type* is defined here; events.ts import is updated in 7a).
  - Keep everything optional and additive — no existing type narrows.
- **Test spec:** Type-level tests via `tsc --noEmit` (the type additions compile against existing
  usage). Add a small `__tests__/types.test.ts` (or extend `utils.test.ts`) constructing sample
  `WorktreeConfig`/`WorktreeLocation` objects to lock the shapes.
- **Verify:** `npm run typecheck` clean.

### Phase 1 — Git module

#### Task 1a — `vcs/worktree.ts` *(code; full template)*
- **Depends on: 0b · Owns:** `src/vcs/worktree.ts`, `src/__tests__/vcs/worktree.test.ts`
- **Worker:** `task-worker` · **Test writer:** `task-worker-tests` · **Impl gate:** `wisp-arch-reviewer`
  · **Test gate:** `task-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:** A pure-ish git facade over `child_process` (mirror existing `spawn` usage; no new
  deps). Export a `Vcs` *interface* so the tracker/merge can inject a fake:
  ```ts
  interface Vcs {
    currentBranch(repoPath: string): Promise<string>;                 // git rev-parse --abbrev-ref HEAD
    createWorktree(repoPath, worktreePath, branchName, baseRev): Promise<void>;   // git worktree add -b <branch> <path> <base>
    listWorktrees(repoPath): Promise<{path:string; branch:string}[]>;  // git worktree list --porcelain
    removeWorktree(repoPath, worktreePath, opts:{force?:boolean}): Promise<void>;  // keep branch
    attemptMerge(parentWorktreePath, childBranch): Promise<{conflicts:string[]; clean:boolean}>;
    abortMerge(worktreePath): Promise<void>;                           // git merge --abort
    commitMerge(worktreePath, message): Promise<void>;                 // git commit after manual resolution
    branchExists(repoPath, branch): Promise<boolean>;
    deleteBranch(repoPath, branch): Promise<void>;
  }
  ```
  Implement via `simpleGit`-free raw `git` args (validated for shell-safety like `to-args.ts`:
  refuse null bytes; `shell:false`). `attemptMerge` runs `git -C <parent> merge --no-edit <child>`,
  parses `git diff --diff-filter=U` for conflicts; never throws on conflict (returns `{conflicts,
  clean:false}`); throws only on infra errors.
- **Test spec:** Real git in `os.tmpdir()` temp repos (clean in `afterEach`). Cover: create→list→
  remove (branch retained); clean fast-forward merge; conflicting merge returns conflicts + leaves
  MERGE state; `abortMerge` clears it; `commitMerge` finalizes. Parameterize branch-name uniqueness.
- **Verify:** `npm test -- src/__tests__/vcs/worktree.test.ts && npm run typecheck && npm run lint -- src/vcs`.

### Phase 2 — WorktreeTracker

#### Task 2a — `engine/worktree-tracker.ts` *(code; full template)*
- **Depends on: 0b, 1a, 9a · Owns:** `src/engine/worktree-tracker.ts`, `src/__tests__/engine/worktree-tracker.test.ts`
- **Worker:** `task-worker` · **Test writer:** `task-worker-tests` · **Impl gate:** `wisp-arch-reviewer`
  · **Test gate:** `task-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:** The nesting-doll component. Holds `Map<scopeId, ScopeEntry>`; takes an injected
  `Vcs` (hermetic tests). API:
  ```ts
  class WorktreeTracker {
    constructor(opts: { vcs: Vcs; repoRoot: string; worktreesDir: string; audit?: AuditLogger });
    effectiveCwd(node: { scopePath?: string[] }): string | undefined;   // deepest ACTIVE scope's path, else undefined
    ensureActive(scopeId: string, scopePath: string[]): Promise<ScopeEntry>; // lazy; recurses to parent first; idempotent
    enqueueMerge(scopeId: string, mergeProfile: string, getAdapter, signal): Promise<MergeResult>; // per-parent queue (D4); delegates to merge.ts (Task 4a) — inject a Merger interface to avoid an import cycle, OR accept merge.ts added in 4a and depend on it
    discard(scopeId: string): Promise<void>;                            // failed scope: delete branch+worktree
    serialize(): WorktreeRegistry;  load(reg: WorktreeRegistry): void;  // worktree-registry.json round-trip (D9)
    finalize(): Promise<WorktreeLocation[]>;                            // remove checkouts, keep branches (D7)
  }
  ```
  Parent chain from `scopePath`: the parent of scopeId S is the scopePath entry immediately
  enclosing S. `ensureActive` recurses: if parent not active, `ensureActive(parent)` first, then
  branch the child off the parent's current tip. Emit `audit.worktreeCreate`. Per-parent queue: a
  `Map<parentScopeId, Promise<void>>` serializes merges into a given parent (D4). **Must not touch
  real git in unit tests** — inject `Vcs`.
- **Merge coupling:** To avoid an import cycle / premature dep, the tracker calls a `Merger`
  interface (`enqueueMerge`'s real work). Task 4a provides the concrete `Merger` (which uses `Vcs` +
  an agent). The tracker is built against the interface; 4a wires the concrete one.
- **Test spec:** Inject a fake `Vcs` + fake `Merger`. Cover: `effectiveCwd` returns deepest active
  scope, undefined when none; `ensureActive` recurses up (parent created before child); idempotent
  re-ensure; per-parent queue serializes two concurrent `enqueueMerge` calls into the same parent
  (assert ordering + no overlap via fake timestamps); `discard` removes entry + calls vcs.delete;
  `serialize`/`load` round-trip preserves parent chain + state; `finalize` calls removeWorktree for
  each, never deleteBranch, returns locations.
- **Verify:** `npm test -- src/__tests__/engine/worktree-tracker.test.ts && typecheck && lint`.

### Phase 3 — DSL plumbing + validation

#### Task 3a — Builder/macros scope stamping *(code; full template)*
- **Depends on: 0b · Owns:** `src/dsl/builder.ts`, `src/dsl/macros.ts`, `src/dsl/ir.ts`, `src/dsl/serialize.ts`
- **Worker:** `task-worker` · **Test writer:** `task-worker-tests` · **Impl gate:** `wisp-arch-reviewer`
  · **Test gate:** `task-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:**
  - `builder.ts`: add `private scopeStack: string[] = []`. `wf(name,{worktree})` pushes a root
    scope id (`wf:<slug>`) when `worktree` set. `.node(id,{worktree})` pushes `<id>` as a scope,
    adds the node (stamping `scopePath: [...scopeStack]`), pops. Each node added gets the current
    `scopePath`. `WfOptions.worktree` and `NodeSpec.worktree` carry the config.
  - `macros.ts`: each expander pushes its scope id (`<macroId>`) onto the stack while
    `materializeNode`-ing its children (so worker/gate/members inherit the macro's scopePath), then
    pops. A macro with `worktree` becomes a scope; its internal atoms are NOT separate scopes
    (D12).
  - `ir.ts`/`serialize.ts`: carry `scopePath` + `worktree` through `BuilderNode`→`IRNode`.
  - All additive; existing workflows unchanged when no `worktree` is set (scopePath is still
    computed but harmless; or only computed when any worktree exists — prefer always-compute for
    simplicity, it's cheap).
- **Test spec:** Build workflows with nested worktrees (wf→reviewLoop→ inner node) and assert each
  node's `scopePath` chain is correct; assert a macro's worker/gate share the macro's scope; assert
  `toIR()` round-trips `scopePath` + `worktree`; assert a no-worktree workflow still compiles and
  its graph is structurally identical to today (golden-ish check).
- **Verify:** `npm test -- src/__tests__/dsl && typecheck && lint`.

#### Task 3b — All-or-none validation *(code; full template)*
- **Depends on: 3a · Owns:** `src/dsl/validate.ts`
- **Worker:** `task-worker` · **Test writer:** `task-worker-tests` · **Impl gate:** `wisp-arch-reviewer`
  · **Test gate:** `task-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:** In `validateIR`, add `checkWorktreeScopes(ir)`:
  - **All-or-none (D3):** for each scope S that declares a worktree, every child scope of S must
    also declare a worktree. (Children = scopes whose `scopePath` is `S.scopePath + [childId]`.)
    A bare non-worktree node nested under a worktree scope → validation error. Sibling consistency
    is implied (if any sibling scope has a worktree and the parent has one, all must).
  - **`isCwdWithinRoot` carve-out:** accept an optional allowlist of runtime worktree roots so the
    fanOut guard (`fanout.ts` — read-only here) doesn't reject worktree cwds. (The fanout guard call
    site is updated in 5a/6a; here just make `isCwdWithinRoot` accept an allowlist param.)
  - Emit structured `{kind:"validation", nodeId, message}` errors.
- **Test spec:** Positive: a clean wf→tasks(worktree) graph validates. Negative: a worktree parent
  with a bare child node → error; a worktree sibling next to a non-worktree sibling under a
  worktree parent → error. `isCwdWithinRoot` with allowlist accepts a listed root.
- **Verify:** `npm test -- src/__tests__/dsl && typecheck && lint`.

### Phase 4 — Merge engine

#### Task 4a — `engine/merge.ts` *(code; full template)*
- **Depends on: 0b, 1a, 9a · Owns:** `src/engine/merge.ts`, `src/__tests__/engine/merge.test.ts`
- **Worker:** `task-worker` · **Test writer:** `task-worker-tests` · **Impl gate:** `wisp-arch-reviewer`
  · **Test gate:** `task-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:** The concrete `Merger` (the `enqueueMerge` body the tracker delegates to). Exports
  `createMerger({ vcs, getAdapter })` returning an object with `merge(opts)` where
  `opts = { parentWorktreePath, childBranch, mergeProfile, signal, audit }`:
  1. `vcs.attemptMerge(parentWorktreePath, childBranch)`.
  2. If `clean` → done (emit `audit.worktreeMerge`).
  3. If conflicts → spawn the `mergeProfile` agent via `invokeAdapter` with
     `cwd = parentWorktreePath` and a prompt listing conflicted files (the `wisp-merge-resolver`
     profile runs `git status`/`git diff` itself). Stream events; on success the agent has committed
     → emit `audit.worktreeConflict`→`worktreeMerge`. On agent failure or remaining conflicts →
     `vcs.abortMerge`, emit `worktreeDiscard`, return failure (caller fails the scope).
  - Resolve the profile via `resolveProfileSync(mergeProfile ?? "wisp-merge-resolver", ...)`.
  - Never merge to `main` (D5) — this fn only ever targets a parent *worktree*.
  - **Abort+redo (D11):** expose `abortInProgress(parentWorktreePath)` used by resume (8a).
- **Test spec:** Inject fake `Vcs` + fake adapter (`createFakeAdapter`). Clean merge → no agent
  spawned, success. Conflicting merge → agent spawned with correct cwd; scripted agent "commits"
  (fake vcs.commitMerge) → success. Agent fails → abortMerge called, failure returned. Verify
  `main` is never a target (assert parentWorktreePath is always a worktrees/ path in tests).
- **Verify:** `npm test -- src/__tests__/engine/merge.test.ts && typecheck && lint`.

### Phase 5 — effective-cwd wiring

#### Task 5a — Thread effective cwd + plumb tracker *(code; full template)*
- **Depends on: 2a · Owns:** `src/engine/run-node.ts`, `src/engine/synthesize.ts`, `src/engine/executor-types.ts`, `src/engine/executor.ts` *(type-additive only: add `worktreeTracker?` to `ExecuteDAGOptions` + seed it onto `ExecutorContext`)*, `src/__tests__/helpers/executor-context.ts`
- **Worker:** `task-worker` · **Test writer:** `task-worker-tests` · **Impl gate:** `wisp-arch-reviewer`
  · **Test gate:** `task-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:**
  - `executor-types.ts`: add `worktreeTracker?: WorktreeTracker` to `ExecutorContext`.
  - `executor.ts`: add `worktreeTracker?` to `ExecuteDAGOptions`; seed `ctx.worktreeTracker` from
    it. **No runtime logic here** (that's 6a) — additive, optional, behavior unchanged when absent.
  - `run-node.ts`: `const cwd = ctx.worktreeTracker?.effectiveCwd(node) ?? node.cwd;` pass to
    `invokeAdapter`.
  - `synthesize.ts`: add `cwd` resolution (from the reduce node's scopePath via the tracker) and
    pass into the synthesis adapter invocation (currently absent — §4.3 gap).
  - `__tests__/helpers/executor-context.ts`: accept + seed `worktreeTracker` in `makeExecutorContext`.
  - `adapters/pi.ts`: verify `buildInvocation` works unchanged with a worktree cwd (read-only
    check; only edit if containment breaks — unlikely).
  - Behavior must be identical to today when `worktreeTracker` is undefined.
- **Test spec:** With a tracker whose `effectiveCwd` returns a path, assert `runNode` passes that
  cwd to the adapter (use `FakeAgentAdapter.invocations` to capture `ctx.cwd`); with no tracker,
  `node.cwd` is used (today's behavior). Synthesis path likewise. `makeExecutorContext` round-trips
  the tracker.
- **Verify:** `npm test && typecheck && lint` (full suite — 5a touches core paths).

### Phase 6 — Executor scope lifecycle (hardest)

#### Task 6a — ensureActive + enqueue-merge *(code; full template)*
- **Depends on: 5a, 2a, 4a, 9a · Owns:** `src/engine/executor.ts` *(runtime logic)*
- **Worker:** `task-worker` · **Test writer:** `task-worker-tests` · **Impl gate:** `wisp-arch-reviewer`
  · **Test gate:** `task-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:** In `executor.ts`:
  - **On node ready (in `scheduleReadyNode`/`markReadyNodes`, before launching):** if the node's
    innermost scope has a worktree, `await tracker.ensureActive(scopeId, scopePath)` (idempotent;
    recurses to parent). This is async — gate it so a node waits for its worktree before `running`.
  - **On scope sink completion:** compute each scope's terminal sink (a node with no successor
    *within the same scope* — reuse `buildSuccessorsMap` but filtered to intra-scope edges). When a
    scope's sink completes successfully, `tracker.enqueueMerge(scopeId, mergeProfile, getAdapter,
    signal)`; on merge failure → `failNode` the scope's sink (propagates skip per no-fail-fast). On
    success the scope is retired. A node's `effectiveCwd` (5a) already points into the worktree.
  - Keep no-worktree runs byte-identical (guard everything on `ctx.worktreeTracker` presence AND the
    node having a worktree scope).
  - Emit audit events via the tracker (which holds the audit ref).
- **Test spec:** Use `makeExecutorContext` + a real `WorktreeTracker` with fake `Vcs`/`Merger`.
  Cover: (1) a wf(worktree)→2 task(worktree) graph: each task gets a worktree created before its
  node runs (assert `ensureActive` called, agent cwd = worktree path); tasks merge into the wf
  worktree in completion order; wf worktree is the only thing reported (never main). (2) A
  reviewLoop(worktree): one worktree shared across iterations, merged once after the loop. (3) A
  failed task: its worktree discarded, dependents skipped, sibling task unaffected. (4) No-worktree
  graph: tracker untouched, behavior identical.
- **Verify:** `npm test && typecheck && lint`.

### Phase 7 — Run lifecycle, hand-off, cleanup

#### Task 7a — Auto-root, hand-off, cleanup *(code; full template)*
- **Depends on: 6a, 2a · Owns:** `src/engine/run.ts`, `src/engine/events.ts`, `src/tools/run-workflow.ts`, `src/constants.ts`
- **Worker:** `task-worker` · **Test writer:** `task-worker-tests` · **Impl gate:** `wisp-arch-reviewer`
  · **Test gate:** `task-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:**
  - `constants.ts`: add `RUN_WORKTREES_DIR = "worktrees"`.
  - `run.ts`: detect if any node has a worktree scope; if so, instantiate `WorktreeTracker` (with a
    real `Vcs`, `repoRoot = ctx.cwd`, `worktreesDir = join(runDir, RUN_WORKTREES_DIR)`) and
    **auto-create the root workflow worktree** (D5). Pass the tracker via `executeDAG` options.
    After `executeDAG` (success or failure), in a `finally`: `tracker.finalize()` →
    `WorktreeLocation[]` (removes checkouts, keeps branches, D7). Capture base branch via
    `vcs.currentBranch(repoRoot)` at start.
  - `events.ts`: add `workLocations?: WorktreeLocation[]` to `RunSummary`; populate from finalize.
  - `tools/run-workflow.ts`: surface `workLocations` in the tool result `details` and a one-line
    summary in the returned text ("Work complete on branch(es) X (base: Y). Merge or open a PR.").
  - Never merge to main; never delete branches on cleanup.
- **Test spec:** A worktree run reports `workLocations` with correct branch/base; checkouts removed
  (assert `git worktree list` empty post-run) but branches exist (`git branch --list`); a
  no-worktree run reports empty `workLocations` and is otherwise unchanged. Cleanup runs even on
  failure.
- **Verify:** `npm test && typecheck && lint`.

### Phase 8 — Resume

#### Task 8a — Reconstruct + reconcile + recreate *(code; full template)*
- **Depends on: 7a, 2a · Owns:** `src/engine/resume.ts`, `src/run/store.ts`, `src/run/layout.ts`
- **Worker:** `task-worker` · **Test writer:** `task-worker-tests` · **Impl gate:** `wisp-arch-reviewer`
  · **Test gate:** `task-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:**
  - Persist `worktree-registry.json` in the run dir (written by the tracker during the run; layout
    in `run/layout.ts` helper). 
  - `resume.ts prepareResume(runDir)`: after loading graph/runState, if `worktree-registry.json`
    exists, reconstruct the `WorktreeTracker` via `tracker.load(registry)` then reconcile against
    `vcs.listWorktrees(repoRoot)` (D9): recreate missing worktrees for scopes that will re-run,
    clean orphan worktrees not in the registry. For each failed/skipped scope being re-run (D10),
    `tracker.discard(scopeId)` then it recreates fresh on `ensureActive`. For a parent left
    mid-merge (D11), `merger.abortInProgress(parentPath)` then the merge re-runs.
  - Reconstructed tracker passed into the resumed `executeDAG`.
- **Test spec:** Seed a run dir with a registry + real git worktrees (temp repo). (1) Clean resume:
    completed scopes' worktrees reused, outputs reused. (2) A scope missing its worktree on disk →
    recreated. (3) An orphan worktree not in registry → removed. (4) A failed scope → discarded +
    recreated fresh (fresh branch off parent tip). (5) A parent mid-merge → aborted, merge redone.
- **Verify:** `npm test -- src/__tests__/engine/resume*.test.ts && typecheck && lint`.

### Phase 9 — Audit + TUI

#### Task 9a — Audit events *(code; full template)* — ships early (root-parallel, only a 0b dep)
- **Depends on: 0b · Owns:** `src/run/audit.ts`
- **Worker:** `task-worker` · **Test writer:** `task-worker-tests` · **Impl gate:** `wisp-arch-reviewer`
  · **Test gate:** `task-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:** Add to `AuditLogger`: `worktreeCreate(scopeId, branch, path)`,
  `worktreeMerge(scopeId, parentScopeId)`, `worktreeConflict(scopeId, files[])`,
  `worktreeCleanup(scopeId)`, `worktreeDiscard(scopeId, reason)`. Each writes one `audit.jsonl`
  line (`type:"worktree.<x>", ...`) via the existing fd. Document the new event types in the module
  header table. **Must complete before 2a/4a/6a** (they call these methods) — hence it has only a
  0b dependency and no task waits on a wave boundary for it.
- **Test spec:** Each method writes exactly one well-formed JSON line with the expected `type` and
  fields; lines append correctly.
- **Verify:** `npm test -- src/__tests__/run/audit.test.ts && typecheck && lint`.

#### Task 9b — TUI display *(code; full template)* — after 6a
- **Depends on: 6a, 9a · Owns:** `src/tui/widget.ts`, `src/tui/format.ts`
- **Worker:** `task-worker` · **Test writer:** `task-worker-tests` · **Impl gate:** `code-quality-reviewer`
  · **Test gate:** `task-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:** Add a compact "worktrees" line to the widget footer/header showing active scope
  count + any in-progress merge (`◐ merging task-1 → wf`). Source from a `worktreeUsage` snapshot
  the tracker exposes (added in 2a/6a — read-only here). Keep within the existing 57-char slicing
  conventions.
- **Test spec:** Snapshot-style assertions on rendered lines for states: idle, one active scope,
  merge in progress.
- **Verify:** `npm test -- src/__tests__/tui && typecheck && lint`.

### Phase 10 — E2E + docs

#### Task 10a — End-to-end integration test *(code; full template)*
- **Depends on: 6a, 7a, 8a · Owns:** `src/__tests__/e2e/worktrees.test.ts`
- **Worker:** `task-worker` · **Test writer:** `task-worker-tests` · **Impl gate:** `wisp-arch-reviewer`
  · **Test gate:** `task-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:** One comprehensive test using a **real temp git repo** + `createFakeAdapter`.
  Workflow: `wf("demo",{worktree})` → `.reviewLoop("t1",{worktree, worker, gate})` →
  `.node("t2",{worktree, ...})`. Assert end-to-end:
  - worktrees created as siblings under `.wisp/runs/<run>/worktrees/`;
  - each agent's cwd is its scope's worktree (via fake adapter invocation capture);
  - `t1` and `t2` merge into the wf worktree (not main) in completion order;
  - the reviewLoop shares one worktree across iterations;
  - `run_workflow` result `details.workLocations` lists the wf branch + base;
  - post-run: checkouts gone, branches remain;
  - **resume**: kill mid-run, `resumeFrom`, assert reconstruction + a failed scope recreated fresh;
  - **interrupted merge**: parent left conflicted → on resume, abort + redo.
- **Test spec:** The test IS the spec above; the tests-reviewLoop gates it on coverage of every
  bullet.
- **Verify:** `npm test -- src/__tests__/e2e/worktrees.test.ts && typecheck && lint`.

#### Task 10b — Documentation *(docs; impl-reviewLoop + verify; no unit tests)*
- **Depends on: 6a, 7a · Owns:** `skills/wisp-authoring/SKILL.md`, `docs/dsl.md`, `docs/architecture.md`, `docs/design.md`
- **Worker:** `doc-writer` · **Gate:** `doc-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:**
  - `SKILL.md`: a new "Worktrees" section — the `{ worktree }` option on `wf`/`node`/macros, the
    all-or-none rule, "wisp never merges to main," the hand-off (where work lands), the
    `mergeProfile` option (default `wisp-merge-resolver`), and a reviewLoop-gets-its-own-worktree
    example.
  - `docs/dsl.md`: the `WorktreeConfig` fields + the nesting-doll model + the all-or-none
    validation errors.
  - `docs/architecture.md`: a "WorktreeTracker" subsection (scope registry, parent chain,
    per-parent merge queue, cleanup) under the executor section.
  - `docs/design.md`: locked decisions D1–D12 with rationale (lift from §2 of this plan).
- **Gate spec:** Accuracy (matches the shipped behavior), completeness (all D1–D12 reflected), no
  stale claims; examples compile against the real DSL.
- **Verify:** `npm run typecheck` (in case any code sample is extracted) + a read-through report.

### Phase 11 — Final verification

#### Task 11a — Whole-feature review + green suite *(verification; reviewLoop)*
- **Depends on: 10a, 10b · Owns: — (fixes only, gate-approved)***
- **Worker:** `task-worker` · **Gate:** `wisp-arch-reviewer` · **Verify:** `task-worker-lite`
- **Impl spec:** Run `npm run typecheck && npm test && npm run lint` on the full suite. Review the
  complete diff (`git diff main`) against D1–D12 and the invariants in §4.4. Confirm: no-worktree
  workflows are byte-identical in behavior; the all-or-none rule is enforced; nothing merges to
  main; cleanup keeps branches; resume reconstructs. The gate may approve small, scoped fixes; any
  fix touching a file outside this feature's scope is rejected.
- **Verify:** Full suite green; return `{passed, summary}` including the final `git diff --stat`.

---

## 9. Definition of done

- [ ] `npm run typecheck && npm test && npm run lint` all green on `main`.
- [ ] A no-worktree workflow behaves byte-identically to today (guarded, additive).
- [ ] All-or-none validation rejects bare children of worktree scopes.
- [ ] Worktrees created as siblings under `.wisp/runs/<run>/worktrees/`; agents run in them.
- [ ] Merges serialize per-parent into the parent worktree (never `main`); agent resolves conflicts.
- [ ] `run_workflow` result reports `workLocations` (branch + base); cleanup removes checkouts,
      keeps branches.
- [ ] Resume reconstructs worktrees as they lie; failed scopes recreate fresh; interrupted merges
      abort + redo.
- [ ] Docs + SKILL updated; e2e test covers the full lifecycle including resume.
- [ ] Bespoke `wisp-arch-reviewer` may be removed post-build; `wisp-merge-resolver` stays (shipped
      default).

---

## 10. Risks & open items

- **`executeDAG` is currently sync-by-design with an async race loop.** `ensureActive` (git I/O) on
  the ready path introduces a new async step before a node can run. Risk: a node marked `ready` must
  await worktree creation before `running` — implement as a small in-flight "priming" set so the
  main loop re-evaluates after each priming resolves (mirrors the existing `inFlight` pattern). This
  is the single most delicate integration point (Task 6a); budget extra review rounds there.
- **`synthesize.ts` had no cwd** (§4.3) — confirm the synthesis adapter invocation accepts and uses
  a cwd override; if the pi synthesis path differs, 5a may need a small adapter touch.
- **Scope-sink detection** in 6a must consider fanOut children, cond branches, and loop bodies
  (intra-scope edges only). Reuse `buildSuccessorsMap` filtered by shared `scopePath` prefix.
- **Branch-name uniqueness** = `wisp/<run-slug>/<scope-name>`; relies on unique node ids (already
  enforced) + unique run slug (`createRunDir` already de-collides).
- **Test hermeticity:** engine/tracker/merge tests MUST inject `Vcs`/`Merger` (no real git); only
  `vcs/worktree.test.ts` and `e2e/worktrees.test.ts` use real git in temp dirs. Gates enforce this.
- **`isCwdWithinRoot` carve-out** must not weaken the existing path-traversal guard for
  author-supplied `node.cwd` — only runtime-injected worktree roots are allowlisted (3b).
