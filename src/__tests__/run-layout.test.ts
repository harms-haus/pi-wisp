import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createRunDir, copyWorkflowArtifact, writeGraph } from "../run/layout.js";
import type { GraphIR } from "../types.js";

// ─── Helpers ──────────────────────────────────────────────────────

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wisp-run-layout-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── createRunDir ────────────────────────────────────────────────

describe("createRunDir", () => {
  it("creates a directory named <timecode>-<kebab> under runsDir", () => {
    const runsDir = join(tempDir, "runs");
    mkdirSync(runsDir, { recursive: true });

    const title = "Fix Bugs!";
    const runDir = createRunDir(runsDir, title);

    // The slug portion should be the kebab-cased title appended after
    // the timecode: <timecode>-fix-bugs
    expect(runDir).toBeDefined();
    expect(runDir).toContain("fix-bugs");
    expect(runDir).toMatch(/[/\\]\d{8}-\d{4}-fix-bugs$/);

    // The directory must exist on disk
    expect(existsSync(runDir)).toBe(true);
  });

  it("creates subdirectories: artifacts/, artifacts/profiles/, sessions/", () => {
    const runsDir = join(tempDir, "runs2");
    mkdirSync(runsDir, { recursive: true });

    const runDir = createRunDir(runsDir, "My Workflow");

    // Assert the subdirectory structure exists
    expect(existsSync(join(runDir, "artifacts"))).toBe(true);
    expect(existsSync(join(runDir, "artifacts", "profiles"))).toBe(true);
    expect(existsSync(join(runDir, "sessions"))).toBe(true);
  });

  it("returns the full path to the created run directory", () => {
    const runsDir = join(tempDir, "runs3");
    mkdirSync(runsDir, { recursive: true });

    const runDir = createRunDir(runsDir, "Hello");
    expect(runDir).toBe(join(runsDir, runDir.split("/").pop()!.split("\\").pop()!));
    // Actually just verify it's under runsDir
    expect(runDir.startsWith(runsDir)).toBe(true);
  });

  it("returns distinct directories when called twice in the same minute with the same title", () => {
    const runsDir = join(tempDir, "runs-disambiguate");
    mkdirSync(runsDir, { recursive: true });

    // Freeze time so both createRunDir calls produce the same timecode
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00Z"));

    try {
      const title = "My Cool Workflow";
      const dir1 = createRunDir(runsDir, title);
      const dir2 = createRunDir(runsDir, title);

      // Paths must differ (a disambiguator suffix is needed)
      expect(dir1).not.toBe(dir2);

      // Both directories must exist with the full subdirectory tree
      expect(existsSync(join(dir1, "artifacts", "profiles"))).toBe(true);
      expect(existsSync(join(dir1, "sessions"))).toBe(true);
      expect(existsSync(join(dir2, "artifacts", "profiles"))).toBe(true);
      expect(existsSync(join(dir2, "sessions"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── copyWorkflowArtifact ────────────────────────────────────────

describe("copyWorkflowArtifact", () => {
  it("copies a source file to artifacts/workflow.ts in the run dir", () => {
    const runsDir = join(tempDir, "runs-copy");
    mkdirSync(runsDir, { recursive: true });

    const runDir = join(runsDir, "20250615-1430-test-workflow");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });

    // Create a source file
    const srcPath = join(tempDir, "my-workflow.ts");
    const srcContent = 'export default wf("test", {})\n  .node("a", { profile: "default" });\n';
    writeFileSync(srcPath, srcContent, "utf-8");

    copyWorkflowArtifact(srcPath, runDir);

    const destPath = join(runDir, "artifacts", "workflow.ts");
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf-8")).toBe(srcContent);
  });
});

// ─── writeGraph ──────────────────────────────────────────────────

describe("writeGraph", () => {
  it("writes a parseable JSON file at artifacts/graph.json", () => {
    const runsDir = join(tempDir, "runs-graph");
    mkdirSync(runsDir, { recursive: true });

    const runDir = join(runsDir, "20250615-1430-test-graph");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });

    const ir: GraphIR = {
      title: "Test Graph",
      slug: "test-graph",
      options: {},
      nodes: [
        {
          id: "a",
          kind: "node",
          prompt: "Do something",
          profileRef: "default",
        },
      ],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };

    writeGraph(runDir, ir);

    const graphPath = join(runDir, "artifacts", "graph.json");
    expect(existsSync(graphPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(graphPath, "utf-8")) as GraphIR;
    expect(parsed.title).toBe("Test Graph");
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]?.id).toBe("a");
  });

  it("the written JSON is valid and can be re-parsed", () => {
    const runsDir = join(tempDir, "runs-graph2");
    mkdirSync(runsDir, { recursive: true });

    const runDir = join(runsDir, "20250615-1430-valid-json");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });

    const ir: GraphIR = {
      title: "Valid JSON",
      slug: "valid-json",
      options: { maxConcurrency: 5 },
      nodes: [],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };

    writeGraph(runDir, ir);

    const graphPath = join(runDir, "artifacts", "graph.json");
    const raw = readFileSync(graphPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
