// ═══════════════════════════════════════════════════════════════════════════
// DSL function serialization / rehydration.
//
// DSL functions authored in a user script are captured via
// `Function.prototype.toString()` (exact source since ES2019), transported as
// plain strings inside {@link FnDescriptor}s in the serialized IR, and
// rehydrated at execution time inside a *restricted context* that shadows the
// Node / runtime globals as `undefined` parameters. TypeBox is used for the
// post-hoc structured-output validation path (when the adapter cannot enforce
// an output schema natively).
// ═══════════════════════════════════════════════════════════════════════════

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import type { FnDescriptor, FnKind, NodeCtx } from "../types.js";

/**
 * Global identifiers shadowed in the restricted context so that accidental use
 * of Node / runtime APIs inside a rehydrated DSL function throws a TypeError
 * (the parameter is `undefined` at call-time). This is a **guardrail for
 * authoring mistakes**, NOT a sandbox — the restricted context is escapable
 * (e.g. via constructor-rebinding). The threat model assumes the orchestrating
 * agent authored the DSL code and the restriction enforces the "pure w.r.t.
 * ctx" contract.
 *
 * Source list of globals we intend to shadow. Every entry must be a legal
 * `new Function` parameter name; reserved keywords are filtered out at
 * rehydration as a safety net (see {@link SHADOWABLE_PARAMS}).
 */
export const SHADOWED_GLOBALS: readonly string[] = [
  "require",
  "process",
  "fs",
  "fetch",
  "globalThis",
  "Buffer",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "__dirname",
  "__filename",
  "URL",
];

/**
 * Reserved ECMAScript keywords that are **not** legal `new Function` parameter
 * names (they raise a `SyntaxError` at construction). This is the standard ES
 * reserved-word set plus the strict-mode reserved names `eval` and
 * `arguments`. No current {@link SHADOWED_GLOBALS} entry is reserved; the full
 * set is retained so any future addition is handled safely instead of
 * silently breaking rehydration.
 */
const RESERVED_KEYWORDS: ReadonlySet<string> = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "arguments",
  "await",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
]);

/**
 * The subset of {@link SHADOWED_GLOBALS} that are legal `new Function`
 * parameter names (reserved keywords excluded). Computed once at module load.
 */
export const SHADOWABLE_PARAMS: readonly string[] = SHADOWED_GLOBALS.filter(
  (name) => !RESERVED_KEYWORDS.has(name),
);

/**
 * Serialise a DSL function to a transportable descriptor.
 *
 * Uses `Function.prototype.toString()` (exact source since ES2019).
 * Throws a `TypeError` if `fn` is a native / bound function (produces
 * `[native code]`), since such functions cannot be rehydrated from source.
 *
 * @param fn   - The DSL function (arrow, expression, async, or generator).
 * @param kind - The semantic role of the function in the IR (e.g. "iterate").
 * @returns A serialised {@link FnDescriptor} with `__fn: true`.
 */
export function serializeFn(fn: (...args: never[]) => unknown, kind: FnKind): FnDescriptor {
  const src = Function.prototype.toString.call(fn);
  if (/\[native code\]/.test(src)) {
    throw new TypeError(
      "serializeFn: cannot serialize a native or bound function " +
        "(Function.prototype.toString returned '[native code]'); " +
        "DSL functions must be authored arrow or expression functions.",
    );
  }
  return { __fn: true, src, kind };
}

/**
 * Rehydrate a serialised DSL function and call it with the supplied named
 * parameters.
 *
 * This is the shared primitive underlying {@link rehydrateFn} (single `ctx`
 * argument) and the executor's fanOut each-fn rehydration (single `item`
 * argument). Every shadowable global identifier is bound to `undefined` (the
 * guardrail), then the caller's `paramNames` are appended as trailing
 * parameters and bound positionally to `args`. See {@link rehydrateFn} for the
 * guardrail / closure-limitation threat model.
 *
 * @param desc       - The serialised function descriptor.
 * @param paramNames - Caller parameter names appended after the shadowed globals.
 * @param args       - Values bound to `paramNames` (length MUST match).
 * @returns The return value of the rehydrated function.
 */
export function rehydrateArity(desc: FnDescriptor, paramNames: string[], args: unknown[]): unknown {
  const callList = paramNames.join(", ");
  const body = `"use strict"; return (${desc.src})(${callList});`;
  // new Function(...SHADOWABLE_PARAMS, ...paramNames, body) — every shadowable
  // global becomes a parameter bound to `undefined`, shadowing the real global
  // within the body. The Function constructor is the *intended* rehydration
  // mechanism here: the source originates from the trusted orchestrating
  // agent's DSL (not untrusted input), so the implied-eval lint rule does not
  // apply.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...SHADOWABLE_PARAMS, ...paramNames, body) as (
    ...a: unknown[]
  ) => unknown;
  const shadowedArgs: unknown[] = SHADOWABLE_PARAMS.map(() => undefined);
  return fn(...shadowedArgs, ...args);
}

/**
 * Rehydrate a serialised DSL function and call it with the given context.
 *
 * Thin wrapper over {@link rehydrateArity} for the single-`ctx` arity. The
 * `return ( ... )(ctx)` wrapper (constructed by {@link rehydrateArity}) handles
 * object-literal arrow functions such as `(ctx) => ({ a: 1 })` correctly.
 *
 * See {@link rehydrateArity} and the file-level guardrail / closure-limitation
 * documentation for the threat model.
 *
 * @param desc    - The serialised function descriptor.
 * @param nodeCtx - The NodeCtx object passed as the argument to the rehydrated
 *                  function.
 * @returns The return value of the rehydrated function (typed as `unknown`).
 */
export function rehydrateFn(desc: FnDescriptor, nodeCtx: NodeCtx): unknown {
  return rehydrateArity(desc, ["ctx"], [nodeCtx]);
}

/**
 * Validate a value against a TypeBox schema, returning a result object.
 *
 * Uses {@link Value.Check} (boolean, short-circuits, never throws) and
 * {@link Value.Errors} (returns a full error list) from `"typebox/value"`. This
 * is the post-hoc validation path used when the adapter does not support native
 * output-schema enforcement (i.e. the pi adapter). This function never throws.
 *
 * @param value  - The value to validate (typically a parsed JSON output).
 * @param schema - A TypeBox schema (e.g. `Type.Object({...})`).
 * @returns `{ ok: true }` if valid, or `{ ok: false, errors: [...] }` with one
 *          descriptive entry per schema violation.
 */
export function validateOutputAgainstSchema(
  value: unknown,
  schema: TSchema,
): { ok: true } | { ok: false; errors: string[] } {
  if (Value.Check(schema, value)) {
    return { ok: true };
  }
  const errors: string[] = [];
  for (const err of Value.Errors(schema, value)) {
    const location = err.instancePath.length > 0 ? err.instancePath : "(root)";
    errors.push(`${location}: ${err.message}`);
  }
  return { ok: false, errors };
}
