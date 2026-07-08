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

import { describe, it, expect } from "vitest";
import { parseProfileFromFrontmatter } from "../../profiles/loader.js";

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
