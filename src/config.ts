import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

import type { ConcurrencyLimits, WispConfig } from "./types.js";
import { CONFIG_DEFAULTS, WISP_CONFIG_DIR, getAgentDir } from "./constants.js";

/**
 * TypeBox schema for the merged wisp configuration. Extra (unknown) keys are
 * ignored by construction (we only copy known keys into the candidate), so this
 * schema intentionally does not set `additionalProperties: false`.
 */
const ConfigSchema = Type.Object({
  maxAgentConcurrency: Type.Number({ minimum: 1 }),
  defaultRetries: Type.Number({ minimum: 0 }),
  retryBackoffMs: Type.Number({ minimum: 0 }),
  limits: Type.Optional(
    Type.Object({
      byProvider: Type.Optional(Type.Record(Type.String(), Type.Number({ minimum: 1 }))),
      byModel: Type.Optional(Type.Record(Type.String(), Type.Number({ minimum: 1 }))),
      byAgentType: Type.Optional(Type.Record(Type.String(), Type.Number({ minimum: 1 }))),
    }),
  ),
  profilesDirs: Type.Optional(Type.Array(Type.String())),
  runsDir: Type.Optional(Type.String()),
  adapterDefaults: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/** Internally-typed candidate object built before validation. */
interface ConfigCandidate {
  maxAgentConcurrency: unknown;
  defaultRetries: unknown;
  retryBackoffMs: unknown;
  limits: unknown;
  profilesDirs: unknown;
  runsDir: unknown;
  adapterDefaults: unknown;
}

/**
 * Read and JSON-parse a config file; throws a contextualized error (including
 * the file path) on malformed JSON; returns undefined only when the file is absent.
 */
function readJsonIfExists(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse config at ${path}: ${(e as Error).message}`, {
      cause: e,
    });
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return parsed as Record<string, unknown>;
}

/** Expand a leading `~` to the user's home directory (input is a validated string). */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Expand `~` in every entry of a directory list (validated to be string[] or absent). */
function expandArray(dirs: unknown): string[] | undefined {
  if (dirs === undefined) return undefined;
  return (dirs as string[]).map(expandTilde);
}

/** Build the pre-validation candidate from the merged raw config (defaults fill missing scalars). */
function buildCandidate(merged: Record<string, unknown>): ConfigCandidate {
  return {
    maxAgentConcurrency: merged.maxAgentConcurrency ?? CONFIG_DEFAULTS.maxAgentConcurrency,
    defaultRetries: merged.defaultRetries ?? CONFIG_DEFAULTS.defaultRetries,
    retryBackoffMs: merged.retryBackoffMs ?? CONFIG_DEFAULTS.retryBackoffMs,
    limits: merged.limits,
    profilesDirs: merged.profilesDirs,
    runsDir: merged.runsDir,
    adapterDefaults: merged.adapterDefaults,
  };
}

/** Validate the candidate against the schema; throw a descriptive error listing every violation. */
function validateOrThrow(candidate: ConfigCandidate): void {
  if (Value.Check(ConfigSchema, candidate)) return;
  const lines = [...Value.Errors(ConfigSchema, candidate)].map(
    (e) => `  - ${e.instancePath || "(root)"}: ${e.message}`,
  );
  throw new Error(`Invalid wisp configuration:\n${lines.join("\n")}`);
}

/** Coerce a validated candidate into a typed WispConfig, expanding `~` in path fields. */
function finalize(candidate: ConfigCandidate): WispConfig {
  return {
    maxAgentConcurrency: candidate.maxAgentConcurrency as number,
    defaultRetries: candidate.defaultRetries as number,
    retryBackoffMs: candidate.retryBackoffMs as number,
    limits: candidate.limits as ConcurrencyLimits | undefined,
    profilesDirs: expandArray(candidate.profilesDirs),
    runsDir: candidate.runsDir === undefined ? undefined : expandTilde(candidate.runsDir as string),
    adapterDefaults: candidate.adapterDefaults as Record<string, unknown> | undefined,
  };
}

/**
 * Load and validate the wisp configuration for the given working directory.
 *
 * Reads from (project overrides global):
 *   1. `~/.pi/agent/wisp.config.json` (global config)
 *   2. `<cwd>/.wisp/config.json` (project config)
 *
 * Missing files produce defaults. Unknown keys are silently ignored. `~` in
 * `profilesDirs`/`runsDir` is expanded to the user's home directory. The merged
 * result is validated with TypeBox `Value.Check`/`Value.Errors`.
 */
export function loadConfig(cwd: string): WispConfig {
  const globalPath = join(getAgentDir(), "wisp.config.json");
  const projectPath = join(cwd, WISP_CONFIG_DIR, "config.json");
  const merged: Record<string, unknown> = {
    ...(readJsonIfExists(globalPath) ?? {}),
    ...(readJsonIfExists(projectPath) ?? {}),
  };
  const candidate = buildCandidate(merged);
  validateOrThrow(candidate);
  return finalize(candidate);
}
