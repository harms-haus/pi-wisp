/**
 * Profile resolution with scope-based precedence.
 *
 * Precedence (most-specific wins):
 *   1. Run-artifacts:  <runDir>/artifacts/profiles/*.md
 *   2. Project:        <cwd>/.pi/agent-profiles/*.md
 *   3. Global:         ~/.pi/agent/agent-profiles/*.md
 *   4. Inline:         In-workflow profile definitions (fallback)
 *
 * The implementation scans each scope in order via the shared, TTL-cached
 * loader ({@link loadProfilesFromDirCached}) and returns the first hit,
 * recording the source scope. Each scope is read from disk at most once per
 * 5-second TTL window rather than re-reading every `.md` on each call.
 * `agentType` validation is deferred to executor time (S26) — resolution does
 * NOT block on the adapter registry, preserving parallelism with the adapter
 * track (S8–S10).
 */

import { join } from "node:path";

import {
  getGlobalProfilesDir,
  getProjectProfilesDir,
  loadProfilesFromDirCached,
} from "./loader.js";
import { RUN_PROFILES_SUBDIR } from "../constants.js";
import type { ResolvedProfile, WispProfile } from "./types.js";

// ── Result / option types ───────────────────────────────────────────

/** Result of resolving a profile name across scopes. */
interface ResolveResult {
  /** Present on success. */
  resolved?: ResolvedProfile;
  /** Present when the name was not found in any scope. */
  error?: { kind: "validation"; nodeId?: string; message: string };
}

/** Options controlling which scopes are scanned. */
export interface ResolveOptions {
  /** Project working directory (enables the project scope). */
  cwd?: string;
  /** Run directory (enables the run-artifact scope — highest precedence). */
  runDir?: string;
  /** Inline profiles defined in the workflow (lowest precedence fallback). */
  inlineProfiles?: Record<string, WispProfile>;
}

// ── Scope directory paths ───────────────────────────────────────────

function getRunArtifactProfilesDir(runDir: string): string {
  return join(runDir, RUN_PROFILES_SUBDIR);
}

// ── Scope scanning ──────────────────────────────────────────────────

/**
 * Scan a single directory for a profile by name, using the shared TTL cache
 * keyed by `cacheKey`. Returns undefined if absent.
 */
function findInDir(dir: string, name: string, cacheKey: string): WispProfile | undefined {
  return loadProfilesFromDirCached(dir, cacheKey)[name];
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Resolve a profile name across scopes with strict precedence.
 *
 * Scans in order: run-artifacts → project → global → inline. Returns the first
 * match with its source scope. If no match is found in any scope, returns an
 * error result with `kind: "validation"`.
 */
function resolveProfile(name: string, options: ResolveOptions = {}): ResolveResult {
  const { cwd, runDir, inlineProfiles } = options;

  // 1. Run-artifacts (highest precedence)
  if (runDir) {
    const profile = findInDir(getRunArtifactProfilesDir(runDir), name, `run:${runDir}`);
    if (profile) {
      return { resolved: { profile, source: "run-artifact" } };
    }
  }

  // 2. Project
  if (cwd) {
    const profile = findInDir(getProjectProfilesDir(cwd), name, `project:${cwd}`);
    if (profile) {
      return { resolved: { profile, source: "project" } };
    }
  }

  // 3. Global
  {
    const profile = findInDir(getGlobalProfilesDir(), name, "global");
    if (profile) {
      return { resolved: { profile, source: "global" } };
    }
  }

  // 4. Inline (fallback)
  if (inlineProfiles) {
    const profile = inlineProfiles[name];
    if (profile) {
      return { resolved: { profile, source: "inline" } };
    }
  }

  // Not found in any scope
  return {
    error: {
      kind: "validation",
      message: `Profile "${name}" not found in any scope (run-artifact, project, global, or inline).`,
    },
  };
}

/**
 * Synchronous convenience wrapper around {@link resolveProfile} that returns
 * the {@link ResolvedProfile} directly (or undefined when not found). Same
 * precedence rules apply.
 */
export function resolveProfileSync(
  name: string,
  options: ResolveOptions = {},
): ResolvedProfile | undefined {
  return resolveProfile(name, options).resolved;
}
