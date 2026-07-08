// ═══════════════════════════════════════════════════════════════════════════
// DSL import-rewrite — rewrite `from "pi-wisp"` specifiers to a `file://` URL.
//
// Extracted from compile.ts: the tsx compile subprocess runs the user's
// workflow script under the user's project cwd, where `pi-wisp` is NOT
// resolvable as a package (it is a sibling extension, not an installed
// dependency). `NODE_PATH` does not work for ESM and editing the user's
// tsconfig `paths` is not viable, so the most robust fix is to rewrite the
// bare specifier in-place to an absolute `file://` URL of the shipped builder
// module (whose absolute path is known at extension registration time; see
// `src/index.ts`).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Rewrite `from "pi-wisp"` (and all variants) to a `file://` URL pointing at
 * the shipped builder.
 *
 * Handles both quote styles and all four import forms:
 *   default import:    `import wf from "pi-wisp"`
 *   named import:      `import { wf } from "pi-wisp"`
 *   namespace import:  `import * as wisp from "pi-wisp"`
 *   dynamic import:    `import("pi-wisp")`
 *
 * The rewriter anchors on REAL import positions only — a `from <quote>` or
 * `import(<quote>` immediately followed by the `pi-wisp` specifier — so
 * `pi-wisp` appearing inside comments or a non-import string literal (e.g.
 * `const pkg = "pi-wisp"`) is NEVER touched. Subpath specifiers
 * (`pi-wisp/macros`, `pi-wisp/sub`) are likewise rewritten wholesale to
 * `builderUrl`: the shipped builder resolves the entire module regardless of
 * the requested subpath. The matched specifier (including any subpath) is
 * replaced with `builderUrl`, preserving the original quote style and the
 * surrounding `from` / `import(` / `)` syntax. When the source contains no
 * `pi-wisp` import it is returned unchanged.
 *
 * @param source     - The raw workflow script source text.
 * @param builderUrl - The absolute `file://` URL of the shipped builder.ts
 *                     (e.g. `pathToFileURL(builderPath).href`).
 * @returns The source with every `pi-wisp` specifier rewritten.
 */
export function rewriteImport(source: string, builderUrl: string): string {
  // Anchor on REAL import positions so `pi-wisp` inside comments or a
  // non-import string literal is never rewritten. Two forms:
  //   static  — `from <quote>pi-wisp[/sub]<quote>`
  //   dynamic — `import(<quote>pi-wisp[/sub]<quote>)`
  // The opening quote is captured (group 2) and back-referenced so the closing
  // quote matches; the `from\s*` / `import(\s*` prefix (group 1) and the
  // dynamic `\s*)` suffix (group 3) are captured and re-emitted to preserve
  // surrounding whitespace exactly. A subpath (`pi-wisp/macros`) is part of the
  // matched specifier and is replaced wholesale with `builderUrl`.
  const staticRe = /(from\s*)(["'`])pi-wisp[^"'`\n]*\2/g;
  const dynamicRe = /(import\s*\(\s*)(["'`])pi-wisp[^"'`\n]*\2(\s*\))/g;
  return source
    .replace(
      staticRe,
      (_match, prefix: string, quote: string) => `${prefix}${quote}${builderUrl}${quote}`,
    )
    .replace(
      dynamicRe,
      (_match, prefix: string, quote: string, suffix: string) =>
        `${prefix}${quote}${builderUrl}${quote}${suffix}`,
    );
}
