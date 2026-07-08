// ═══════════════════════════════════════════════════════════════════════════
// §4.1 example — fix-bugs workflow.
//
// review → fanOut fix → reviewLoop verify
//
// This is the canonical example from IMPLEMENTATION_PROMPT.md §4.1 used by
// the gated E2E test (WISP_E2E=1). The import specifier "pi-wisp" is
// rewritten at compile time (S16) to the absolute file:// URL of the shipped
// builder.ts.
// ═══════════════════════════════════════════════════════════════════════════

import { wf } from "pi-wisp";

export default wf("fix-bugs", { maxConcurrency: 6 })
  .node("review", {
    profile: "reviewer",
    outputSchema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              file: { type: "string" },
              severity: { type: "string" },
            },
            required: ["title", "file"],
          },
        },
      },
      required: ["findings"],
    },
    prompt: "Find bugs in auth/*.ts. Return JSON {findings:[{title,file,severity}]}.",
  })
  .fanOut("fix", {
    from: "review",
    iterate: (ctx: unknown) =>
      (ctx as { output: (id: string) => { findings: unknown[] } }).output("review").findings,
    each: (f: unknown) => ({
      profile: "fixer",
      prompt: `Fix ${(f as { title: string }).title} in ${(f as { file: string }).file}`,
    }),
  })
  .reviewLoop("verify", { worker: "fix", gate: "reviewer", maxRounds: 3 });
