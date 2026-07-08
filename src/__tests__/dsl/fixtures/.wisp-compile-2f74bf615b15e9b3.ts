// ═══════════════════════════════════════════════════════════════════════════
// Valid workflow fixture — compiled by the tsx subprocess, should produce a
// well-formed GraphIR with two nodes (step1, step2) and a dep edge.
//
// The import specifier "pi-wisp" is rewritten at compile time (S16) to the
// absolute file:// URL of the shipped builder.ts.
// ═══════════════════════════════════════════════════════════════════════════

import { wf } from "file:///home/blake/Documents/software/pi-wisp/.engin/work/1783513426725-improve/task-worktrees/t-14/src/dsl/builder.ts";

export default wf("valid-workflow")
  .node("step1", { prompt: "Step one" })
  .node("step2", { prompt: "Step two", dependsOn: ["step1"] });
