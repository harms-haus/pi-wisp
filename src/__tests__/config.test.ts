import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadConfig } from "../config.js";
import { CONFIG_DEFAULTS, getAgentDir } from "../constants.js";

// ─── Fixtures ─────────────────────────────────────────────────────

const PROJECT_CWD = "/home/user/my-project";
// Derive the global config dir from the real agent dir so the mock path always
// matches what loadConfig() computes (getAgentDir()), regardless of environment.
// Clear PI_AGENT_DIR first so the value is stable across environments.
delete process.env.PI_AGENT_DIR;
const GLOBAL_CONFIG_DIR = getAgentDir();

const PROJECT_CONFIG_PATH = `${PROJECT_CWD}/.wisp/config.json`;
const GLOBAL_CONFIG_PATH = `${GLOBAL_CONFIG_DIR}/wisp.config.json`;

const DEFAULT_PROJECT_CONFIG = {
  maxAgentConcurrency: 6,
  defaultRetries: 1,
};

const DEFAULT_GLOBAL_CONFIG: Record<string, unknown> = {
  maxAgentConcurrency: 4,
  runsDir: "~/project-runs",
  profilesDirs: ["~/shared-profiles"],
};

// ─── FS mock factory ──────────────────────────────────────────────
// Using `vi.mock` at module top level (not nested) as required by vitest.
// We export a helper that sets the file content map before each test.

const fileContentMap: Record<string, string | null> = {};

vi.mock("node:fs", () => ({
  existsSync: vi.fn((path: string) => {
    return fileContentMap[path] !== undefined && fileContentMap[path] !== null;
  }),
  readFileSync: vi.fn((path: string, _encoding?: string) => {
    const content = fileContentMap[path];
    if (content === undefined || content === null) {
      throw new Error(`ENOENT: no such file: ${path}`);
    }
    return content;
  }),
}));

function setFileContent(path: string, content: string | null): void {
  fileContentMap[path] = content;
}

function mockNoConfigs(): void {
  setFileContent(PROJECT_CONFIG_PATH, null);
  setFileContent(GLOBAL_CONFIG_PATH, null);
}

function mockProjectOnly(config: Record<string, unknown>): void {
  setFileContent(PROJECT_CONFIG_PATH, JSON.stringify(config));
  setFileContent(GLOBAL_CONFIG_PATH, null);
}

function mockGlobalOnly(config: Record<string, unknown>): void {
  setFileContent(PROJECT_CONFIG_PATH, null);
  setFileContent(GLOBAL_CONFIG_PATH, JSON.stringify(config));
}

function mockBoth(project: Record<string, unknown>, global: Record<string, unknown>): void {
  setFileContent(PROJECT_CONFIG_PATH, JSON.stringify(project));
  setFileContent(GLOBAL_CONFIG_PATH, JSON.stringify(global));
}

// ─── Tests ────────────────────────────────────────────────────────

describe("loadConfig", () => {
  beforeEach(() => {
    // Clear the file content map before each test
    Object.keys(fileContentMap).forEach((k) => delete fileContentMap[k]);
    // clearAllMocks resets call history but keeps the node:fs factory
    // implementations intact (restoreAllMocks would revert them to real fs).
    vi.clearAllMocks();
    // Ensure getAgentDir() resolves to homedir-based path during every test
    delete process.env.PI_AGENT_DIR;
  });

  // ── missing config files → defaults ───────────────────────────

  it("returns all defaults when neither project nor global config exists", () => {
    mockNoConfigs();

    // EXPECTED CONTRACT: Returns a WispConfig with all default values filled in.
    const config = loadConfig(PROJECT_CWD);

    expect(config.maxAgentConcurrency).toBe(CONFIG_DEFAULTS.maxAgentConcurrency);
    expect(config.defaultRetries).toBe(CONFIG_DEFAULTS.defaultRetries);
    expect(config.retryBackoffMs).toBe(CONFIG_DEFAULTS.retryBackoffMs);
  });

  // ── project overrides global ──────────────────────────────────

  it("project config overrides global config when both exist", () => {
    mockBoth(DEFAULT_PROJECT_CONFIG, DEFAULT_GLOBAL_CONFIG);

    // EXPECTED CONTRACT:
    //   - maxAgentConcurrency = 6 (project value, overrides global 4)
    //   - defaultRetries = 1 (project value)
    //   - runsDir = ~expanded from global (inherited, not overridden by project)
    const config = loadConfig(PROJECT_CWD);

    expect(config.maxAgentConcurrency).toBe(6);
    expect(config.defaultRetries).toBe(1);
  });

  // ── global used when project absent ────────────────────────────

  it("uses global config when project config is absent", () => {
    mockGlobalOnly(DEFAULT_GLOBAL_CONFIG);

    // EXPECTED CONTRACT:
    //   - maxAgentConcurrency = 4 (from global)
    //   - runsDir ~ expanded to absolute path
    const config = loadConfig(PROJECT_CWD);

    expect(config.maxAgentConcurrency).toBe(4);
  });

  // ── ~ expansion ────────────────────────────────────────────────

  it("expands ~ in profilesDirs and runsDir to the home directory", () => {
    mockGlobalOnly({
      runsDir: "~/project-runs",
      profilesDirs: ["~/shared-profiles"],
    });

    // EXPECTED CONTRACT:
    //   - runsDir = "/home/user/project-runs"
    //   - profilesDirs = ["/home/user/shared-profiles"]
    const config = loadConfig(PROJECT_CWD);

    // runsDir/profilesDirs are ~-expanded against the real home directory
    expect(config.runsDir).toBe(join(homedir(), "project-runs"));
    expect(config.profilesDirs).toBeDefined();
    expect(config.profilesDirs![0]).toBe(join(homedir(), "shared-profiles"));
  });

  // ── unknown keys ignored ──────────────────────────────────────

  it("silently ignores unknown keys in config (no throw)", () => {
    mockProjectOnly({
      maxAgentConcurrency: 8,
      unknownKey: "should be ignored",
      anotherUnknown: { nested: true },
    });

    // EXPECTED CONTRACT: returns a valid WispConfig without throwing
    expect(() => loadConfig(PROJECT_CWD)).not.toThrow();
    const config = loadConfig(PROJECT_CWD);
    expect(config.maxAgentConcurrency).toBe(8);
  });

  // ── validation error on invalid value ──────────────────────────

  it("throws a descriptive error when maxAgentConcurrency is not a number", () => {
    mockProjectOnly({
      maxAgentConcurrency: "twelve",
    });

    // EXPECTED CONTRACT: throws an error with a clear type-mismatch message
    expect(() => loadConfig(PROJECT_CWD)).toThrow(/number/i);
  });

  it("throws a descriptive error when retryBackoffMs is negative", () => {
    mockProjectOnly({
      retryBackoffMs: -100,
    });

    // EXPECTED CONTRACT: throws an error describing the invalid range
    expect(() => loadConfig(PROJECT_CWD)).toThrow(/negative|invalid|must be/i);
  });

  // ── malformed JSON ────────────────────────────────────────────

  it("throws an error containing the config file path when project JSON is malformed", () => {
    // Write unparseable JSON to the project config file; leave global absent.
    setFileContent(PROJECT_CONFIG_PATH, `{ "maxAgentConcurrency": , }`);
    setFileContent(GLOBAL_CONFIG_PATH, null);

    // EXPECTED CONTRACT: The thrown Error's message includes the path to
    // the malformed file (<cwd>/.wisp/config.json).
    expect(() => loadConfig(PROJECT_CWD)).toThrow(/\.wisp\/config\.json/);
  });

  // ── inheritance from global ────────────────────────────────────

  it("inherits runsDir and profilesDirs from global when project omits them", () => {
    // Global has both runsDir and profilesDirs; project only sets a
    // concurrency value and intentionally omits those path fields.
    mockBoth(
      { maxAgentConcurrency: 6 },
      {
        runsDir: "~/global-runs",
        profilesDirs: ["~/global-profiles"],
      },
    );

    // EXPECTED CONTRACT: merged config inherits the global path fields
    // because the project config does not override them.
    const config = loadConfig(PROJECT_CWD);

    expect(config.runsDir).toBe(join(homedir(), "global-runs"));
    expect(config.profilesDirs).toEqual([join(homedir(), "global-profiles")]);
  });
});
