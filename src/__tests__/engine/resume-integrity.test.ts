/**
 * Integrity behaviour at the resume boundary: prepareResume must reject an
 * unsigned or tampered on-disk graph before trusting (and rehydrating) it.
 *
 * The signing key is pinned to a per-process temp file by setup.ts, so these
 * fixtures share the same key the production writeGraph/prepareResume path uses.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { prepareResume } from "../../engine/resume.js";
import { writeGraph } from "../../run/layout.js";
import type { GraphIR } from "../../types.js";

const graph: GraphIR = {
  title: "integrity",
  slug: "integrity",
  options: {},
  nodes: [{ id: "a", kind: "node", prompt: "A" }],
  edges: [],
  conditions: [],
  schemas: {},
  primitives: {},
};

describe("prepareResume — graph integrity (HMAC)", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "wisp-resume-integrity-"));
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
  });
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  it("refuses to resume an unsigned graph (signature file missing)", () => {
    writeFileSync(join(runDir, "artifacts", "graph.json"), JSON.stringify(graph, null, 2));
    expect(() => prepareResume(runDir)).toThrow(/signature not found|unsigned/i);
  });

  it("refuses to resume a tampered graph (signature mismatch)", () => {
    writeGraph(runDir, graph);
    // Mutate graph.json AFTER it was signed.
    const tampered = { ...graph, title: "evil" };
    writeFileSync(join(runDir, "artifacts", "graph.json"), JSON.stringify(tampered, null, 2));
    expect(() => prepareResume(runDir)).toThrow(/verification failed|tampered/i);
  });

  it("accepts a properly signed graph (advances past the integrity check)", () => {
    writeGraph(runDir, graph);
    // Signature accepted -> prepareResume proceeds and reports the next missing
    // artifact (run.json) rather than a signature error, proving the signed
    // graph was trusted.
    expect(() => prepareResume(runDir)).toThrow(/run\.json not found/);
  });
});
