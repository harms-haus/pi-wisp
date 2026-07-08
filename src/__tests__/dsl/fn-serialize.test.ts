import { describe, it, expect } from "vitest";
import { Type } from "typebox";

import {
  serializeFn,
  rehydrateFn,
  validateOutputAgainstSchema,
  SHADOWED_GLOBALS,
  SHADOWABLE_PARAMS,
} from "../../dsl/fn-serialize.js";
import type { FnKind } from "../../types.js";

// ─── Test helpers ──────────────────────────────────────────────────

/** A fake NodeCtx for round-trip tests. */
function makeFakeNodeCtx() {
  return {
    output(_nodeId: string): { items: number[] } {
      return { items: [1, 2, 3] };
    },
    fanOut(_nodeId: string): unknown[] {
      return [];
    },
    member(_index: number): { output: unknown } {
      return { output: "member" };
    },
    run: { runId: "test-run", title: "Test", attempt: 1, startedAt: Date.now() },
    raw(_nodeId: string): { text: string; sessionId: string } {
      return { text: "raw", sessionId: "sess-1" };
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("serializeFn", () => {
  // ── contract shape ────────────────────────────────────────────

  it("returns { __fn, src, kind } with the function's exact source", () => {
    const fn = (ctx: { output: (id: string) => { items: number[] } }): number[] =>
      ctx.output("x").items;
    const kind: FnKind = "iterate";

    // EXPECTED CONTRACT:
    //   - Returns an FnDescriptor with __fn: true
    //   - src contains the exact source text of the function,
    //     including 'ctx.output' and 'items'
    //   - kind matches the input parameter
    const result = serializeFn(fn, kind);

    expect(result).toHaveProperty("__fn", true);
    expect(result).toHaveProperty("src");
    expect(result).toHaveProperty("kind", kind);
    // The source must contain the function body identifiers
    expect(result.src).toContain("ctx.output");
    expect(result.src).toContain("items");
    // The source must start with '(' (arrow fn signature) or 'function'
    expect(result.src).toMatch(/^[(]|^function/);
  });

  it("rejects native / bound functions by throwing", () => {
    // Native functions produce "[native code]" as toString()
    const nativeFn = Math.sqrt;
    const kind: FnKind = "iterate";

    // EXPECTED CONTRACT: throws because Math.sqrt.toString() is "[native code]"
    expect(() => serializeFn(nativeFn, kind)).toThrow();
  });
});

describe("rehydrateFn", () => {
  // ── round-trip: pure arrow fn ─────────────────────────────────

  it("round-trips a pure arrow function (serialize → rehydrate → call)", () => {
    const fn = (ctx: { output: (id: string) => { items: number[] } }): number[] =>
      ctx.output("x").items;
    const kind: FnKind = "iterate";

    // Serialize the fn
    const desc = serializeFn(fn, kind);
    // Rehydrate and call with a fake context
    const nodeCtx = makeFakeNodeCtx();
    const result = rehydrateFn(desc, nodeCtx);

    // EXPECTED CONTRACT: the rehydrated fn returns [1, 2, 3] (the items
    // from the fake ctx.output("x"))
    expect(result).toEqual([1, 2, 3]);
  });

  // ── object-literal arrow ──────────────────────────────────────

  it("round-trips an object-literal arrow fn (ctx) => ({ a: 1 })", () => {
    // Object-literal arrow: without the `return (` wrapper the braces would
    // be parsed as a function body, not an object literal.
    const fn = (_ctx: unknown): { a: number } => ({ a: 1 });
    const kind: FnKind = "iterate";

    const desc = serializeFn(fn, kind);
    const nodeCtx = makeFakeNodeCtx();
    const result = rehydrateFn(desc, nodeCtx);

    // EXPECTED CONTRACT: returns { a: 1 } — the `return (` wrapper
    // must correctly handle the object literal.
    expect(result).toEqual({ a: 1 });
  });

  // ── guardrail: shadowed global ─────────────────────────────────

  it("throws when the rehydrated fn references a shadowed global (e.g. process)", () => {
    // This fn accesses `process.cwd()` which is parameter-shadowed to
    // `undefined`, producing a TypeError at call time.
    const fn = (_ctx: unknown): string => (process as { cwd: () => string }).cwd();
    const kind: FnKind = "iterate";

    const desc = serializeFn(fn, kind);
    const nodeCtx = makeFakeNodeCtx();

    // EXPECTED CONTRACT: rehydrateFn itself does NOT throw (construction
    // succeeds). The thrown error occurs when the returned fn is CALLED
    // internally by rehydrateFn because `process` is `undefined`.
    // The error is a TypeError, not a generic Error.
    expect(() => rehydrateFn(desc, nodeCtx)).toThrow(TypeError);
  });
});

describe("validateOutputAgainstSchema", () => {
  // ── valid value ───────────────────────────────────────────────

  it("returns { ok: true } when the value matches the schema", () => {
    // A schema matching a findings list
    const schema = Type.Object({
      findings: Type.Array(Type.Object({ title: Type.String() })),
    });
    const validValue = { findings: [{ title: "Bug in parser" }] };

    // EXPECTED CONTRACT: returns { ok: true } for a valid value
    const result = validateOutputAgainstSchema(validValue, schema);
    expect(result).toEqual({ ok: true });
  });

  // ── invalid value ─────────────────────────────────────────────

  it("returns { ok: false, errors: [...] } when the value does not match the schema", () => {
    const schema = Type.Object({
      findings: Type.Array(Type.Object({ title: Type.String() })),
    });
    // Invalid: title is a number, not a string
    const invalidValue = { findings: [{ title: 42 }] };

    // EXPECTED CONTRACT:
    //   - ok is false
    //   - errors is a non-empty array of descriptive strings
    const result = validateOutputAgainstSchema(invalidValue, schema);

    expect(result.ok).toBe(false);
    expect(Array.isArray((result as { ok: false; errors: string[] }).errors)).toBe(true);
    expect((result as { ok: false; errors: string[] }).errors.length).toBeGreaterThan(0);
    // Each error should be a meaningful string, not an empty string
    for (const err of (result as { ok: false; errors: string[] }).errors) {
      expect(typeof err).toBe("string");
      expect(err.length).toBeGreaterThan(0);
    }
  });
});

describe("SHADOWED_GLOBALS", () => {
  it("includes the safety-critical Node / runtime globals the guardrail must shadow", () => {
    // Rather than re-state every element of the literal, verify the *coverage*
    // guarantee of the guardrail: the globals most likely to leak filesystem /
    // process / network access into an otherwise-pure DSL fn must be present.
    expect(Array.isArray(SHADOWED_GLOBALS)).toBe(true);
    expect(SHADOWED_GLOBALS.length).toBeGreaterThan(0);
    // Filesystem / module-loading escape hatches
    expect(SHADOWED_GLOBALS).toContain("require");
    expect(SHADOWED_GLOBALS).toContain("fs");
    expect(SHADOWED_GLOBALS).toContain("__dirname");
    expect(SHADOWED_GLOBALS).toContain("__filename");
    // Process environment / network
    expect(SHADOWED_GLOBALS).toContain("process");
    expect(SHADOWED_GLOBALS).toContain("fetch");
    expect(SHADOWED_GLOBALS).toContain("globalThis");
  });
});

describe("SHADOWABLE_PARAMS", () => {
  // `RESERVED_KEYWORDS` is intentionally NOT exported from the module, so the
  // filter relationship is verified behaviorally / by cross-check rather than
  // by re-stating the internal set verbatim.

  it("is a subset of SHADOWED_GLOBALS (reserved keywords are excluded from the source list)", () => {
    // Every shadowable param must originate from the source global list —
    // nothing foreign is injected by the filter.
    expect(SHADOWABLE_PARAMS.every((p) => SHADOWED_GLOBALS.includes(p))).toBe(true);
    // SHADOWED_GLOBALS only ever holds legal `new Function` parameter names.
    // A reserved keyword like `import` (illegal as a parameter name) is kept
    // out of the source list rather than added and then filtered out — it
    // could never be shadowed, so it would be dead weight.
    expect(SHADOWED_GLOBALS).not.toContain("import");
    expect(SHADOWABLE_PARAMS).not.toContain("import");
  });

  it("contains no JavaScript reserved keywords illegal as parameter names", () => {
    // Cross-check against the ES reserved-word concept: any keyword that is
    // illegal as a `new Function` parameter name would raise a SyntaxError at
    // rehydration construction time, so it must have been filtered out.
    const RESERVED: readonly string[] = [
      "eval",
      "arguments",
      "import",
      "await",
      "class",
      "let",
      "const",
      "enum",
      "extends",
      "super",
      "yield",
      "return",
      "function",
      "var",
      "new",
      "delete",
      "typeof",
      "void",
      "this",
    ];
    // Equivalent to: SHADOWABLE_PARAMS.every(p => !RESERVED_KEYWORDS.has(p))
    const leaked = RESERVED.filter((k) => SHADOWABLE_PARAMS.includes(k));
    expect(leaked).toEqual([]);
  });

  it("still DOES contain the expected shadowable globals (require, process, fs)", () => {
    // The filter must NOT over-prune: the safety-critical globals survive into
    // the actual parameter list used at rehydration.
    expect(SHADOWABLE_PARAMS).toContain("require");
    expect(SHADOWABLE_PARAMS).toContain("process");
    expect(SHADOWABLE_PARAMS).toContain("fs");
  });

  // ── Behavioral guardrail verification ────────────────────────────
  // Rather than only asserting on the constant array contents, prove the
  // guardrail actually works end-to-end via serialize → rehydrate.

  it("guardrail: rehydrating a fn that CALLS a shadowed global (require) throws TypeError", () => {
    // `require` is shadowed to `undefined` at rehydration, so invoking it
    // raises a TypeError — proving the guardrail blocks module loading.
    // The require() call is intentional: the test exercises the guardrail,
    // so the no-require-imports rule is disabled for this line only.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fn = (_ctx: unknown) => require("node:os");
    const desc = serializeFn(fn, "iterate");
    expect(() => rehydrateFn(desc, makeFakeNodeCtx())).toThrow(TypeError);
  });

  it("guardrail: a shadowed global (process) evaluates to `undefined` inside the rehydrated fn", () => {
    // `typeof` does not throw on undefined, so this proves the shadowing
    // *binds* process to undefined rather than leaking the real global.
    const fn = () => typeof process;
    const desc = serializeFn(fn, "iterate");
    expect(rehydrateFn(desc, makeFakeNodeCtx())).toBe("undefined");
  });
});
