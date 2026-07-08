// ═══════════════════════════════════════════════════════════════════════════
// DSL compile — compileWorkflow contract (S16, ⚠️ RISK).
//
// Tests the compile step's five contracts:
//   (a) Valid workflow fixture → { ir: GraphIR } with expected nodes
//   (b) Syntax-error fixture   → { error: { kind: "compile", ... } }
//   (c) Runtime-throw fixture  → { error: { kind: "runtime", ... } }
//   (d) Import rewrite helper  → rewritten source contains file:// URL
//   (e) Invalid-cycle fixture  → { error: { kind: "validation", errors: [...] } }
//
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

import { compileWorkflow, rewriteImport } from "../../dsl/compile.js";
import type { CompileInput } from "../../dsl/compile.js";
import type { GraphIR } from "../../types.js";

// ─── Fixture paths ─────────────────────────────────────────────────

/**
 * Absolute path to the test fixtures directory.
 */
const FIXTURES_DIR = new URL("./fixtures/", import.meta.url).pathname;

/**
 * Synthesised absolute paths for the builder and harness — these are the
 * values that the extension entrypoint (src/index.ts) would compute at
 * registration time via `fileURLToPath(new URL(...))`.
 *
 * Tests pass these as the `builderPath` / `harnessPath` fields of CompileInput.
 */
const BUILDER_PATH = new URL("../../dsl/builder.ts", import.meta.url).pathname;
const HARNESS_PATH = new URL("../../dsl/compile-harness.ts", import.meta.url).pathname;

// ─── Helpers ───────────────────────────────────────────────────────

/** Build a CompileInput for a fixture file. */
function fixtureInput(fixtureName: string): CompileInput {
  return {
    scriptPath: `${FIXTURES_DIR}${fixtureName}`,
    builderPath: BUILDER_PATH,
    harnessPath: HARNESS_PATH,
  };
}

/**
 * Assert that a result is a success with a GraphIR that has at least one node.
 * Returns the IR for further assertions.
 */
function expectSuccess(result: unknown): asserts result is { ir: GraphIR } {
  expect(result).toHaveProperty("ir");
  const ir = (result as { ir: GraphIR }).ir;
  expect(ir).toHaveProperty("nodes");
  expect(ir).toHaveProperty("edges");
  expect(ir).toHaveProperty("title");
  expect(ir).toHaveProperty("slug");
  expect(Array.isArray(ir.nodes)).toBe(true);
  expect(Array.isArray(ir.edges)).toBe(true);
}

/**
 * Assert that a result is an error with the given kind.
 * Returns the error for further assertions.
 */
interface ErrorShape {
  kind: string;
  message: string;
  location?: string;
  errors?: unknown[];
}

function expectError(
  result: unknown,
  kind: "compile" | "validation" | "runtime",
): asserts result is { error: ErrorShape } {
  expect(result).toHaveProperty("error");
  const err = (result as { error: Record<string, unknown> }).error;
  expect(err.kind).toBe(kind);
  expect(typeof err.message).toBe("string");
  expect((err.message as string).length).toBeGreaterThan(0);
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("compileWorkflow", () => {
  // ── (a) Valid workflow → GraphIR ──────────────────────────────

  describe("(a) valid workflow", () => {
    it("returns { ir: GraphIR } with the expected nodes when given a valid workflow script", async () => {
      const result = await compileWorkflow(fixtureInput("valid-workflow.ts"));
      expectSuccess(result);

      // The valid-workflow fixture defines step1 → step2
      const ir = result.ir;
      expect(ir.title).toBe("valid-workflow");
      expect(ir.slug).toBe("valid-workflow");

      // Must contain exactly two nodes
      expect(ir.nodes).toHaveLength(2);

      // Node ids: step1, step2
      const ids = ir.nodes.map((n) => n.id).sort();
      expect(ids).toEqual(["step1", "step2"]);

      // step1 has a static prompt
      const step1 = ir.nodes.find((n) => n.id === "step1");
      expect(step1).toBeDefined();
      expect(step1!.kind).toBe("node");

      // step2 depends on step1
      const step2 = ir.nodes.find((n) => n.id === "step2");
      expect(step2).toBeDefined();
      expect(step2!.kind).toBe("node");
      expect(step2!.dependsOn).toEqual(["step1"]);

      // At least one edge: step1 → step2 (dep)
      const depEdge = ir.edges.find(
        (e) => e.from === "step1" && e.to === "step2" && e.kind === "dep",
      );
      expect(depEdge).toBeDefined();
    });

    it("returns a GraphIR with valid edges and conditions arrays (not undefined)", async () => {
      const result = await compileWorkflow(fixtureInput("valid-workflow.ts"));
      expectSuccess(result);
      const ir = result.ir;
      // Edge and condition arrays are always present and well-formed
      expect(ir.edges).toBeDefined();
      expect(Array.isArray(ir.edges)).toBe(true);
      expect(ir.conditions).toBeDefined();
      expect(Array.isArray(ir.conditions)).toBe(true);
      // No inline profiles unless the fixture registered one
      expect(ir.inlineProfiles).toBeDefined();
    });
  });

  // ── (b) Syntax error → compile error ──────────────────────────

  describe("(b) syntax error", () => {
    it("returns { error: { kind: 'compile', message, location? } } when the script has a syntax error", async () => {
      const result = await compileWorkflow(fixtureInput("syntax-error.ts"));
      expectError(result, "compile");
      const err = result.error;
      // The error should include a hint about the nature of the syntax problem
      expect(err.message).toMatch(/expected|unexpected|missing|SyntaxError/i);
      // A location (file:line:col) should be present when the parser can report one.
      if (err.location) {
        expect(typeof err.location).toBe("string");
      }
    });

    it("records a meaningful line number in the location string when available", async () => {
      const result = await compileWorkflow(fixtureInput("syntax-error.ts"));
      expectError(result, "compile");
      const err = result.error;
      // The location should be a file:line:col string (or at least include a number)
      if (err.location) {
        expect(err.location).toMatch(/:\d+:\d+$/);
      }
    });
  });

  // ── (c) Runtime throw → runtime error ─────────────────────────

  describe("(c) runtime throw", () => {
    it("returns { error: { kind: 'runtime', message } } when the script throws at module evaluation", async () => {
      const result = await compileWorkflow(fixtureInput("runtime-throw.ts"));
      expectError(result, "runtime");
      const err = result.error;
      // The error message should contain the thrown string or a reference to it
      expect(err.message).toMatch(/module evaluation failed|runtime error/i);
    });

    it("captures the full thrown error message (not a generic 'script failed')", async () => {
      const result = await compileWorkflow(fixtureInput("runtime-throw.ts"));
      expectError(result, "runtime");
      // "module evaluation failed" — the exact message thrown by the fixture
      expect(result.error.message).toMatch(/module evaluation failed/);
    });
  });

  // ── (d) Import rewrite ────────────────────────────────────────

  describe("(d) import rewrite (rewriteImport)", () => {
    it('replaces `from "pi-wisp"` with `from "<fileURL>"` (double quotes)', () => {
      const source = `import { wf } from "pi-wisp";\nexport default wf("test");`;
      const fileUrl = "file:///home/user/wisp/src/dsl/builder.ts";

      const rewritten = rewriteImport(source, fileUrl);

      // The rewritten source must NOT contain the bare specifier "pi-wisp"
      expect(rewritten).not.toContain('"pi-wisp"');
      // It must contain the file:// URL
      expect(rewritten).toContain(fileUrl);
      // Other parts must be preserved
      expect(rewritten).toContain("import { wf } from");
      expect(rewritten).toContain('export default wf("test")');
    });

    it("replaces `from 'pi-wisp'` with `from '<fileURL>'` (single quotes)", () => {
      const source = `import { wf } from 'pi-wisp';\nexport default wf("test");`;
      const fileUrl = "file:///home/user/wisp/src/dsl/builder.ts";

      const rewritten = rewriteImport(source, fileUrl);

      expect(rewritten).not.toContain("'pi-wisp'");
      expect(rewritten).toContain(fileUrl);
      // Quote style should be preserved (single quotes stay single)
      expect(rewritten).toContain(`from '`);
    });

    it('handles default imports: `import wf from "pi-wisp"`', () => {
      const source = `import wf from "pi-wisp";\nexport default wf("test");`;
      const fileUrl = "file:///home/user/wisp/src/dsl/builder.ts";

      const rewritten = rewriteImport(source, fileUrl);

      expect(rewritten).not.toContain('"pi-wisp"');
      expect(rewritten).toContain(fileUrl);
    });

    it('handles namespace imports: `import * as wisp from "pi-wisp"`', () => {
      const source = `import * as wisp from "pi-wisp";\nwisp.wf("test");`;
      const fileUrl = "file:///home/user/wisp/src/dsl/builder.ts";

      const rewritten = rewriteImport(source, fileUrl);

      expect(rewritten).not.toContain('"pi-wisp"');
      expect(rewritten).toContain(fileUrl);
    });

    it('handles dynamic imports: `import("pi-wisp")`', () => {
      const source = `const wisp = await import("pi-wisp");\nwisp.wf("test");`;
      const fileUrl = "file:///home/user/wisp/src/dsl/builder.ts";

      const rewritten = rewriteImport(source, fileUrl);

      expect(rewritten).not.toContain('"pi-wisp"');
      expect(rewritten).toContain(fileUrl);
    });

    it("preserves surrounding code and whitespace when rewriting", () => {
      const source = [
        "// @ts-check",
        'import { wf, type WorkflowBuilder } from "pi-wisp";',
        'import { readFile } from "node:fs/promises"; // unrelated import',
        "",
        'export default wf("my-workflow")',
        '  .node("a", { prompt: "First" });',
        "",
      ].join("\n");
      const fileUrl = "file:///home/user/wisp/src/dsl/builder.ts";

      const rewritten = rewriteImport(source, fileUrl);

      // The pi-wisp specifier is replaced
      expect(rewritten).not.toContain('"pi-wisp"');
      expect(rewritten).toContain(fileUrl);
      // The unrelated node:fs/promises import is untouched
      expect(rewritten).toContain('"node:fs/promises"');
      // Comments and code are preserved
      expect(rewritten).toContain("@ts-check");
      expect(rewritten).toContain('"First"');
      expect(rewritten).toContain("my-workflow");
    });

    it("does nothing when the source contains no pi-wisp import", () => {
      const source = `import { readFile } from "node:fs";\nconsole.log("no wisp here");`;
      const fileUrl = "file:///home/user/wisp/src/dsl/builder.ts";

      const rewritten = rewriteImport(source, fileUrl);

      // Source should be returned as-is
      expect(rewritten).toBe(source);
    });

    // ── (a) SUBPATH import rewrite ────────────────────────────────────
    //
    // Subpath imports like "pi-wisp/macros" must also be rewritten to the
    // builder file:// URL (not left as bare specifier).

    it('rewrites subpath imports: `from "pi-wisp/macros"` → builder URL', () => {
      const source = `import { x } from "pi-wisp/macros";\nexport default wf("test");`;
      const fileUrl = "file:///home/user/wisp/src/dsl/builder.ts";

      const rewritten = rewriteImport(source, fileUrl);

      // The subpath specifier must NOT remain as bare "pi-wisp/macros"
      expect(rewritten).not.toContain('"pi-wisp/macros"');
      // It should contain the builder URL (as "from \"<fileUrl>\"")
      expect(rewritten).toContain(fileUrl);
      // Surrounding code preserved
      expect(rewritten).toContain("import { x } from");
      expect(rewritten).toContain('export default wf("test")');
    });

    // ── (b) NON-IMPORT occurrences NOT rewritten ──────────────────────
    //
    // `pi-wisp` appearing inside a comment or a string literal that is not
    // an import specifier must be left unchanged.

    it("does NOT rewrite `pi-wisp` inside comments or string literals", () => {
      const source = [
        "// see pi-wisp docs for more details",
        'const pkg = "pi-wisp";',
        'import { wf } from "pi-wisp";',
        'export default wf("test");',
      ].join("\n");
      const fileUrl = "file:///home/user/wisp/src/dsl/builder.ts";

      const rewritten = rewriteImport(source, fileUrl);

      // The real import specifier IS rewritten
      expect(rewritten).not.toContain('from "pi-wisp"');
      expect(rewritten).toContain('from "' + fileUrl + '"');

      // The comment (containing bare pi-wisp without surrounding quotes) is
      // preserved — this part already works because replaceAll only matches
      // the quoted form.
      expect(rewritten).toContain("// see pi-wisp docs for more details");

      // The string literal MUST stay unchanged (this is the bug: the naive
      // replaceAll also replaces this occurrence).
      expect(rewritten).toContain('const pkg = "pi-wisp"');
    });
  });

  // ── (e) Invalid cycle → validation error ──────────────────────

  describe("(e) invalid cycle", () => {
    it("returns { error: { kind: 'validation', errors: [...] } } when the graph has a cycle", async () => {
      const result = await compileWorkflow(fixtureInput("invalid-cycle.ts"));
      expectError(result, "validation");
      const err = result.error;
      // The validation error must carry a sub-errors array
      expect(err).toHaveProperty("errors");
      expect(Array.isArray((err as { errors: unknown[] }).errors)).toBe(true);
      expect((err as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
      // At least one of the sub-errors should mention the cycle or the nodes involved
      const subErrors = (err as { errors: Array<{ message: string }> }).errors;
      const cycleMsg = subErrors.find((se) => /cycle|circular|a.*b.*a/i.test(se.message));
      expect(cycleMsg).toBeDefined();
    });
  });
});

// ─── Edge cases ────────────────────────────────────────────────────

describe("compileWorkflow — edge cases", () => {
  it("rejects when neither scriptSource nor scriptPath is provided", async () => {
    const input: CompileInput = {
      scriptSource: undefined,
      scriptPath: undefined,
      builderPath: BUILDER_PATH,
      harnessPath: HARNESS_PATH,
    };
    await expect(compileWorkflow(input)).rejects.toThrow();
  });

  it("rejects when builderPath is empty or invalid", async () => {
    const input: CompileInput = {
      scriptPath: `${FIXTURES_DIR}valid-workflow.ts`,
      builderPath: "",
      harnessPath: HARNESS_PATH,
    };
    await expect(compileWorkflow(input)).rejects.toThrow();
  });

  it("rejects when harnessPath is empty or invalid", async () => {
    const input: CompileInput = {
      scriptPath: `${FIXTURES_DIR}valid-workflow.ts`,
      builderPath: BUILDER_PATH,
      harnessPath: "",
    };
    await expect(compileWorkflow(input)).rejects.toThrow();
  });

  // ── (c) MISSING scriptPath → structured error ─────────────────────
  //
  // A non-existent scriptPath should return
  // { error: { kind: "compile", message: "...not found..." } } — not
  // throw a raw ENOENT from readFileSync.

  it("returns structured compile error (not raw ENOENT) when scriptPath does not exist", async () => {
    const result = await compileWorkflow({
      scriptPath: "/nonexistent/file/workflow.ts",
      builderPath: BUILDER_PATH,
      harnessPath: HARNESS_PATH,
      // scriptSource deliberately omitted → reads from scriptPath
    }).catch((e: unknown) => ({
      error: { kind: "throw", message: String(e) },
    }));

    // The result must be a structured error, not an uncaught rejection
    expect(result).toHaveProperty("error");
    const err = (result as { error: { kind: string; message: string } }).error;
    // The kind should be "compile" (not "throw" — which is our catch marker)
    expect(err.kind).toBe("compile");
    // The message should indicate that the file was not found
    expect(err.message.toLowerCase()).toMatch(/not found|enoent|no such/i);
  });

  // ── (d) RELATIVE path rejection ────────────────────────────────────
  //
  // A relative builderPath or harnessPath must be rejected with a clear
  // error (e.g. "builderPath must be an absolute path") — not an opaque
  // spawn ENOENT.

  it("rejects relative harnessPath with a clear error (not opaque ENOENT)", async () => {
    const result = await compileWorkflow({
      scriptPath: `${FIXTURES_DIR}valid-workflow.ts`,
      builderPath: BUILDER_PATH,
      harnessPath: "relative/path/compile-harness.ts",
    }).catch((e: unknown) => ({
      error: { kind: "throw", message: String(e) },
    }));

    expect(result).toHaveProperty("error");
    const err = (result as { error: { kind: string; message: string } }).error;
    expect(err.kind).toBe("compile");
    // The error message should clearly indicate that relative paths are
    // not allowed, not just "ENOENT: no such file or directory"
    expect(err.message.toLowerCase()).toMatch(/relative|must be absolute/i);
  });
});
