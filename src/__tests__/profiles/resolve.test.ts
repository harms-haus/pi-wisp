// ═══════════════════════════════════════════════════════════════════════════
// Tests — S7 Profile resolution precedence (resolve.ts)
//
// These tests document the CONTRACT of resolving a profile name across
// scopes with strict precedence.
//
// Precedence (most-specific wins):
//   1. Run-artifacts:  <runsDir>/<runId>/artifacts/profiles/*.md
//   2. Project:        <cwd>/.pi/agent-profiles/*.md
//   3. Global:         ~/.pi/agent/agent-profiles/*.md
//   4. Inline:         In-workflow profile definitions (fallback)
//
// The fixture files are materialised into isolated temp directories in
// `beforeAll`, with `PI_AGENT_DIR` overridden so the "global" scope points at a
// throwaway dir (never the real `~/.pi/agent/agent-profiles/`).
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveProfileSync } from "../../profiles/resolve.js";
import type { WispProfile } from "../../profiles/types.js";

// ─── Fixture profiles ─────────────────────────────────────────────

const GLOBAL_PROFILE: WispProfile = {
  agentType: "pi",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
};

const PROJECT_PROFILE: WispProfile = {
  agentType: "pi",
  provider: "openai",
  model: "gpt-4o",
};

const RUN_ARTIFACT_PROFILE: WispProfile = {
  agentType: "codex",
  provider: "openai",
  model: "o3",
};

const INLINE_PROFILE: WispProfile = {
  agentType: "pi",
  provider: "zai",
  model: "glm-5.1",
};

// ─── Fixture filesystem ───────────────────────────────────────────

let tempRoot: string;
let projectCwd: string;
let runDir: string;
let savedAgentDir: string | undefined;

/** Serialize a minimal profile into markdown frontmatter + body. */
function profileMarkdown(profile: WispProfile, name: string): string {
  const lines = ["---", `name: ${name}`];
  if (profile.agentType) lines.push(`agentType: ${profile.agentType}`);
  if (profile.provider) lines.push(`provider: ${profile.provider}`);
  if (profile.model) lines.push(`model: ${profile.model}`);
  lines.push("---", "You are a reviewer.");
  return `${lines.join("\n")}\n`;
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "wisp-resolve-"));

  // Override the global agent dir so profiles are read from temp, never the
  // real ~/.pi/agent/agent-profiles/.
  savedAgentDir = process.env.PI_AGENT_DIR;
  const agentDir = join(tempRoot, "agent");
  const globalProfilesDir = join(agentDir, "agent-profiles");
  mkdirSync(globalProfilesDir, { recursive: true });

  projectCwd = join(tempRoot, "project");
  const projectProfilesDir = join(projectCwd, ".pi", "agent-profiles");
  mkdirSync(projectProfilesDir, { recursive: true });

  runDir = join(tempRoot, "run");
  const runArtifactProfilesDir = join(runDir, "artifacts", "profiles");
  mkdirSync(runArtifactProfilesDir, { recursive: true });

  // "my-reviewer" exists in every on-disk scope so precedence is exercised.
  writeFileSync(
    join(globalProfilesDir, "my-reviewer.md"),
    profileMarkdown(GLOBAL_PROFILE, "my-reviewer"),
  );
  writeFileSync(
    join(projectProfilesDir, "my-reviewer.md"),
    profileMarkdown(PROJECT_PROFILE, "my-reviewer"),
  );
  writeFileSync(
    join(runArtifactProfilesDir, "my-reviewer.md"),
    profileMarkdown(RUN_ARTIFACT_PROFILE, "my-reviewer"),
  );

  process.env.PI_AGENT_DIR = agentDir;
});

afterAll(() => {
  if (savedAgentDir === undefined) {
    delete process.env.PI_AGENT_DIR;
  } else {
    process.env.PI_AGENT_DIR = savedAgentDir;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

// ─── Tests: resolveProfileSync ────────────────────────────────────

describe("resolveProfileSync — scope precedence", () => {
  it("returns the project-local profile when the same name exists in global", () => {
    // EXPECTED CONTRACT:
    //   When a profile name exists in both global and project scopes, the
    //   project-local version wins (higher precedence).
    const result = resolveProfileSync("my-reviewer", {
      cwd: projectCwd,
      inlineProfiles: undefined,
    });

    expect(result).toBeDefined();
    expect(result!.source).toBe("project");
    expect(result!.profile.model).toBe("gpt-4o");
  });

  it("returns the run-artifact profile when the same name exists in all scopes", () => {
    // EXPECTED CONTRACT:
    //   Run-artifact profiles have the highest precedence. When a profile
    //   name exists in all scopes, the run-artifact version wins.
    const result = resolveProfileSync("my-reviewer", {
      cwd: projectCwd,
      runDir,
      inlineProfiles: undefined,
    });

    expect(result).toBeDefined();
    expect(result!.source).toBe("run-artifact");
    expect(result!.profile.model).toBe("o3");
  });

  it("falls back to inline profile when no scoped profile is found", () => {
    // EXPECTED CONTRACT:
    //   When a profile name does not exist in any on-disk scope, the inline
    //   profile (passed via options) is used as the final fallback.
    const inlineMap: Record<string, WispProfile> = {
      "ad-hoc-worker": INLINE_PROFILE,
    };

    const result = resolveProfileSync("ad-hoc-worker", {
      cwd: projectCwd,
      inlineProfiles: inlineMap,
    });

    expect(result).toBeDefined();
    expect(result!.source).toBe("inline");
    expect(result!.profile.model).toBe("glm-5.1");
  });

  it("returns undefined when the profile name is not found in any scope", () => {
    // EXPECTED CONTRACT:
    //   When a profile name does not exist in ANY scope (no global, no
    //   project, no run-artifact, and no inline match), resolveProfileSync
    //   returns undefined.
    const result = resolveProfileSync("nonexistent-profile", {
      cwd: projectCwd,
      inlineProfiles: {},
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined for an unknown name even without inline profiles", () => {
    // EXPECTED CONTRACT:
    //   An unknown name resolves to undefined regardless of which scopes are
    //   configured.
    const result = resolveProfileSync("unknown", {
      cwd: projectCwd,
      inlineProfiles: {},
    });

    expect(result).toBeUndefined();
  });
});
