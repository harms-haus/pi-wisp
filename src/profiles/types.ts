// ═══════════════════════════════════════════════════════════════════════════
// Wisp profile types.
//
// Ported from pi-subagents/src/profile-types.ts with the addition of the
// `agentType` field (defaults to "pi" when absent — D3/DECISIONS.md).
//
// The `apiKey` field is retained for compatibility with the ported markdown
// format but is IGNORED by wisp's pi adapter (D3 — configure the harness
// directly).
// ═══════════════════════════════════════════════════════════════════════════

// ─── Thinking level ─────────────────────────────────────────────

/** Extended thinking level values. Matches pi-subagents' ThinkingLevel. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// ─── WispProfile ────────────────────────────────────────────────

/**
 * A named, reusable agent profile.
 *
 * Fields mirror pi-subagents' `SubagentProfile` (for seamless reuse of the
 * existing `~/.pi/agent/agent-profiles/*.md` files), with the addition of
 * `agentType` (default `"pi"`).
 *
 * See `docs/profiles.md` (or pi-subagents `docs/profiles.md`) for the full
 * frontmatter reference.
 */
export interface WispProfile {
  /** Adapter type (default "pi"). Controls which AgentAdapter builds the invocation. */
  agentType?: string;

  /** Provider name (e.g. "anthropic", "openai", "dashscope"). Maps to `--provider`. */
  provider?: string;

  /** Model ID or pattern. Supports `provider/id` format. Maps to `--model`. */
  model?: string;

  /** Replace the default system prompt entirely. Sourced from the Markdown body. */
  systemPrompt?: string;

  /** Append text to the default system prompt. */
  appendSystemPrompt?: string;

  /** Extended thinking level: off, minimal, low, medium, high, xhigh. */
  thinkingLevel?: ThinkingLevel;

  /** Disable all tools. */
  noTools?: boolean;

  /** Comma-separated allowlist of tool names to enable. */
  tools?: string[];

  /** Blacklist of tool names to exclude from the full set. */
  excludeTools?: string[];

  /** Disable all extensions. */
  noExtensions?: boolean;

  /** Extension paths to load (one `--extension` flag per entry). */
  extensions?: string[];

  /** Disable skills. */
  noSkills?: boolean;

  /** Skill names to suggest to the agent via `--skill` (model chooses to load). */
  suggestedSkills?: string[];

  /** Skill names to pre-load (content injected into appendSystemPrompt). */
  loadSkills?: string[];

  /** Disable context files (AGENTS.md, CLAUDE.md). */
  noContextFiles?: boolean;

  /**
   * Custom API key.
   *
   * ⚠️ WISP IGNORES THIS FIELD (D3 / DECISIONS.md). The pi adapter does NOT
   * forward it. Retained for compatibility with the ported profile markdown
   * format. Configure the harness (pi auth, provider env vars) directly.
   */
  apiKey?: string;

  /** Additional CLI arguments passed verbatim to the subprocess. */
  extraArgs?: string[];
}

/** A map of profile names to their resolved profiles. */
export interface WispProfiles {
  [name: string]: WispProfile;
}

/** Source scope from which a profile was resolved. */
export type ProfileSource = "inline" | "global" | "project" | "run-artifact";

/**
 * A profile together with metadata about where it was resolved from.
 */
export interface ResolvedProfile {
  profile: WispProfile;
  source: ProfileSource;
  filePath?: string;
}

// ─── ProfileInvocation ───────────────────────────────────────────

/**
 * Result of converting a profile to subprocess invocation parameters.
 */
export interface ProfileInvocation {
  args: string[];
  env: Record<string, string>;
}
