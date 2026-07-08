// ═══════════════════════════════════════════════════════════════════════════
// Syntax-error fixture — deliberately malformed TypeScript.
//
// The compile subprocess should produce a structured compile error with a
// line number indicating where the expected token is missing.
// ═══════════════════════════════════════════════════════════════════════════

import { wf } from "pi-wisp";

export default wf("broken")
  .node("missing, missing closing paren",
