// ═══════════════════════════════════════════════════════════════════════════
// Runtime-throw fixture — module evaluation throws synchronously.
//
// The compile subprocess should catch this and return a structured runtime
// error (kind: "runtime") with the thrown message.
// ═══════════════════════════════════════════════════════════════════════════

throw new Error("module evaluation failed");
