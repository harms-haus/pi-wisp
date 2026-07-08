// ═══════════════════════════════════════════════════════════════════════════
// list_profiles tool (S35 / PLAN §13 / kb-19).
//
// Lists available agent profiles across run/project/global scopes with
// precedence information. Scope filter: "global" | "project" | "run" | "all".
// Each entry includes: name, agentType, provider, model, thinkingLevel,
// toolSummary, and source.
// ═══════════════════════════════════════════════════════════════════════════

import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { join } from "node:path";

import type { WispProfile } from "../profiles/types.js";
import {
  getGlobalProfilesDir,
  getProjectProfilesDir,
  loadProfilesFromDirCached,
} from "../profiles/loader.js";
import { RUN_PROFILES_SUBDIR } from "../constants.js";

// ─── Parameter schema (§13) ───────────────────────────────────────

/**
 * TypeBox schema for the `list_profiles` tool parameters.
 *
 * - `scope`: which scope(s) to list ("global" | "project" | "run" | "all"; default "all").
 * - `runId`: optional run directory path or slug (required when scope is "run").
 */
export const ListProfilesParams = Type.Object(
  {
    scope: Type.Optional(
      Type.String({
        description: 'Scope filter: "global", "project", "run", or "all" (default: "all")',
      }),
    ),
    runId: Type.Optional(
      Type.String({ description: "Run directory path or slug (required when scope is 'run')" }),
    ),
  },
  { description: "List available agent profiles across run/project/global/inline scopes." },
);

// ─── Profile entry shape ──────────────────────────────────────────

/** A single profile entry returned in the tool result. */
interface ProfileEntry {
  name: string;
  agentType: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  toolSummary: string;
  source: string;
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Produce a human-readable tool summary for a profile. */
function summarizeTools(p: WispProfile): string {
  if (p.noTools) return "none";
  if (p.tools && p.tools.length > 0) return p.tools.join(", ");
  if (p.excludeTools && p.excludeTools.length > 0) {
    return `all (excludes: ${p.excludeTools.join(", ")})`;
  }
  return "all";
}

/** Convert a WispProfile + source + name into a ProfileEntry. */
function toEntry(name: string, p: WispProfile, source: string): ProfileEntry {
  return {
    name,
    agentType: p.agentType ?? "pi",
    provider: p.provider ?? "",
    model: p.model ?? "",
    thinkingLevel: p.thinkingLevel ?? "",
    toolSummary: summarizeTools(p),
    source,
  };
}

/**
 * Load profiles from a directory and return them as entries with a fixed source label.
 * Handles missing/inaccessible directories gracefully.
 */
function loadProfilesAsEntries(dir: string, cacheKey: string, source: string): ProfileEntry[] {
  const entries: ProfileEntry[] = [];
  try {
    const profiles = loadProfilesFromDirCached(dir, cacheKey);
    for (const [name, p] of Object.entries(profiles)) {
      entries.push(toEntry(name, p, source));
    }
  } catch {
    // Directory missing or unreadable — no profiles in this scope.
  }
  return entries;
}

// ─── renderResult ─────────────────────────────────────────────────

/**
 * Render the profile list as a formatted text block for the tool result.
 */
function renderProfileList(profiles: ProfileEntry[]): string {
  if (profiles.length === 0) {
    return "No agent profiles found in the requested scope(s).";
  }
  const lines: string[] = [];
  for (const p of profiles) {
    const parts: string[] = [`${p.name} (${p.agentType})`, `source: ${p.source}`];
    if (p.provider) parts.push(`provider: ${p.provider}`);
    if (p.model) parts.push(`model: ${p.model}`);
    if (p.thinkingLevel) parts.push(`thinking: ${p.thinkingLevel}`);
    if (p.toolSummary) parts.push(`tools: ${p.toolSummary}`);
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}

// ─── Tool definition ──────────────────────────────────────────────

export const listProfilesTool = {
  name: "list_profiles" as const,
  label: "List Profiles",
  description: [
    "List available agent profiles across scopes with precedence information.",
    "Scopes: run-artifact (highest) › project (.pi/agent-profiles/) › global (~/.pi/agent/agent-profiles/) › inline.",
    "Returns name, agentType, provider, model, thinkingLevel, toolSummary, and source for each profile.",
  ].join(" "),
  parameters: ListProfilesParams,

  // ── renderCall ──────────────────────────────────────────────

  renderCall(params: { scope?: string; runId?: string }): Component {
    const scope = params.scope ?? "all";
    if (scope === "run" && params.runId) {
      return new Text(`list profiles from run ${params.runId}`, 0, 0);
    }
    return new Text(`list ${scope} profiles`, 0, 0);
  },

  // ── renderResult ────────────────────────────────────────────

  renderResult(
    result: { content: Array<{ type: string; text?: string }>; details: unknown },
    _options: { expanded: boolean; isPartial: boolean },
  ): Component {
    return new Text(result.content[0]?.text ?? "", 0, 0);
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async execute(
    _toolCallId: string,
    params: Record<string, unknown>,
    _signal: AbortSignal | undefined,
    _onUpdate:
      | ((update: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void)
      | undefined,
    ctx: { cwd: string },
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
    const scope =
      typeof params.scope === "string" && ["all", "global", "project", "run"].includes(params.scope)
        ? params.scope
        : "all";
    const runId = typeof params.runId === "string" ? params.runId : undefined;

    // Validate: scope 'run' requires runId.
    if (scope === "run" && !runId) {
      return {
        content: [
          { type: "text", text: 'Validation error: runId is required when scope is "run".' },
        ],
        details: { kind: "validation", message: 'runId is required when scope is "run".' },
      };
    }

    const allProfiles: ProfileEntry[] = [];

    // Collect profiles from each scope based on the filter.
    if (scope === "all" || scope === "global") {
      const globalDir = getGlobalProfilesDir();
      allProfiles.push(...loadProfilesAsEntries(globalDir, "global", "global"));
    }

    if (scope === "all" || scope === "project") {
      const projectDir = getProjectProfilesDir(ctx.cwd);
      allProfiles.push(...loadProfilesAsEntries(projectDir, `project:${ctx.cwd}`, "project"));
    }

    if (scope === "all" || scope === "run") {
      if (runId) {
        const runArtifactDir = join(runId, RUN_PROFILES_SUBDIR);
        allProfiles.push(...loadProfilesAsEntries(runArtifactDir, `run:${runId}`, "run-artifact"));
      }
      // When scope === 'all' without a runId, we simply omit run-artifact profiles.
    }

    const rendered = renderProfileList(allProfiles);

    return {
      content: [{ type: "text", text: rendered }],
      details: { profiles: allProfiles },
    };
  },
};
