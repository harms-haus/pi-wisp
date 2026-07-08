/**
 * Profile-to-CLI-args conversion.
 *
 * Ported from `pi-subagents/src/profiles.ts` (`profileToArgs`, `pushBasicArgs`,
 * `pushSkillArgs`, `pushExtraArgs`, `isDangerousFlag`, `isWithinDir`).
 *
 * CRITICAL (D3 / DECISIONS.md): wisp does NOT pass credentials. This module
 * MUST NOT emit `--api-key` or set `PI_API_KEY` in the returned env. The
 * `apiKey` field is parsed by the loader for format compatibility but is
 * silently ignored here — the spawned harness inherits the host environment
 * and reads its own persisted auth.
 *
 * Security: `extraArgs` is the untrusted escape hatch. The override-guard
 * (`isDangerousFlag` + `pushExtraArgs`) refuses any extraArg that would
 * bypass the profile's active capability restrictions (tools, extensions,
 * skills, context files), and any `--skill`/`--extension` value surviving the
 * guard must be path-contained within an allowed directory (cwd / agentDir).
 */

import { resolve, sep } from "node:path";

import type { ProfileInvocation, WispProfile } from "./types.js";

// ── Flag vocabulary ─────────────────────────────────────────────────

/** Tool-set override flags (allowlist / disable). */
const TOOL_FLAGS = ["--tools", "-t", "--no-tools", "-nt"] as const;
/** Tool-exclusion flags. */
const EXCLUDE_TOOLS_FLAGS = ["--exclude-tools", "-xt"] as const;
/** Extension-add flags. */
const EXTENSION_FLAGS = ["--extension", "-e"] as const;
/** Extension-disable flags. */
const NO_EXTENSIONS_FLAGS = ["--no-extensions", "-ne"] as const;
/** Skill-add flags. */
const SKILL_FLAGS = ["--skill"] as const;
/** Skill-disable flags. */
const NO_SKILLS_FLAGS = ["--no-skills", "-ns"] as const;
/** Context-files-disable flags. */
const NO_CONTEXT_FILES_FLAGS = ["--no-context-files", "-nc"] as const;

/** Every flag capable of overriding a profile capability setting. */
const ALL_OVERRIDE_FLAGS = [
  ...TOOL_FLAGS,
  ...EXCLUDE_TOOLS_FLAGS,
  ...EXTENSION_FLAGS,
  ...NO_EXTENSIONS_FLAGS,
  ...SKILL_FLAGS,
  ...NO_SKILLS_FLAGS,
  ...NO_CONTEXT_FILES_FLAGS,
] as const;

/** Reject args/values that begin with a shell operator or embed separators. */
const SHELL_UNSAFE = /^[\s|&;$`!%^]|&&|\|\||;|>|>>|<|<<|\r|%/;

/** Whether `arg` is exactly one of `names` or a `name=value` equals-sign form. */
function flagMatches(arg: string, names: readonly string[]): boolean {
  for (const name of names) {
    if (arg === name || arg.startsWith(name + "=")) return true;
  }
  return false;
}

// ── Security helpers ────────────────────────────────────────────────

/**
 * Check whether a CLI argument is a capability-override flag (exact or
 * equals-sign form) — any flag that could bypass a profile restriction
 * (`--tools`, `--extension`, `--skill`, `--no-tools`, `--no-extensions`,
 * `--exclude-tools`, …). Whether it is actually refused depends on the active
 * restriction, checked by {@link pushExtraArgs}.
 */
export function isDangerousFlag(arg: string): boolean {
  return flagMatches(arg, ALL_OVERRIDE_FLAGS);
}

/** Whether `filePath` is `dir` itself or nested beneath it. */
export function isWithinDir(filePath: string, dir: string): boolean {
  const resolved = resolve(filePath);
  const resolvedDir = resolve(dir);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + sep);
}

/** Whether the profile has any tool-related restriction active. */
function hasToolRestriction(profile: WispProfile): boolean {
  return (
    profile.noTools === true ||
    (profile.tools !== undefined && profile.tools.length > 0) ||
    (profile.excludeTools !== undefined && profile.excludeTools.length > 0)
  );
}

/** Tool-related override flags (`--tools`/`--no-tools`/`--exclude-tools`). */
function isToolRelatedFlag(arg: string): boolean {
  return flagMatches(arg, TOOL_FLAGS) || flagMatches(arg, EXCLUDE_TOOLS_FLAGS);
}

/** Extension-related flags (`--extension`/`--no-extensions`). */
function isExtensionRelatedFlag(arg: string): boolean {
  return flagMatches(arg, EXTENSION_FLAGS) || flagMatches(arg, NO_EXTENSIONS_FLAGS);
}

/** Skill-related flags (`--skill`/`--no-skills`). */
function isSkillRelatedFlag(arg: string): boolean {
  return flagMatches(arg, SKILL_FLAGS) || flagMatches(arg, NO_SKILLS_FLAGS);
}

/** Context-files-related flags (`--no-context-files`). */
function isContextFilesRelatedFlag(arg: string): boolean {
  return flagMatches(arg, NO_CONTEXT_FILES_FLAGS);
}

/**
 * Whether `arg` must be refused given the profile's active restrictions:
 *   - tool flags when any tool restriction is active;
 *   - extension flags when extensions are disabled;
 *   - skill flags when skills are disabled;
 *   - context-files flags when context files are disabled.
 */
function isBlockedOverride(arg: string, profile: WispProfile): boolean {
  if (hasToolRestriction(profile) && isToolRelatedFlag(arg)) return true;
  if (profile.noExtensions === true && isExtensionRelatedFlag(arg)) return true;
  if (profile.noSkills === true && isSkillRelatedFlag(arg)) return true;
  if (profile.noContextFiles === true && isContextFilesRelatedFlag(arg)) return true;
  return false;
}

/** A `--skill`/`--extension` value extracted from an extraArgs flag token. */
interface MatchedValue {
  kind: "skill" | "extension";
  value: string;
  /** Whether the value came from the following array element (space form). */
  consumedNext: boolean;
}

/**
 * If `arg` is a `--skill`/`--extension` flag, extract its value (from the
 * equals-sign form or the following array element). Returns undefined for a
 * dangling flag with no following value.
 */
function matchValueFlag(arg: string, next: string | undefined): MatchedValue | undefined {
  // --skill
  if (arg === "--skill") {
    return next !== undefined ? { kind: "skill", value: next, consumedNext: true } : undefined;
  }
  if (arg.startsWith("--skill=")) {
    return { kind: "skill", value: arg.slice("--skill=".length), consumedNext: false };
  }
  // --extension / -e
  if (arg === "--extension" || arg === "-e") {
    return next !== undefined ? { kind: "extension", value: next, consumedNext: true } : undefined;
  }
  if (arg.startsWith("--extension=")) {
    return { kind: "extension", value: arg.slice("--extension=".length), consumedNext: false };
  }
  if (arg.startsWith("-e=")) {
    return { kind: "extension", value: arg.slice("-e=".length), consumedNext: false };
  }
  return undefined;
}

// ── Arg builders ────────────────────────────────────────────────────

/**
 * Push basic CLI flags (provider, model, prompts, thinking, tools/no-tools,
 * no-extensions, no-skills, no-context-files) onto `args` based on the
 * profile's fields.
 */
export function pushBasicArgs(args: string[], profile: WispProfile): void {
  if (profile.provider) args.push("--provider", profile.provider);
  if (profile.model) args.push("--model", profile.model);
  if (profile.systemPrompt) args.push("--system-prompt", profile.systemPrompt);
  if (profile.appendSystemPrompt) {
    args.push("--append-system-prompt", profile.appendSystemPrompt);
  }
  if (profile.thinkingLevel) args.push("--thinking", profile.thinkingLevel);

  if (profile.noTools) {
    args.push("--no-tools");
  } else if (profile.tools && profile.tools.length > 0) {
    args.push("--tools", profile.tools.join(","));
  }

  if (profile.noExtensions) args.push("--no-extensions");
  if (profile.noSkills) args.push("--no-skills");
  if (profile.noContextFiles) args.push("--no-context-files");
}

/**
 * Push `--skill` flags for `suggestedSkills`, validating paths are within
 * allowed directories (cwd / agentDir) when those are provided.
 */
export function pushSkillArgs(
  args: string[],
  profile: WispProfile,
  cwd?: string,
  agentDir?: string,
): void {
  if (!profile.suggestedSkills) return;

  const safeDirs: string[] = [];
  if (cwd) safeDirs.push(resolve(cwd));
  if (agentDir) safeDirs.push(resolve(agentDir));

  for (const skillPath of profile.suggestedSkills) {
    if (!skillPath) continue;
    if (safeDirs.length > 0 && !safeDirs.some((d) => isWithinDir(skillPath, d))) {
      throw new Error(`Refusing skill path outside allowed directories: ${skillPath}`);
    }
    args.push("--skill", skillPath);
  }
}

/**
 * Validate and push `extraArgs`, enforcing the override-guard security policy:
 *   - capability-override flags blocked when the matching restriction is active;
 *   - `--skill`/`--extension` values path-contained to cwd / agentDir (and
 *     refused outright when no allowed dir is configured, since containment
 *     cannot be verified);
 *   - null bytes rejected;
 *   - shell metacharacters / command separators rejected.
 */
export function pushExtraArgs(
  args: string[],
  profile: WispProfile,
  cwd?: string,
  agentDir?: string,
): void {
  if (!profile.extraArgs) return;

  const safeDirs: string[] = [];
  if (cwd) safeDirs.push(resolve(cwd));
  if (agentDir) safeDirs.push(resolve(agentDir));

  const extra = profile.extraArgs;
  for (let i = 0; i < extra.length; i++) {
    const arg = extra[i];
    if (arg === undefined) continue;

    if (arg.includes("\0")) {
      throw new Error("Invalid extraArg: contains null byte");
    }
    if (SHELL_UNSAFE.test(arg)) {
      throw new Error(`Refusing extraArg: potentially unsafe argument '${arg.slice(0, 40)}'`);
    }
    if (isBlockedOverride(arg, profile)) {
      throw new Error(
        `Refusing extraArg "${arg}" which would override profile restrictions. Use the dedicated profile fields instead.`,
      );
    }

    // Path-containment check for any surviving --skill / --extension value.
    const matched = matchValueFlag(arg, extra[i + 1]);
    if (matched) {
      const val = matched.value;
      if (val.includes("\0")) {
        throw new Error("Invalid extraArg value: contains null byte");
      }
      if (SHELL_UNSAFE.test(val)) {
        throw new Error(`Refusing extraArg: potentially unsafe argument '${val.slice(0, 40)}'`);
      }
      if (safeDirs.length === 0 || !safeDirs.some((d) => isWithinDir(val, d))) {
        throw new Error(`Refusing ${matched.kind} path outside allowed directories: ${val}`);
      }
      if (matched.consumedNext) {
        i++;
      }
    }
  }

  args.push(...extra);
}

/**
 * Convert a WispProfile into invocation parameters (CLI args + env vars).
 *
 * Precondition: `excludeTools` MUST be resolved away (via
 * {@link resolveExcludeTools}) before this call — otherwise the computed
 * allowlist would be silently dropped, so this throws loudly instead.
 *
 * CRITICAL (D3): This function MUST NOT emit `--api-key` or set `PI_API_KEY`
 * in the env. The `apiKey` field is parsed by the loader (for compatibility)
 * but is silently ignored by this conversion. The returned `env` is always
 * empty — the spawned harness inherits the host environment.
 */
export function profileToArgs(
  profile: WispProfile,
  cwd?: string,
  agentDir?: string,
): ProfileInvocation {
  if (profile.excludeTools && profile.excludeTools.length > 0) {
    throw new Error(
      'profileToArgs received a profile with "excludeTools" still set. Call resolveExcludeTools first to compute an explicit "tools" allowlist before conversion.',
    );
  }

  const args: string[] = [];
  const envVars: Record<string, string> = {};

  pushBasicArgs(args, profile);

  // D3: wisp does NOT forward apiKey — no PI_API_KEY env, no --api-key arg.
  // The apiKey field is parsed by the loader for format compatibility only.

  if (profile.extensions) {
    for (const ext of profile.extensions) {
      args.push("--extension", ext);
    }
  }

  pushSkillArgs(args, profile, cwd, agentDir);
  pushExtraArgs(args, profile, cwd, agentDir);

  return { args, env: envVars };
}

// ── excludeTools resolution ─────────────────────────────────────────

/**
 * Resolve a profile's `excludeTools` against the full tool set and return the
 * computed `tools` allowlist. This is a pure computation helper used by the
 * executor (which has access to `pi.getAllTools()`) before calling
 * `profileToArgs`.
 *
 * - If the profile has `excludeTools`, returns `allToolNames` minus the
 *   excluded set.
 * - If the profile already has `tools` (no `excludeTools`), returns
 *   `profile.tools` as-is.
 * - If neither is set, returns undefined.
 */
export function resolveExcludeTools(
  profile: WispProfile,
  allToolNames: string[],
): string[] | undefined {
  if (profile.excludeTools && profile.excludeTools.length > 0) {
    const excludeSet = new Set(profile.excludeTools);
    return allToolNames.filter((name) => !excludeSet.has(name));
  }
  if (profile.tools) {
    return profile.tools;
  }
  return undefined;
}
