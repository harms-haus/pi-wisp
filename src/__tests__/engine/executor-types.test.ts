/**
 * RED-phase tests — executor-types.ts (pure helpers + ExecutorContext).
 *
 * Pins the contract of the pure helpers currently defined inside executor.ts
 * that the green team will extract verbatim into
 * `src/engine/executor-types.ts`:
 *
 *   - `resolveAgentType(node)` — agent type resolution per node kind
 *   - `determineOutcome(events)` — last-error-wins outcome classification
 *   - `validateNodeOutput(finalText, schema)` — JSON parse + TypeBox validation
 *   - `sleep(ms)` — promise-based delay
 *
 * Plus a compile-time check that `ExecutorContext` is exported from
 * executor-types.ts as a usable type.
 *
 * These are RED today because `src/engine/executor-types.ts` does not exist;
 * once the green team extracts the helpers there (unchanged behavior), they go
 * GREEN. The assertions mirror the exact behavior of the inline functions in
 * executor.ts so the extraction is provably behavior-preserving.
 */

import { describe, it, expect } from "vitest";

import {
  resolveAgentType,
  determineOutcome,
  validateNodeOutput,
  sleep,
} from "../../engine/executor-types.js";
import type { ExecutorContext } from "../../engine/executor-types.js";

import type { GraphIR, IRNode, NormalizedEvent } from "../../types.js";
import type { AgentAdapter } from "../../adapters/types.js";
import type { Scheduler } from "../../engine/scheduler.js";

// ── Compile-time check: ExecutorContext is exported as a usable type ─────
// The import is exercised structurally by the `const ctx: ExecutorContext`
// annotation in the "ExecutorContext shape" describe block below; if the
// export were missing this file would fail to compile.

// ═══════════════════════════════════════════════════════════════════════════
// resolveAgentType
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveAgentType", () => {
  it("returns the node's agentType when set on a plain node", () => {
    const node: IRNode = { id: "n", kind: "node", agentType: "codex", profileRef: "default" };
    expect(resolveAgentType(node)).toBe("codex");
  });

  it("defaults to 'pi' for a plain node with no agentType", () => {
    const node: IRNode = { id: "n", kind: "node", profileRef: "default" };
    expect(resolveAgentType(node)).toBe("pi");
  });

  it("returns the reduce node's agentType when set", () => {
    const node: IRNode = { id: "r", kind: "reduce", from: ["a"], agentType: "claude" };
    expect(resolveAgentType(node)).toBe("claude");
  });

  it("defaults to 'pi' for a reduce node with no agentType", () => {
    const node: IRNode = { id: "r", kind: "reduce", from: ["a"] };
    expect(resolveAgentType(node)).toBe("pi");
  });

  it("always returns 'pi' for structural kinds (fanOut/cond/loop/parallel/sequence)", () => {
    const fanOut = {
      id: "f",
      kind: "fanOut",
      from: "p",
      iterateFnRef: { __fn: true as const, src: "", kind: "iterate" as const },
      eachFnRef: { __fn: true as const, src: "", kind: "each" as const },
    } as IRNode;
    const cond = {
      id: "c",
      kind: "cond",
      on: "p",
      whenFnRef: { __fn: true as const, src: "", kind: "cond" as const },
      then: "x",
    } as IRNode;
    const loop = {
      id: "l",
      kind: "loop",
      body: "b",
      untilFnRef: { __fn: true as const, src: "", kind: "until" as const },
    } as IRNode;
    const parallel = { id: "pa", kind: "parallel" } as IRNode;
    const sequence = { id: "se", kind: "sequence", steps: ["a"] } as IRNode;

    expect(resolveAgentType(fanOut)).toBe("pi");
    expect(resolveAgentType(cond)).toBe("pi");
    expect(resolveAgentType(loop)).toBe("pi");
    expect(resolveAgentType(parallel)).toBe("pi");
    expect(resolveAgentType(sequence)).toBe("pi");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// determineOutcome
// ═══════════════════════════════════════════════════════════════════════════

describe("determineOutcome", () => {
  const done = (finalText = "ok"): NormalizedEvent => ({
    type: "done",
    sessionId: "s",
    finalText,
    durationMs: 1,
    toolCallCount: 0,
  });
  const error = (message: string, retryable: boolean): NormalizedEvent => ({
    type: "error",
    message,
    retryable,
  });

  it("an empty event stream is a success", () => {
    expect(determineOutcome([])).toEqual({ succeeded: true, retryable: false });
  });

  it("a benign stream with only a done event is a success (no errorMessage)", () => {
    const out = determineOutcome([done()]);
    expect(out.succeeded).toBe(true);
    expect(out.retryable).toBe(false);
    expect(out.errorMessage).toBeUndefined();
  });

  it("a retryable error event yields a retryable failure with its message", () => {
    const out = determineOutcome([error("transient", true)]);
    expect(out).toEqual({ succeeded: false, errorMessage: "transient", retryable: true });
  });

  it("a non-retryable error event yields a non-retryable failure", () => {
    const out = determineOutcome([error("boom", false)]);
    expect(out).toEqual({ succeeded: false, errorMessage: "boom", retryable: false });
  });

  it("uses the LAST error event's message + retryability when multiple errors occur", () => {
    const out = determineOutcome([
      error("first", true),
      error("second", false),
      error("third", true),
    ]);
    expect(out).toEqual({ succeeded: false, errorMessage: "third", retryable: true });
  });

  it("an error event anywhere in the stream makes the outcome a failure, even followed by done", () => {
    expect(determineOutcome([error("e", true), done()]).succeeded).toBe(false);
    expect(determineOutcome([done(), error("e", false)]).succeeded).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// validateNodeOutput
// ═══════════════════════════════════════════════════════════════════════════

describe("validateNodeOutput", () => {
  const schema = {
    type: "object",
    properties: { verdict: { type: "string" }, score: { type: "number" } },
    required: ["verdict", "score"],
  };

  it("fails with a no-output message when finalText is undefined", () => {
    const out = validateNodeOutput(undefined, schema);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/no output text/i);
    }
  });

  it("fails with a no-output message when finalText is empty", () => {
    const out = validateNodeOutput("", schema);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/no output text/i);
    }
  });

  it("fails with a not-valid-JSON message when finalText is unparseable", () => {
    const out = validateNodeOutput("not json at all", schema);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/not valid json/i);
    }
  });

  it("succeeds and returns the parsed value when finalText matches the schema", () => {
    const out = validateNodeOutput(JSON.stringify({ verdict: "ok", score: 9 }), schema);
    expect(out).toEqual({ ok: true, parsed: { verdict: "ok", score: 9 } });
  });

  it("fails with a schema-validation message when the parsed JSON violates the schema", () => {
    // Missing required field "score"
    const out = validateNodeOutput(JSON.stringify({ verdict: "ok" }), schema);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/schema validation failed/i);
    }
  });

  it("fails on a type mismatch (verdict is a number, schema requires string)", () => {
    const out = validateNodeOutput(JSON.stringify({ verdict: 7, score: 9 }), schema);
    expect(out.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// sleep
// ═══════════════════════════════════════════════════════════════════════════

describe("sleep", () => {
  it("resolves (does not reject) and waits approximately the requested ms", async () => {
    const ms = 30;
    const start = Date.now();
    await sleep(ms);
    const elapsed = Date.now() - start;
    // Allow timer slack but assert it genuinely waited.
    expect(elapsed).toBeGreaterThanOrEqual(ms - 10);
  });

  it("sleep(0) resolves immediately", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ExecutorContext shape (compile-time / structural)
// ═══════════════════════════════════════════════════════════════════════════

describe("ExecutorContext shape", () => {
  it("can be constructed with all bundled shared-state fields", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = {
      runId: "r",
      title: "t",
      slug: "t",
      startedAt: 0,
      status: "running" as const,
      nodes: new Map(),
    };
    const noopAdapter = { type: "x" } as unknown as AgentAdapter;
    const scheduler = {
      tryAcquire: () => true,
      acquire: () => Promise.resolve(true),
      release: () => {},
      usage: () => ({ global: { used: 0, cap: 1 }, byAgentType: {}, byProvider: {}, byModel: {} }),
    } as unknown as Scheduler;

    const ctx: ExecutorContext = {
      ir,
      runState,
      nodeMap: new Map(),
      successors: new Map(),
      predecessors: new Map(),
      promptOverrides: new Map(),
      inFlight: new Map(),
      scheduler,
      signal: undefined,
      audit: undefined,
      defaultRetries: 3,
      retryBackoff: 2000,
      options: { ir, runState, getAdapter: () => noopAdapter, scheduler },
      notify: () => {},
      getAdapter: () => noopAdapter,
    };

    // Smoke-check the bundled fields are reachable.
    expect(ctx.nodeMap).toBeInstanceOf(Map);
    expect(ctx.defaultRetries).toBe(3);
    expect(typeof ctx.notify).toBe("function");
    expect(typeof ctx.getAdapter).toBe("function");
  });
});
