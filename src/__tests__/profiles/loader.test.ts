// ═══════════════════════════════════════════════════════════════════════════
// Tests — S5 Profile loader (loader.ts)
//
// These tests document the CONTRACT of the profile loading system.
//
// Reference source ported from:
//   ~/.pi/agent/git/github.com/harms-haus/pi-subagents/src/profiles.ts
//
// Key additions vs pi-subagents:
//   - `agentType` field (default "pi" when absent)
//   - Drop saveProfile/deleteProfile (wisp uses the `write` tool instead)
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseProfileFromFrontmatter,
  loadProfiles,
  validateProfileTools,
  applyExcludeTools,
  lookupProfile,
  invalidateProfilesCache,
} from "../../profiles/loader.js";
import type { WispProfile, WispProfiles } from "../../profiles/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────

/** A fixture frontmatter for a codex profile with all fields populated. */
const CODEX_FRONTMATTER: Record<string, unknown> = {
  name: "codex-reviewer",
  agentType: "codex",
  provider: "openai",
  model: "gpt-4o",
  thinkingLevel: "high",
  tools: "read,bash,grep,edit",
  noExtensions: true,
};

/** A fixture frontmatter for a basic pi profile (no agentType set). */
const BASIC_FRONTMATTER: Record<string, unknown> = {
  name: "basic-worker",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
};

/** A frontmatter with tools as a YAML array (not comma-delimited string). */
const ARRAY_TOOLS_FRONTMATTER: Record<string, unknown> = {
  name: "array-tools-worker",
  tools: ["read", "bash", "grep"],
};

/** A profile body (Markdown content after frontmatter) used as systemPrompt. */
const PROFILE_BODY = "You are an expert code reviewer. Be thorough.";

// ─── Tests ────────────────────────────────────────────────────────

describe("parseProfileFromFrontmatter", () => {
  it("returns a profile with agentType='codex' when frontmatter has agentType: codex", () => {
    // EXPECTED CONTRACT:
    //   parseProfileFromFrontmatter reads agentType from the frontmatter
    //   and returns it verbatim in the profile object.
    const result = parseProfileFromFrontmatter(CODEX_FRONTMATTER, PROFILE_BODY);

    expect(result).toBeDefined();
    expect(result!.agentType).toBe("codex");
    expect(result!.provider).toBe("openai");
    expect(result!.model).toBe("gpt-4o");
    expect(result!.thinkingLevel).toBe("high");
  });

  it("defaults agentType to 'pi' when frontmatter omits agentType", () => {
    // EXPECTED CONTRACT:
    //   When the frontmatter has no agentType field, the parsed profile
    //   defaults agentType to "pi" (matching the v1 pi-only adapter).
    const result = parseProfileFromFrontmatter(BASIC_FRONTMATTER, PROFILE_BODY);

    expect(result).toBeDefined();
    expect(result!.agentType).toBe("pi");
    expect(result!.provider).toBe("anthropic");
    expect(result!.model).toBe("claude-sonnet-4-5");
  });

  it("parses tools from both comma-delimited string and YAML array", () => {
    // EXPECTED CONTRACT:
    //   The `tools` field can be either a comma-separated string or a YAML
    //   array. Both parse to the same string[].
    const stringResult = parseProfileFromFrontmatter(
      { ...CODEX_FRONTMATTER, tools: "read,bash,grep,edit" },
      "body",
    );
    const arrayResult = parseProfileFromFrontmatter({ ...ARRAY_TOOLS_FRONTMATTER }, "body");

    expect(stringResult).toBeDefined();
    expect(stringResult!.tools).toEqual(["read", "bash", "grep", "edit"]);

    expect(arrayResult).toBeDefined();
    expect(arrayResult!.tools).toEqual(["read", "bash", "grep"]);
  });

  it("uses the markdown body as the profile's systemPrompt", () => {
    // EXPECTED CONTRACT:
    //   The Markdown body (everything after the closing `---`) becomes the
    //   profile's `systemPrompt` field. Leading/trailing whitespace is trimmed.
    const result = parseProfileFromFrontmatter(CODEX_FRONTMATTER, PROFILE_BODY);

    expect(result).toBeDefined();
    expect(result!.systemPrompt).toBe(PROFILE_BODY);
  });
});

describe("validateProfileTools", () => {
  it("throws an error when both tools and excludeTools are set (mutually exclusive)", () => {
    // EXPECTED CONTRACT:
    //   A profile must not have both `tools` (allowlist) and `excludeTools`
    //   (blacklist) set at the same time. If it does, validateProfileTools
    //   throws an error whose message includes "mutually exclusive" (or
    //   equivalent diagnostic).
    const badProfile: WispProfile = {
      tools: ["read", "bash"],
      excludeTools: ["write", "edit"],
    };

    expect(() => {
      validateProfileTools(badProfile, "bad-profile");
    }).toThrow(/mutually exclusive/i);
  });

  it("does NOT throw when only tools is set (without excludeTools)", () => {
    // EXPECTED CONTRACT:
    //   A profile with only `tools` (no `excludeTools`) is valid and should
    //   not throw.
    const validProfile: WispProfile = {
      tools: ["read", "bash", "grep"],
    };

    expect(() => {
      validateProfileTools(validProfile, "valid");
    }).not.toThrow();
  });

  it("does NOT throw when only excludeTools is set (without tools)", () => {
    // EXPECTED CONTRACT:
    //   A profile with only `excludeTools` (no `tools`) is valid and should
    //   not throw.
    const validProfile: WispProfile = {
      excludeTools: ["write", "edit"],
    };

    expect(() => {
      validateProfileTools(validProfile, "valid");
    }).not.toThrow();
  });
});

describe("applyExcludeTools", () => {
  it("computes tools as allToolNames minus excludeTools", () => {
    // EXPECTED CONTRACT:
    //   Given a profile with excludeTools and a full set of tool names,
    //   applyExcludeTools returns a new profile with `tools` set to the
    //   computed allowlist and `excludeTools` removed.
    const profile: WispProfile = {
      excludeTools: ["write", "edit"],
    };
    const allTools = ["read", "bash", "grep", "write", "edit"];

    const result = applyExcludeTools(profile, allTools);

    expect(result.tools).toBeDefined();
    expect(result.tools!.sort()).toEqual(["bash", "grep", "read"]);
    expect(result.excludeTools).toBeUndefined();
  });

  it("returns profile unchanged when it has no excludeTools", () => {
    // EXPECTED CONTRACT:
    //   If the profile has no excludeTools, applyExcludeTools is a no-op and
    //   returns the profile as-is.
    const profile: WispProfile = {
      tools: ["read", "bash"],
    };
    const allTools = ["read", "bash", "grep", "write"];

    const result = applyExcludeTools(profile, allTools);

    expect(result.tools).toEqual(["read", "bash"]);
    expect(result.excludeTools).toBeUndefined();
  });
});

describe("loadProfiles TTL cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    invalidateProfilesCache();
  });

  it("returns cached profiles when called again within the 5-second TTL", () => {
    // EXPECTED CONTRACT:
    //   loadProfiles() caches results for 5 seconds (keyed by cwd). A second
    //   call within the TTL must return the identical cached object (same
    //   reference) without re-reading from disk. Advancing time past 5 seconds
    //   forces a fresh read.
    const cwd = "/tmp/test-project";

    // First call — reads from disk and caches
    const first = loadProfiles(cwd);

    // Second call within 5s — must return cached (identical reference)
    const second = loadProfiles(cwd);
    expect(second).toBe(first);

    // Advance past the 5-second TTL
    vi.advanceTimersByTime(5001);

    // Third call after TTL — must re-read from disk (new reference)
    const third = loadProfiles(cwd);
    expect(third).not.toBe(first);
  });
});

describe("lookupProfile (simple lookup)", () => {
  it("returns the profile for a known name from the profiles map", () => {
    // EXPECTED CONTRACT:
    //   Given a populated profiles map, lookupProfile returns the profile
    //   for the given name, or undefined if not found.
    const profiles: WispProfiles = {
      "my-reviewer": { agentType: "pi", provider: "anthropic" },
    };

    const found = lookupProfile(profiles, "my-reviewer");
    expect(found).toBeDefined();
    expect(found!.provider).toBe("anthropic");

    const missing = lookupProfile(profiles, "nonexistent");
    expect(missing).toBeUndefined();
  });
});
