// ═══════════════════════════════════════════════════════════════════════════
// Invalid-cycle fixture — graph with a 2-node cycle (a → b → a).
//
// The script compiles successfully (the builder does not detect cross-node
// cycles), but validateIR() should reject the resulting GraphIR with a
// structured validation error whose message mentions the cycle.
//
// A dependsOn-only cycle cannot be expressed through the fluent API: every
// `dependsOn` target must already exist when its node is added (the builder's
// forward-reference guard), so a→b→a via dependsOn throws at build time before
// validateIR ever runs. Instead the cycle is closed with a `cond` branch edge:
//   a → b  (dep)            from cond's `on` dependency
//   b → a  (cond:branch)    from cond's `then` target
// The builder does not existence-check `then`/`else` string targets, so this
// builds; validateIR's cycle detector then reconstructs the a → b → a path.
// ═══════════════════════════════════════════════════════════════════════════

import { wf } from "pi-wisp";

export default wf("cycle")
  .node("a", { prompt: "A" })
  .cond("b", { on: "a", when: () => true, then: "a" });
