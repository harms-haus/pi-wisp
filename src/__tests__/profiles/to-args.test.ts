// ═══════════════════════════════════════════════════════════════════════════
// Tests — S6 Profile-to-args (to-args.ts)
//
// These tests document the CONTRACT of converting a WispProfile into
// subprocess invocation parameters, including the extraArgs override-guard
// security checks.
//
// Reference source ported from:
//   ~/.pi/agent/git/github.com/harms-haus/pi-subagents/src/profiles.ts
//   (profileToArgs, pushBasicArgs, pushSkillArgs, pushExtraArgs,
//    isDangerousFlag, isWithinDir)
//
// CRITICAL (D3 / DECISIONS.md):
//   - The pi adapter does NOT set PI_API_KEY or pass --api-key.
//   - The `apiKey` field is parsed by loader.ts (for compatibility) but
//     to-args.ts MUST ignore it.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
  profileToArgs,
  isDangerousFlag,
  pushExtraArgs,
  resolveExcludeTools,
} from "../../profiles/to-args.js";
import type { WispProfile } from "../../profiles/types.js";

// ─── Tests: profileToArgs ─────────────────────────────────────────

describe("profileToArgs", () => {
  it("emits correct --flag value pairs for a fully-populated profile", () => {
    // EXPECTED CONTRACT:
    //   profileToArgs maps profile fields to their corresponding CLI flags:
    //     provider      → --provider <value>
    //     model         → --model <value>
    //     systemPrompt  → --system-prompt <value>
    //     thinkingLevel → --thinking <value>
    //     tools         → --tools <comma-separated>
    const profile: WispProfile = {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      systemPrompt: "You are a code reviewer.",
      thinkingLevel: "high",
      tools: ["read", "bash", "grep"],
    };

    const result = profileToArgs(profile);

    expect(result.args).toContain("--provider");
    expect(result.args[result.args.indexOf("--provider") + 1]).toBe("anthropic");
    expect(result.args).toContain("--model");
    expect(result.args[result.args.indexOf("--model") + 1]).toBe("claude-sonnet-4-5");
    expect(result.args).toContain("--system-prompt");
    expect(result.args[result.args.indexOf("--system-prompt") + 1]).toBe(
      "You are a code reviewer.",
    );
    expect(result.args).toContain("--thinking");
    expect(result.args[result.args.indexOf("--thinking") + 1]).toBe("high");
    expect(result.args).toContain("--tools");
    expect(result.args[result.args.indexOf("--tools") + 1]).toBe("read,bash,grep");
  });

  it("includes --no-tools when profile.noTools is true", () => {
    // EXPECTED CONTRACT:
    //   When noTools is true, emit --no-tools and omit --tools.
    const profile: WispProfile = {
      noTools: true,
    };

    const result = profileToArgs(profile);
    expect(result.args).toContain("--no-tools");
    expect(result.args).not.toContain("--tools");
  });

  it("includes --extension flags for each entry in extensions", () => {
    // EXPECTED CONTRACT:
    //   Each entry in extensions maps to one --extension flag.
    const profile: WispProfile = {
      extensions: ["/path/to/ext1.js", "/path/to/ext2.js"],
    };

    const result = profileToArgs(profile);
    expect(result.args).toContain("--extension");
    // Should have two --extension flags
    const extIndices = result.args
      .map((a, i) => (a === "--extension" ? i : -1))
      .filter((i) => i >= 0);
    expect(extIndices).toHaveLength(2);
  });

  it("maps noExtensions, noSkills, noContextFiles to their boolean flags", () => {
    // EXPECTED CONTRACT:
    //   Boolean flags emit without values: --no-extensions, --no-skills,
    //   --no-context-files.
    const profile: WispProfile = {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
    };

    const result = profileToArgs(profile);
    expect(result.args).toContain("--no-extensions");
    expect(result.args).toContain("--no-skills");
    expect(result.args).toContain("--no-context-files");
  });

  // ═════════════════════════════════════════════════════════════════
  // D3 CRITICAL: NO api-key handling in wisp
  // ═════════════════════════════════════════════════════════════════

  it("D3: does NOT include --api-key in args when profile has apiKey set", () => {
    // EXPECTED CONTRACT (D3 / DECISIONS.md):
    //   The `apiKey` field is retained for profile format compatibility but
    //   to-args MUST NOT emit --api-key. The returned args array must not
    //   contain "--api-key" at any position.
    const profile: WispProfile = {
      apiKey: "sk-test-abc123",
    };

    const result = profileToArgs(profile);
    expect(result.args).not.toContain("--api-key");
    // Also check no partial match (e.g. --api-key=...)
    expect(result.args.some((a) => a.startsWith("--api-key"))).toBe(false);
  });

  it("D3: does NOT set PI_API_KEY in the returned env object", () => {
    // EXPECTED CONTRACT (D3 / DECISIONS.md):
    //   The pi adapter does NOT forward credentials. Even when the profile
    //   has apiKey set, the env object returned by profileToArgs must NOT
    //   contain "PI_API_KEY". Configure the harness directly instead.
    const profile: WispProfile = {
      apiKey: "sk-test-abc123",
    };

    const result = profileToArgs(profile);
    expect(result.env).toBeDefined();
    expect(result.env.PI_API_KEY).toBeUndefined();
  });
});

// ─── Tests: isDangerousFlag ──────────────────────────────────────

describe("isDangerousFlag", () => {
  it("returns true for --tools", () => {
    expect(isDangerousFlag("--tools")).toBe(true);
  });

  it("returns true for --tools=<value>", () => {
    expect(isDangerousFlag("--tools=read,bash")).toBe(true);
  });

  it("returns true for -t", () => {
    expect(isDangerousFlag("-t")).toBe(true);
  });

  it("returns true for -t=<value>", () => {
    expect(isDangerousFlag("-t=read")).toBe(true);
  });

  it("returns true for --no-tools", () => {
    expect(isDangerousFlag("--no-tools")).toBe(true);
  });

  it("returns true for --no-tools=<value>", () => {
    expect(isDangerousFlag("--no-tools=true")).toBe(true);
  });

  it("returns false for benign flags like --verbose", () => {
    expect(isDangerousFlag("--verbose")).toBe(false);
    expect(isDangerousFlag("--model")).toBe(false);
    expect(isDangerousFlag("--provider")).toBe(false);
  });
});

// ─── Tests: pushExtraArgs security ───────────────────────────────

describe("pushExtraArgs — security validation", () => {
  it("rejects an extraArg that is a tool-override flag when tool restrictions are active", () => {
    // EXPECTED CONTRACT:
    //   When the profile has tool restrictions (tools, excludeTools, or
    //   noTools), extraArgs may not contain --tools, -t, --no-tools, or
    //   their = forms. The error message should mention the specific arg.
    const profile: WispProfile = {
      tools: ["read", "bash"],
      extraArgs: ["--verbose", "--tools", "write"],
    };

    expect(() => {
      pushExtraArgs([], profile);
    }).toThrow(/--tools/i);
  });

  it("rejects an extraArg containing a null byte", () => {
    // EXPECTED CONTRACT:
    //   Any extraArg containing \0 (null byte) is rejected.
    const profile: WispProfile = {
      extraArgs: ["malformed\0arg"],
    };

    expect(() => {
      pushExtraArgs([], profile);
    }).toThrow(/null byte/i);
  });

  it("rejects an extraArg starting with shell metacharacters like ; or |", () => {
    // EXPECTED CONTRACT:
    //   An extraArg starting with shell operators (;, |, &, etc.) or
    //   containing command separators (&&, ||) is rejected as unsafe.
    const profile: WispProfile = {
      extraArgs: ["; rm -rf /"],
    };

    expect(() => {
      pushExtraArgs([], profile);
    }).toThrow(/unsafe/i);
  });

  it("rejects an extraArg containing && command separator", () => {
    const profile: WispProfile = {
      extraArgs: ["&& echo hacked"],
    };

    expect(() => {
      pushExtraArgs([], profile);
    }).toThrow(/unsafe/i);
  });

  it("allows benign extraArgs when no tool restrictions are active", () => {
    // EXPECTED CONTRACT:
    //   Benign flags like --verbose, --max-tokens=1000 pass through when
    //   there are no tool restrictions.
    const profile: WispProfile = {
      extraArgs: ["--verbose", "--max-tokens=1000"],
    };

    const args: string[] = [];
    expect(() => {
      pushExtraArgs(args, profile);
    }).not.toThrow();
  });

  // ═════════════════════════════════════════════════════════════════
  // Extension / skill override-guard
  // ═════════════════════════════════════════════════════════════════

  it("rejects --extension and --skill extraArgs when noExtensions/noSkills are active", () => {
    // EXPECTED CONTRACT:
    //   When noExtensions is true, extraArgs may NOT contain --extension.
    //   When noSkills is true, extraArgs may NOT contain --skill.
    //   The override-guard (isDangerousFlag) must block these flags when
    //   the corresponding restriction is active.
    expect(() => {
      pushExtraArgs([], {
        noExtensions: true,
        extraArgs: ["--extension", "/evil"],
      });
    }).toThrow();
    expect(() => {
      pushExtraArgs([], {
        noSkills: true,
        extraArgs: ["--skill", "/evil"],
      });
    }).toThrow();
  });

  // ═════════════════════════════════════════════════════════════════
  // Short-form override-flag guards
  // ═════════════════════════════════════════════════════════════════

  it("rejects short form -e when noExtensions is active", () => {
    // EXPECTED CONTRACT:
    //   Short form -e (equivalent to --extension) is blocked when
    //   noExtensions restricts extension overrides.
    expect(() => {
      pushExtraArgs([], {
        noExtensions: true,
        extraArgs: ["-e", "/evil"],
      });
    }).toThrow();
  });

  it("rejects short form -ne when noExtensions is active", () => {
    // EXPECTED CONTRACT:
    //   Short form -ne (equivalent to --no-extensions) is blocked when
    //   noExtensions restricts extension overrides.
    expect(() => {
      pushExtraArgs([], {
        noExtensions: true,
        extraArgs: ["-ne"],
      });
    }).toThrow();
  });

  it("rejects short form -ns when noSkills is active", () => {
    // EXPECTED CONTRACT:
    //   Short form -ns (equivalent to --no-skills) is blocked when
    //   noSkills restricts skill overrides.
    expect(() => {
      pushExtraArgs([], {
        noSkills: true,
        extraArgs: ["-ns"],
      });
    }).toThrow();
  });

  it("rejects short form -nc when noContextFiles is active", () => {
    // EXPECTED CONTRACT:
    //   Short form -nc (equivalent to --no-context-files) is blocked
    //   when noContextFiles restricts context-file overrides.
    expect(() => {
      pushExtraArgs([], {
        noContextFiles: true,
        extraArgs: ["-nc"],
      });
    }).toThrow();
  });

  it("rejects short form -xt when tool restrictions are active", () => {
    // EXPECTED CONTRACT:
    //   Short form -xt (equivalent to --exclude-tools) is blocked when
    //   tool restrictions (tools, excludeTools, or noTools) are active.
    expect(() => {
      pushExtraArgs([], {
        tools: ["read", "bash"],
        extraArgs: ["-xt", "write"],
      });
    }).toThrow();
  });

  it("rejects --skill with path outside allowed directory even when shell-metachar regex passes", () => {
    // EXPECTED CONTRACT:
    //   A --skill value whose path is OUTSIDE the project/allowed dir must
    //   be rejected by isWithinDir, even if the path does not contain shell
    //   metacharacters (thus passing the shell-metachar regex). With no
    //   allowed dir configured, containment cannot be verified and the
    //   value is refused outright.
    expect(() => {
      pushExtraArgs([], {
        extraArgs: ["--skill", "/outside/project/evil.sh"],
      });
    }).toThrow();
  });
});

// ─── Tests: resolveExcludeTools ───────────────────────────────────

describe("resolveExcludeTools", () => {
  it("returns tools list as allToolNames minus excludeTools", () => {
    // EXPECTED CONTRACT:
    //   resolveExcludeTools performs the excludeTools computation:
    //   result = allToolNames.filter(t => !excludeSet.has(t))
    const profile: WispProfile = {
      excludeTools: ["write", "edit", "bash"],
    };
    const allTools = ["read", "bash", "grep", "write", "edit", "find"];

    const result = resolveExcludeTools(profile, allTools);

    expect(result).toBeDefined();
    expect(result!.sort()).toEqual(["find", "grep", "read"]);
  });

  it("returns profile.tools when profile already has tools (not excludeTools)", () => {
    // EXPECTED CONTRACT:
    //   If the profile already has `tools` set (not using excludeTools),
    //   return profile.tools as-is.
    const profile: WispProfile = {
      tools: ["read", "bash"],
    };
    const allTools = ["read", "bash", "grep", "write"];

    const result = resolveExcludeTools(profile, allTools);
    expect(result).toEqual(["read", "bash"]);
  });

  it("returns undefined when neither tools nor excludeTools is set", () => {
    // EXPECTED CONTRACT:
    //   If the profile has no tool restrictions at all, return undefined.
    const profile: WispProfile = {};

    const result = resolveExcludeTools(profile, ["read", "bash"]);
    expect(result).toBeUndefined();
  });
});
