/**
 * Profile loader.
 *
 * Ported from `pi-subagents/src/profiles.ts` with these wisp-specific changes:
 *   - Adds the `agentType` field (defaults to `"pi"` when absent — D1).
 *   - Drops profile CRUD (saveProfile/deleteProfile); wisp uses the built-in
 *     `write` tool instead (IMPLEMENTATION §10.3).
 *   - `apiKey` is parsed and stored for format compatibility but is NEVER
 *     emitted to env/args (D3 / DECISIONS.md) — the pi adapter ignores it.
 *
 * Profile markdown format:
 * ---
 * name: my-profile
 * agentType: pi
 * provider: anthropic
 * model: claude-sonnet-4-5
 * thinkingLevel: high
 * tools: read,bash,grep
 * ---
 * You are a coding agent...
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { getAgentDir } from "../constants.js";
import { resolveExcludeTools } from "./to-args.js";
import type { ThinkingLevel, WispProfile, WispProfiles } from "./types.js";

// ── TTL cache ──────────────────────────────────────────────────────
// Ported from pi-subagents/src/cache.ts.

/**
 * A small per-key TTL cache. Entries expire individually after `ttl` ms; a
 * fresh `set` for a key refreshes its timestamp. Supports multiple keys so
 * the various profile scopes (global / project / run-artifact) can be cached
 * simultaneously without evicting each other.
 */
class TtlCache<T> {
  private entries = new Map<string, { data: T; timestamp: number }>();

  constructor(private ttl: number) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp < this.ttl) {
      return entry.data;
    }
    this.entries.delete(key); // Allow GC of stale data
    return undefined;
  }

  set(key: string, data: T): void {
    this.entries.set(key, { data, timestamp: Date.now() });
  }

  invalidate(): void {
    this.entries.clear();
  }
}

// ── Profile cache ───────────────────────────────────────────────────

const profilesCache = new TtlCache<WispProfiles>(5000);

/** Manually invalidate the in-memory profile cache. */
export function invalidateProfilesCache(): void {
  profilesCache.invalidate();
}

// ── Helpers for array/string frontmatter fields ─────────────────────

/** Parse a frontmatter value that may be a comma-delimited string or an array. */
export function parseStringOrArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
}

// ── Profile directory paths ─────────────────────────────────────────

/** Global profiles directory: `~/.pi/agent/agent-profiles/`. */
export function getGlobalProfilesDir(): string {
  return join(getAgentDir(), "agent-profiles");
}

/** Project-local profiles directory: `<cwd>/.pi/agent-profiles/`. */
export function getProjectProfilesDir(cwd: string): string {
  return join(cwd, ".pi", "agent-profiles");
}

/**
 * Load every `.md` profile from `dir` into a fresh map, memoised in the shared
 * profile cache under `cacheKey` (5-second TTL). Used by the scope-precedence
 * resolver so each scope is read at most once per TTL window instead of
 * re-reading every file on each lookup.
 */
export function loadProfilesFromDirCached(dir: string, cacheKey: string): WispProfiles {
  const cached = profilesCache.get(cacheKey);
  if (cached) return cached;
  const profiles: WispProfiles = {};
  loadProfilesFromDir(dir, profiles);
  profilesCache.set(cacheKey, profiles);
  return profiles;
}

// ── Frontmatter field sets ──────────────────────────────────────────

/** String fields copied directly from frontmatter to profile. */
const STRING_FIELDS = ["agentType", "provider", "model", "appendSystemPrompt"] as const;

/** Boolean flags copied from frontmatter to profile. */
const BOOLEAN_FLAGS = ["noTools", "noExtensions", "noSkills", "noContextFiles"] as const;

/** Array-or-string fields parsed and copied. */
const ARRAY_FIELDS = [
  "tools",
  "excludeTools",
  "extensions",
  "extraArgs",
  "suggestedSkills",
  "loadSkills",
] as const;

// ── Profile tool validation ─────────────────────────────────────────

/**
 * Validate that a profile's tool settings are internally consistent.
 *
 * Throws if both `tools` (allowlist) and `excludeTools` (blacklist) are set,
 * since they are mutually exclusive.
 */
export function validateProfileTools(profile: WispProfile, profileName?: string): void {
  if (
    profile.tools &&
    profile.tools.length > 0 &&
    profile.excludeTools &&
    profile.excludeTools.length > 0
  ) {
    throw new Error(
      `Profile${profileName ? ` "${profileName}"` : ""} has both "tools" (allowlist) and "excludeTools" (blacklist) set. These are mutually exclusive — choose one or the other.`,
    );
  }
}

/**
 * Resolve `excludeTools` against the full tool set to compute an explicit
 * `tools` allowlist. Returns a new profile with `tools` set and `excludeTools`
 * removed. If the profile has no `excludeTools`, returns the profile unchanged.
 *
 * Delegates the actual set subtraction to the canonical
 * {@link resolveExcludeTools} (to-args.ts) so there is a single excludeTools
 * resolver.
 */
export function applyExcludeTools(profile: WispProfile, allToolNames: string[]): WispProfile {
  if (!profile.excludeTools || profile.excludeTools.length === 0) {
    return profile;
  }
  const computed = resolveExcludeTools(profile, allToolNames);
  return { ...profile, tools: computed, excludeTools: undefined };
}

// ── Profile loading from markdown files ─────────────────────────────

/**
 * Parse frontmatter fields into a WispProfile.
 *
 * Adds `agentType` (defaulting to `"pi"` when absent). The `apiKey` field is
 * parsed and stored for format compatibility but is ignored downstream (D3).
 *
 * @param frontmatter - Parsed YAML frontmatter key-value pairs.
 * @param body - Markdown body after the frontmatter (becomes systemPrompt).
 * @returns The parsed profile, or undefined if frontmatter lacks a valid name.
 */
export function parseProfileFromFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): WispProfile | undefined {
  const name = frontmatter.name;
  if (typeof name !== "string" || !name) {
    return undefined;
  }

  const profile: WispProfile = {};

  // String fields
  for (const field of STRING_FIELDS) {
    if (typeof frontmatter[field] === "string") {
      profile[field] = frontmatter[field];
    }
  }

  // thinkingLevel has a type cast
  if (typeof frontmatter.thinkingLevel === "string") {
    profile.thinkingLevel = frontmatter.thinkingLevel as ThinkingLevel;
  }

  // apiKey: parsed/stored for compatibility, but UNUSED by wisp (D3)
  if (typeof frontmatter.apiKey === "string") {
    profile.apiKey = frontmatter.apiKey;
  }

  // Body = system prompt
  const trimmedBody = body.trim();
  if (trimmedBody) profile.systemPrompt = trimmedBody;

  // Array/string fields
  for (const field of ARRAY_FIELDS) {
    const parsed = parseStringOrArray(frontmatter[field]);
    if (parsed) profile[field] = parsed;
  }

  // Boolean flags
  for (const flag of BOOLEAN_FLAGS) {
    if (frontmatter[flag] === true) profile[flag] = true;
  }

  // agentType defaults to "pi" (D1 — v1 ships only the pi adapter)
  if (!profile.agentType) {
    profile.agentType = "pi";
  }

  return profile;
}

/**
 * Load all `.md` profile files from a directory and add them to the `profiles`
 * map (keyed by the frontmatter `name`). Silent if the directory does not
 * exist. Non-fatal errors on individual files are logged but do not abort the
 * batch.
 */
export function loadProfilesFromDir(dir: string, profiles: WispProfiles): void {
  if (!existsSync(dir)) {
    return;
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!(entry.isFile() && entry.name.endsWith(".md"))) {
      continue;
    }

    const filePath = join(dir, entry.name);
    try {
      const content = readFileSync(filePath, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);
      const profile = parseProfileFromFrontmatter(frontmatter, body);
      if (profile) {
        const profileName = frontmatter.name;
        if (typeof profileName === "string" && profileName) {
          profiles[profileName] = profile;
        }
      }
    } catch (error) {
      console.warn(
        `Failed to load profile from ${filePath}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/**
 * Load all profiles from global (`~/.pi/agent/agent-profiles/`) and, if `cwd`
 * is provided, project-local (`<cwd>/.pi/agent-profiles/`) directories.
 *
 * Results are cached with a 5-second TTL keyed by cwd. Project-local profiles
 * override global ones with the same name.
 */
export function loadProfiles(cwd?: string): WispProfiles {
  const key = cwd ?? "";
  const cached = profilesCache.get(key);
  if (cached) {
    return cached;
  }

  const profiles: WispProfiles = {};

  // Load global profiles
  loadProfilesFromDir(getGlobalProfilesDir(), profiles);

  // Load project-local profiles (override globals)
  if (cwd) {
    loadProfilesFromDir(getProjectProfilesDir(cwd), profiles);
  }

  profilesCache.set(key, profiles);
  return profiles;
}

/**
 * Look up a profile by name in an already-loaded profiles map.
 * Returns undefined if not found.
 *
 * (Scope-precedence resolution lives in `resolve.ts` as the sole
 * `resolveProfile`.)
 */
export function lookupProfile(
  profiles: WispProfiles,
  profileName: string,
): WispProfile | undefined {
  return profiles[profileName];
}
