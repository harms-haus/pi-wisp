# Configuration

wisp configuration covers three areas: the `.wisp/config.json` file (concurrency
limits, retries, directories), the concurrency pool model (layered pools with
AND semantics), and agent profile resolution (scope-based precedence).

> See also: [architecture.md](architecture.md) for how the scheduler and executor
> use these settings, and [dsl.md](dsl.md) for the inline profile API.

---

## Table of Contents

- [Config File](#config-file)
  - [Schema](#schema)
  - [Defaults](#defaults)
  - [Loading & Merging](#loading--merging)
  - [Validation](#validation)
  - [Path Expansion](#path-expansion)
- [Concurrency Pools](#concurrency-pools)
  - [Pool Membership](#pool-membership)
  - [AND Semantics](#and-semantics)
  - [Blocking acquire](#blocking-acquire)
  - [byModel Key Fallback](#bymodel-key-fallback)
  - [Example](#example)
- [Profile System](#profile-system)
  - [Profile Format](#profile-format)
  - [Field Reference](#field-reference)
  - [Resolution Precedence](#resolution-precedence)
  - [Profile-to-Args Security](#profile-to-args-security)
  - [Bespoke Profile Authoring](#bespoke-profile-authoring)

---

## Config File

### Schema

Defined in `src/config.ts` and validated with TypeBox. The config file lives at
`<cwd>/.wisp/config.json`:

```json
{
  "maxAgentConcurrency": 12,
  "limits": {
    "byProvider": { "zai": 7 },
    "byModel": { "deepseek-v4-flash": 3, "anthropic/claude-sonnet-4-5": 4 },
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

| Field                  | Type                          | Description                                               |
| ---------------------- | ----------------------------- | --------------------------------------------------------- |
| `maxAgentConcurrency`  | `number` (≥ 1)                | Global cap on concurrently running agents.                |
| `limits.byProvider`    | `Record<string, number>`      | Max concurrent per provider name (e.g. `"anthropic": 5`). |
| `limits.byModel`       | `Record<string, number>`      | Max concurrent per model key (see [byModel Key Fallback](#bymodel-key-fallback)). |
| `limits.byAgentType`   | `Record<string, number>`      | Max concurrent per adapter type (e.g. `"pi": 8`).        |
| `profilesDirs`         | `string[]`                    | Additional profile search directories (`~` expanded).    |
| `runsDir`              | `string`                      | Directory for run artifacts (`~` expanded).              |
| `defaultRetries`       | `number` (≥ 0)                | Default retry count for nodes without a per-node `retries`. |
| `retryBackoffMs`       | `number` (≥ 0)                | Base backoff (ms) between retries. Exponential: `backoff * 2^(attempt-1)`. |
| `adapterDefaults`      | `Record<string, unknown>`     | Per-adapter options, keyed by adapter type.               |

All fields are optional except that scalar defaults fill in when absent (see
[Defaults](#defaults)). Unknown keys are silently ignored.

### Defaults

From `src/constants.ts` (`CONFIG_DEFAULTS`):

| Setting                | Default |
| ---------------------- | ------- |
| `maxAgentConcurrency`  | `12`    |
| `defaultRetries`       | `3`     |
| `retryBackoffMs`       | `2000`  |
| `MAX_MESSAGES_PER_SESSION` | `500` (constant, not configurable via config.json) |

When `limits` is absent or a specific pool is not defined, that pool is not
enforced (only `global` is always present).

### Loading & Merging

`loadConfig(cwd)` reads two files and merges them (**project overrides global**):

1. **Global:** `~/.pi/agent/wisp.config.json` (where `~/.pi/agent/` =
   `process.env.PI_AGENT_DIR ?? ~/.pi/agent/`)
2. **Project:** `<cwd>/.wisp/config.json`

Missing files produce defaults. The merge is a shallow spread: project keys
override global keys at the top level (nested objects like `limits` are not
deep-merged — a project `limits` replaces the global `limits` entirely).

### Validation

The merged config is validated with TypeBox `Value.Check` / `Value.Errors`. On
failure, a descriptive error is thrown listing every violation:

```
Invalid wisp configuration:
  - /maxAgentConcurrency: Expected number
  - /limits/byProvider/zai: Expected number
```

In lifecycle hooks, a config-load failure is caught and logged — wisp falls back
to defaults so a malformed config never crashes the extension.

### Path Expansion

`~` in `profilesDirs` and `runsDir` entries is expanded to the user's home
directory (`os.homedir()`). Both `~` (bare home) and `~/rest` forms are handled.

---

## Concurrency Pools

The scheduler (`src/engine/scheduler.ts`) enforces layered concurrency pools
with **AND semantics**: a node can start only when **every pool it belongs to**
has a free slot.

### Pool Membership

For a given node, pools are determined from its **resolved profile**:

| Pool              | Key                                       | Condition for membership                     |
| ----------------- | ----------------------------------------- | -------------------------------------------- |
| **global**        | —                                         | **Always.** Cap = `maxAgentConcurrency`.     |
| **byAgentType**   | `agentType` (profile field, default `"pi"`) | Only if a limit is configured for this type. |
| **byProvider**    | `provider` (profile field)                | Only if a limit is configured for this provider. |
| **byModel**       | `provider/model` or bare `model` (see below) | Only if a limit is configured for this key. |

A node with no `provider` or `model` in its profile simply does not contend for
those pools. A limit key that is never matched by any node does not appear in
`usage()` (pools are created lazily).

### AND Semantics

`tryAcquire(node)`:

1. **Phase 1 — Check:** verify EVERY pool the node belongs to has `used < cap`.
   If any pool is full, return `false` (nothing is claimed).
2. **Phase 2 — Claim:** increment `used` in ALL pools (guaranteed to succeed —
   no partial acquisition).

`release(node)`: decrements `used` in ALL pools (clamped at zero).

This means a node blocked on a `byModel` limit will wait even if the global and
provider pools have room. Only when **all** its pools have capacity can it start.

### Blocking acquire

`tryAcquire(node)` is the **non-blocking first-pass probe**: it returns `false`
immediately when no slot is free. The scheduler also offers an async
**semaphore** variant that the executor relies on:

```ts
tryAcquire(node: SchedulableNode): boolean;
acquire(node: SchedulableNode, signal?: AbortSignal): Promise<boolean>;
```

`acquire(node, signal)`:

1. Calls `tryAcquire(node)` first. If it succeeds, resolves `true` immediately
   (no queueing).
2. Otherwise appends the caller to a **FIFO wait queue** and resolves once a
   `release()` makes capacity available. AND-semantics are preserved: a waiter
   is woken only when **every** pool it belongs to has a free slot, at which
   point all its slots are claimed atomically (`wakeFirstCompatibleWaiter`
   scans the queue in order and skips waiters that still lack capacity).
3. If an `AbortSignal` is passed and it fires while queued, the waiter is
   removed from the queue and resolves `false` (abort-safe — no leaked slot,
   no hung promise).
4. If the signal is **already aborted** on entry, resolves `false` without
   queueing.

The executor (`runNodeWrapper`) uses `acquire()` as its blocking semaphore when
scheduling a node, and re-acquires via `acquire()` before each retry attempt
(since the slot is released between attempts so other nodes may run during
validation / back-off sleep).

### byModel Key Fallback

The `byModel` pool key uses a two-step fallback (Decision §22):

1. Try the **composite key** `"provider/model"` (e.g.
   `"anthropic/claude-sonnet-4-5"`).
2. If no limit is configured for the composite, try the **bare model** key
   (e.g. `"claude-sonnet-4-5"`).
3. If neither has a configured limit, the node does not contend for a model pool.

This lets you configure limits at whatever granularity makes sense:

```json
{
  "limits": {
    "byModel": {
      "anthropic/claude-sonnet-4-5": 4,
      "deepseek-v4-flash": 3
    }
  }
}
```

### Example

With this config:

```json
{
  "maxAgentConcurrency": 12,
  "limits": {
    "byProvider": { "anthropic": 5 },
    "byModel": { "anthropic/claude-sonnet-4-5": 3 }
  }
}
```

A node using `provider: "anthropic"`, `model: "claude-sonnet-4-5"` belongs to
three pools: **global** (cap 12), **byProvider["anthropic"]** (cap 5), and
**byModel["anthropic/claude-sonnet-4-5"]** (cap 3). It can start only when all
three have free slots.

The TUI footer shows live usage (from `scheduler.usage()`):

```
global 4/12 · provider:anthropic 5/5 · model:anthropic/claude-sonnet-4-5 3/3
```

Only pools with `cap > 0` or `used > 0` are shown.

---

## Profile System

Profiles are reusable agent configurations stored as Markdown files with YAML
frontmatter. wisp reuses the pi-subagents profile format and adds the `agentType`
field.

### Profile Format

```markdown
---
name: reviewer
agentType: pi
provider: anthropic
model: claude-sonnet-4-5
thinkingLevel: high
tools: read,bash,grep
excludeTools: write
noTools: false
noExtensions: false
extensions: []
noSkills: false
suggestedSkills: []
loadSkills: []
noContextFiles: false
appendSystemPrompt: ""
apiKey: ""
extraArgs: []
---
You are a code reviewer. Focus on correctness, security, and clarity.
```

- All frontmatter fields are optional except `name`.
- The **body** (text after the frontmatter) becomes the `systemPrompt` (replaces
  the default). Use `appendSystemPrompt` to add instead of replace.
- `agentType` selects which adapter handles the profile. Defaults to `"pi"` when
  absent — so existing pi-subagents profiles work unchanged.
- `tools` and `excludeTools` are **mutually exclusive** — setting both is an
  error at parse time.

### Field Reference

| Field                | Type             | Maps to CLI flag                    | Notes                                              |
| -------------------- | ---------------- | ----------------------------------- | -------------------------------------------------- |
| `agentType`          | `string`         | (selects adapter)                   | Default `"pi"`.                                    |
| `provider`           | `string`         | `--provider`                        | e.g. `"anthropic"`, `"openai"`.                    |
| `model`              | `string`         | `--model`                           | Model ID or pattern.                               |
| `systemPrompt`       | `string`         | `--system-prompt`                   | Sourced from the Markdown body.                    |
| `appendSystemPrompt` | `string`         | `--append-system-prompt`            | Appended to the default system prompt.             |
| `thinkingLevel`      | `string`         | `--thinking`                        | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh`. |
| `noTools`            | `boolean`        | `--no-tools`                        | Disable all tools.                                 |
| `tools`              | `string[]`       | `--tools` (comma-joined)            | Allowlist of tool names.                           |
| `excludeTools`       | `string[]`       | (resolved to `--tools`)             | Blacklist — computed into an allowlist at runtime. |
| `noExtensions`       | `boolean`        | `--no-extensions`                   | Disable all extensions.                            |
| `extensions`         | `string[]`       | `--extension` (one per entry)       | Extension paths to load.                           |
| `noSkills`           | `boolean`        | `--no-skills`                       | Disable skills.                                    |
| `suggestedSkills`    | `string[]`       | `--skill` (one per entry)           | Skills the model may choose to load.               |
| `loadSkills`         | `string[]`       | (injected into appendSystemPrompt)  | Skills pre-loaded into context.                    |
| `noContextFiles`     | `boolean`        | `--no-context-files`                | Disable AGENTS.md / CLAUDE.md context files.       |
| `apiKey`             | `string`         | **unused**                          | Retained for format compat; **ignored by wisp** (D3). |
| `extraArgs`          | `string[]`       | (passed verbatim)                   | Security-validated (see below).                    |

> **API keys (Decision D3):** wisp does **not** pass, map, or forward API keys.
> The spawned pi process inherits the host environment and reads its own
> persisted auth (via `pi auth`, provider env vars the user has set, etc.). The
> `apiKey` field is parsed for format compatibility but **never acted upon**.
> Configure the harness directly.

### Resolution Precedence

`resolveProfile(name, options)` in `src/profiles/resolve.ts` scans scopes in
order (most-specific wins):

| Priority | Scope          | Directory                                        | Source label    |
| -------- | -------------- | ------------------------------------------------ | --------------- |
| 1        | Run-artifacts  | `<runDir>/artifacts/profiles/*.md`               | `"run-artifact"` |
| 2        | Project        | `<cwd>/.pi/agent-profiles/*.md`                  | `"project"`     |
| 3        | Global         | `~/.pi/agent/agent-profiles/*.md`                | `"global"`      |
| 4        | Inline         | `wf.profile(name, {…})` in the workflow script   | `"inline"`      |

The first scope with a matching `name` wins. Each scope is read from disk at
most once per **5-second TTL** window (a per-scope cache in
`src/profiles/loader.ts`). If no scope has the profile, a structured `validation`
error is returned.

`agentType` validation (checking the adapter registry) is **deferred to executor
time** — resolution does not block on adapter availability, preserving
parallelism.

### Profile-to-Args Security

`profileToArgs()` in `src/profiles/to-args.ts` (ported from pi-subagents) converts
a `WispProfile` to CLI arguments. The `extraArgs` field is an untrusted escape
hatch, validated with these rules:

1. **Null bytes** rejected (`\0`).
2. **Shell metacharacters** rejected (regex matching `|`, `&`, `;`, `$`, `` ` ``,
   `!`, `%`, `^`, `>`, `<`, `\r`, `&&`, `||`, etc.).
3. **Capability-override flags** blocked when the matching restriction is active:
   - `--tools`/`--no-tools`/`--exclude-tools` when any tool restriction is active.
   - `--extension`/`--no-extensions` when extensions are disabled.
   - `--skill`/`--no-skills` when skills are disabled.
   - `--no-context-files` when context files are disabled.
4. **Path containment** for `--skill`/`--extension` values: must resolve within
   `cwd` or the agent dir (`~/.pi/agent/`); refused outright when no allowed dir
   is configured.

**`excludeTools` resolution:** `excludeTools` cannot be passed directly to the
CLI — it must first be resolved into an explicit `tools` allowlist via
`resolveExcludeTools(profile, allToolNames)` (set subtraction against
`pi.getAllTools()`). `profileToArgs()` throws if it receives a profile with
unresolved `excludeTools`.

### Bespoke Profile Authoring

wisp does **not** provide a `create_profile` tool. The orchestrating agent
authors bespoke profiles by writing `.md` files with YAML frontmatter into the
run's artifacts directory (or project/global dirs) using the built-in `write`
tool:

```
<runDir>/artifacts/profiles/reviewer.md
```

The `list_profiles` tool discovers profiles across scopes. The entire surface is:
file writes + `list_profiles` for discovery.
