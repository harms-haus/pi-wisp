// ═══════════════════════════════════════════════════════════════════════════
// Import-rewrite characterization — rewriteImport() extracted into
// import-rewrite.ts (moved out of compile.ts).
//
// The refactor moves the import-specifier rewriter into its own focused
// module. These tests pin the EXACT current behavior so the extraction is
// provably behavior-preserving: every quote style, import form, subpath,
// whitespace variant, and non-import safety property must hold from the new
// home exactly as it did in compile.ts.
//
// They are RED until src/dsl/import-rewrite.ts exists and exports rewriteImport.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

// New focused module (RED until it exists):
import { rewriteImport } from "../../dsl/import-rewrite.js";

// ─── Shared fixture ────────────────────────────────────────────────

/** A canonical builder file:// URL used across all rewrite assertions. */
const BUILDER_URL = "file:///home/user/wisp/src/dsl/builder.ts";

// ─── Tests ─────────────────────────────────────────────────────────

describe("rewriteImport — static imports (from ...)", () => {
  it("rewrites a double-quoted named import, preserving the quote style", () => {
    const out = rewriteImport(`import { wf } from "pi-wisp";`, BUILDER_URL);
    expect(out).toBe(`import { wf } from "${BUILDER_URL}";`);
  });

  it("rewrites a single-quoted named import, preserving the quote style", () => {
    const out = rewriteImport(`import { wf } from 'pi-wisp';`, BUILDER_URL);
    expect(out).toBe(`import { wf } from '${BUILDER_URL}';`);
  });

  it("rewrites a backtick-quoted named import, preserving the quote style", () => {
    const out = rewriteImport("import { wf } from `pi-wisp`;", BUILDER_URL);
    expect(out).toBe(`import { wf } from \`${BUILDER_URL}\`;`);
  });

  it("rewrites a default import", () => {
    const out = rewriteImport(`import wf from "pi-wisp";`, BUILDER_URL);
    expect(out).toBe(`import wf from "${BUILDER_URL}";`);
  });

  it("rewrites a namespace import", () => {
    const out = rewriteImport(`import * as wisp from "pi-wisp";`, BUILDER_URL);
    expect(out).toBe(`import * as wisp from "${BUILDER_URL}";`);
  });

  it("handles `from` glued directly to the specifier with no space", () => {
    const out = rewriteImport(`import {wf} from"pi-wisp";`, BUILDER_URL);
    expect(out).toBe(`import {wf} from"${BUILDER_URL}";`);
  });

  it("preserves arbitrary whitespace between `from` and the specifier", () => {
    const out = rewriteImport(`import { wf } from    "pi-wisp";`, BUILDER_URL);
    expect(out).toBe(`import { wf } from    "${BUILDER_URL}";`);
  });
});

describe("rewriteImport — dynamic imports (import(...))", () => {
  it("rewrites a double-quoted dynamic import", () => {
    const out = rewriteImport(`const x = await import("pi-wisp");`, BUILDER_URL);
    expect(out).toBe(`const x = await import("${BUILDER_URL}");`);
  });

  it("rewrites a single-quoted dynamic import", () => {
    const out = rewriteImport(`const x = await import('pi-wisp');`, BUILDER_URL);
    expect(out).toBe(`const x = await import('${BUILDER_URL}');`);
  });

  it("preserves whitespace inside import( ... )", () => {
    const out = rewriteImport(`const x = await import( "pi-wisp" );`, BUILDER_URL);
    expect(out).toBe(`const x = await import( "${BUILDER_URL}" );`);
  });

  it("rewrites a bare (no `await`) dynamic import", () => {
    const out = rewriteImport(`import("pi-wisp");`, BUILDER_URL);
    expect(out).toBe(`import("${BUILDER_URL}");`);
  });
});

describe("rewriteImport — subpath specifiers", () => {
  it("rewrites a static subpath import wholesale to the builder URL", () => {
    const out = rewriteImport(`import { x } from "pi-wisp/macros";`, BUILDER_URL);
    expect(out).toBe(`import { x } from "${BUILDER_URL}";`);
    expect(out).not.toContain("macros");
  });

  it("rewrites a deep subpath dynamic import wholesale", () => {
    const out = rewriteImport(`await import("pi-wisp/sub/deep");`, BUILDER_URL);
    expect(out).toBe(`await import("${BUILDER_URL}");`);
  });
});

describe("rewriteImport — multiple & mixed occurrences", () => {
  it("rewrites every pi-wisp import in a multi-import source", () => {
    const source = [
      `import { a } from "pi-wisp";`,
      `import { b } from "pi-wisp/macros";`,
      `await import("pi-wisp");`,
    ].join("\n");
    const out = rewriteImport(source, BUILDER_URL);
    expect(out).toBe(
      [
        `import { a } from "${BUILDER_URL}";`,
        `import { b } from "${BUILDER_URL}";`,
        `await import("${BUILDER_URL}");`,
      ].join("\n"),
    );
    expect(out).not.toContain("pi-wisp");
  });

  it("mixes static + dynamic imports in realistic source", () => {
    const source = [
      "// @ts-check",
      `import { wf, type WorkflowBuilder } from "pi-wisp";`,
      `import { readFile } from "node:fs/promises"; // unrelated import`,
      "",
      `export default wf("my-workflow")`,
      '  .node("a", { prompt: "First" });',
      "",
    ].join("\n");
    const out = rewriteImport(source, BUILDER_URL);

    // The pi-wisp specifier is replaced; everything else is byte-for-byte intact.
    expect(out).toContain(`from "${BUILDER_URL}"`);
    expect(out).not.toContain('"pi-wisp"');
    expect(out).toContain('"node:fs/promises"');
    expect(out).toContain("@ts-check");
    expect(out).toContain('"First"');
    expect(out).toContain("my-workflow");
  });
});

describe("rewriteImport — non-import safety (must NOT rewrite)", () => {
  it("leaves pi-wisp inside a line comment untouched", () => {
    const source = `// see pi-wisp docs for more details`;
    expect(rewriteImport(source, BUILDER_URL)).toBe(source);
  });

  it("leaves pi-wisp inside a non-import string literal untouched", () => {
    const source = `const pkg = "pi-wisp";`;
    expect(rewriteImport(source, BUILDER_URL)).toBe(source);
  });

  it("rewrites only the real import among comment + literal + import", () => {
    const source = [
      "// see pi-wisp docs for more details",
      'const pkg = "pi-wisp";',
      'import { wf } from "pi-wisp";',
      'export default wf("test");',
    ].join("\n");
    const out = rewriteImport(source, BUILDER_URL);

    // Real import rewritten:
    expect(out).toContain(`from "${BUILDER_URL}"`);
    expect(out).not.toContain('from "pi-wisp"');
    // Comment + literal preserved verbatim:
    expect(out).toContain("// see pi-wisp docs for more details");
    expect(out).toContain('const pkg = "pi-wisp";');
  });
});

describe("rewriteImport — no-op cases", () => {
  it("returns the source unchanged when it contains no pi-wisp import", () => {
    const source = `import { readFile } from "node:fs";\nconsole.log("no wisp here");`;
    expect(rewriteImport(source, BUILDER_URL)).toBe(source);
  });

  it("returns an empty string unchanged", () => {
    expect(rewriteImport("", BUILDER_URL)).toBe("");
  });

  it("returns unrelated code unchanged (only node: import present)", () => {
    const source = `import { writeFile } from "node:fs/promises";\nwriteFile("x", "y");`;
    expect(rewriteImport(source, BUILDER_URL)).toBe(source);
  });
});
