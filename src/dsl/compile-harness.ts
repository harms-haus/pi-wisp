// ═══════════════════════════════════════════════════════════════════════════
// DSL compile harness — tsx subprocess entrypoint (S15).
//
// This module is the file the tsx subprocess executes during Layer-1 compile.
// It imports the user's rewritten workflow script (path passed as argv[2]),
// reads its `default export` (a {@link WorkflowBuilder}), calls `builder.toIR()`
// — which serialises live function references into {@link FnDescriptor}s — and,
// as the FINAL statement, writes the resulting JSON to **stdout** (the
// clean-stdout protocol per WEB_RESEARCH §2a). ALL diagnostics go to
// **stderr**; nothing else may touch stdout.
//
// The builder is imported via a RELATIVE path (`./builder.js`) so it always
// resolves regardless of the user's project cwd (a relative path is resolved
// against this harness file's location inside the shipped package, not the
// subprocess cwd). The user's script — after import rewriting in `compile.ts` —
// imports the same builder via an absolute `file://` URL.
//
// Invocation (from `compile.ts`):
//   node --import tsx --no-warnings <harnessPath> <rewrittenScriptPath>
// ═══════════════════════════════════════════════════════════════════════════

import { pathToFileURL } from "node:url";

import type { WorkflowBuilder } from "./builder.js";

/**
 * Load a rewritten workflow script, compile it to a {@link GraphIR} via the
 * default-exported builder, and write the serialised IR to stdout.
 *
 * Contract:
 *   - argv[2] = absolute path to the rewritten workflow `.ts` script.
 *   - On success: a single `JSON.stringify(ir)` blob to stdout, then exit 0.
 *   - On failure: diagnostics to stderr (console.error), then exit non-zero.
 *     The process's own uncaught-exception handler also emits the error+stack
 *     to stderr, which the parent `compile.ts` classifier inspects to
 *     distinguish compile vs runtime failures.
 */
async function main(): Promise<void> {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    console.error("compile-harness: missing workflow script path (expected as argv[2]).");
    process.exitCode = 1;
    return;
  }

  // Dynamic-import the rewritten script. A syntax error (tsx/esbuild transform
  // failure) or a module-evaluation throw rejects here; we let the rejection
  // propagate so Node's diagnostics reach stderr unmodified.
  const mod = (await import(pathToFileURL(scriptPath).href)) as {
    default?: WorkflowBuilder;
  };

  const builder = mod.default;
  if (!builder || typeof builder.toIR !== "function") {
    console.error(
      "compile-harness: the workflow script must `export default` a " +
        "WorkflowBuilder (the value returned by wf(...)).",
    );
    process.exitCode = 1;
    return;
  }

  // toIR() serialises every live fn (iterate/each/prompt/cond/merge/until/...)
  // into a transportable FnDescriptor via serializeFn (S17).
  const ir = builder.toIR();

  // FINAL stdout write — the clean-stdout protocol. Nothing else may write to
  // stdout during a successful compile.
  process.stdout.write(JSON.stringify(ir));
}

main().catch((error: unknown) => {
  // Re-emit the full error (message + stack) to stderr so the parent
  // classifier (compile.ts) can classify it as compile vs runtime. Using
  // process.exitCode (deferred exit) rather than process.exit() lets the event
  // loop drain and the stderr write flush before the process terminates.
  console.error(error instanceof Error ? error : String(error));
  process.exitCode = 1;
});
