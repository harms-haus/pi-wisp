/**
 * RED-phase tests — run-node.ts (runNode / buildPrompt / failNode / depsMet).
 *
 * Pins the per-node execution lifecycle currently inlined as closures inside
 * `executeDAG`. The green team will extract them to
 * `src/engine/run-node.ts`, each receiving an {@link ExecutorContext}:
 *
 *   - `depsMet(ctx, nodeId)` — every predecessor + declared dependsOn completed
 *   - `buildPrompt(ctx, node)` — override > promptFn > static prompt
 *   - `failNode(ctx, nodeId, rt, message, reason)` — fail + propagate skip + audit
 *   - `runNode(ctx, node, schedulable)` — full attempt lifecycle incl. retries,
 *     abort, output-schema validation, and the slot-release invariant
 *
 * The assertions mirror the exact behavior of the inline closures in
 * executor.ts so the extraction is provably behavior-preserving. RED today
 * because `src/engine/run-node.ts` does not exist.
 */

import { describe, it, expect, vi } from "vitest";

import { runNode, buildPrompt, failNode, depsMet } from "../../engine/run-node.js";
import { resolveAgentType } from "../../engine/executor-types.js";
import type { ExecutorContext } from "../../engine/executor-types.js";
import type { SchedulableNode } from "../../engine/scheduler.js";

import type { FnDescriptor, GraphIR, IRNode, NormalizedEvent } from "../../types.js";
import type { AgentAdapter, NodeInvocationContext } from "../../adapters/types.js";
import { createScheduler } from "../../engine/scheduler.js";
import { createFakeAdapter } from "../helpers/fake-adapter.js";
import {
  makeExecutorContext,
  makeFakeAudit,
  type MakeCtxOptions,
} from "../helpers/executor-context.js";
import { makeRunState, fn } from "../helpers/fixtures.js";

// ── Helpers ──────────────────────────────────────────────────────────

function singleNodeIR(
  id: string,
  extra: Partial<IRNode> = {},
  options: GraphIR["options"] = {},
): GraphIR {
  return {
    title: "rn",
    slug: "rn",
    options,
    nodes: [{ id, kind: "node", profileRef: "default", prompt: "do work", ...extra } as IRNode],
    edges: [],
    conditions: [],
    schemas: {},
    primitives: {},
  };
}

function ctxFor(ir: GraphIR, opts: Partial<MakeCtxOptions> = {}): ExecutorContext {
  return makeExecutorContext({ ir, runState: makeRunState(ir), ...opts });
}

/**
 * Acquire a scheduler slot for `node` and mark it running — exactly what the
 * executeDAG main loop does before delegating to runNode. Returns the
 * schedulable descriptor to pass to runNode.
 */
function acquireAndRun(ctx: ExecutorContext, node: IRNode): SchedulableNode {
  const schedulable: SchedulableNode = { agentType: resolveAgentType(node) };
  expect(ctx.scheduler.tryAcquire(schedulable)).toBe(true);
  const rt = ctx.runState.nodes.get(node.id)!;
  rt.status = "running";
  if (rt.startedAt === undefined) rt.startedAt = Date.now();
  return schedulable;
}

/** A scripted event factory adapter that varies by attempt. */
function scriptedAdapter(
  factory: (ctx?: NodeInvocationContext) => NormalizedEvent[],
): AgentAdapter {
  return createFakeAdapter({ events: factory });
}

// ═══════════════════════════════════════════════════════════════════════════
// depsMet
// ═══════════════════════════════════════════════════════════════════════════

describe("depsMet", () => {
  it("returns true for a node with no predecessors and no declared dependsOn", () => {
    const ir = singleNodeIR("solo");
    const ctx = ctxFor(ir);
    expect(depsMet(ctx, "solo")).toBe(true);
  });

  it("returns true when every edge predecessor is completed", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "a", kind: "node", profileRef: "default", prompt: "a" },
        { id: "b", kind: "node", profileRef: "default", prompt: "b" },
      ],
      edges: [{ from: "a", to: "b", kind: "dep" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    ctx.runState.nodes.get("a")!.status = "completed";
    expect(depsMet(ctx, "b")).toBe(true);
  });

  it("returns false when an edge predecessor is still pending", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "a", kind: "node", profileRef: "default", prompt: "a" },
        { id: "b", kind: "node", profileRef: "default", prompt: "b" },
      ],
      edges: [{ from: "a", to: "b", kind: "dep" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    ctx.runState.nodes.get("a")!.status = "ready";
    expect(depsMet(ctx, "b")).toBe(false);
  });

  it("returns false when an edge predecessor is missing from runState", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [{ id: "b", kind: "node", profileRef: "default", prompt: "b" }],
      edges: [{ from: "ghost", to: "b", kind: "dep" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    expect(depsMet(ctx, "b")).toBe(false);
  });

  it("returns false when a declared dependsOn dep is not completed", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "a", kind: "node", profileRef: "default", prompt: "a" },
        { id: "b", kind: "node", profileRef: "default", prompt: "b", dependsOn: ["a"] },
      ],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    ctx.runState.nodes.get("a")!.status = "running";
    expect(depsMet(ctx, "b")).toBe(false);
  });

  it("returns true when declared dependsOn deps are all completed (no edges)", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "a", kind: "node", profileRef: "default", prompt: "a" },
        { id: "c", kind: "node", profileRef: "default", prompt: "c" },
        { id: "b", kind: "node", profileRef: "default", prompt: "b", dependsOn: ["a", "c"] },
      ],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    ctx.runState.nodes.get("a")!.status = "completed";
    ctx.runState.nodes.get("c")!.status = "completed";
    expect(depsMet(ctx, "b")).toBe(true);
  });

  it("combines edges + declared dependsOn: all must be completed", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "a", kind: "node", profileRef: "default", prompt: "a" },
        { id: "c", kind: "node", profileRef: "default", prompt: "c" },
        { id: "b", kind: "node", profileRef: "default", prompt: "b", dependsOn: ["c"] },
      ],
      edges: [{ from: "a", to: "b", kind: "dep" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    ctx.runState.nodes.get("a")!.status = "completed";
    // c (declared dep) not yet completed → false
    expect(depsMet(ctx, "b")).toBe(false);
    ctx.runState.nodes.get("c")!.status = "completed";
    expect(depsMet(ctx, "b")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildPrompt
// ═══════════════════════════════════════════════════════════════════════════

describe("buildPrompt", () => {
  it("returns the static prompt when no override and no promptFnRef", () => {
    const ir = singleNodeIR("n", { prompt: "hello" });
    const ctx = ctxFor(ir);
    expect(buildPrompt(ctx, ctx.nodeMap.get("n")!)).toBe("hello");
  });

  it("returns '' when a plain node has no prompt and no promptFnRef", () => {
    const ir = singleNodeIR("n", { prompt: undefined });
    const ctx = ctxFor(ir);
    expect(buildPrompt(ctx, ctx.nodeMap.get("n")!)).toBe("");
  });

  it("returns '' for non-node structural kinds", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        {
          id: "f",
          kind: "fanOut",
          from: "p",
          iterateFnRef: fn("(ctx) => []", "iterate"),
          eachFnRef: fn("(item) => null", "each"),
        },
      ],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    expect(buildPrompt(ctx, ctx.nodeMap.get("f")!)).toBe("");
  });

  it("a promptOverride takes precedence over static prompt and promptFnRef", () => {
    const promptFnRef: FnDescriptor = fn('(ctx) => "from-fn"', "prompt");
    const ir = singleNodeIR("n", { prompt: "static", promptFnRef });
    const ctx = ctxFor(ir);
    ctx.promptOverrides.set("n", "OVERRIDE");
    expect(buildPrompt(ctx, ctx.nodeMap.get("n")!)).toBe("OVERRIDE");
  });

  it("rehydrates a promptFnRef that returns a string", () => {
    const promptFnRef: FnDescriptor = fn('(ctx) => "computed-" + ctx.run.runId', "prompt");
    const ir = singleNodeIR("n", { promptFnRef });
    const ctx = ctxFor(ir);
    // runId from makeRunState defaults to "run-test".
    expect(buildPrompt(ctx, ctx.nodeMap.get("n")!)).toBe("computed-run-test");
  });

  it("JSON-stringifies a promptFnRef that returns a non-string object", () => {
    const promptFnRef: FnDescriptor = fn("(ctx) => ({ a: 1, b: 2 })", "prompt");
    const ir = singleNodeIR("n", { promptFnRef });
    const ctx = ctxFor(ir);
    expect(buildPrompt(ctx, ctx.nodeMap.get("n")!)).toBe(JSON.stringify({ a: 1, b: 2 }));
  });

  it("returns '' when a promptFnRef returns undefined or null", () => {
    const ir = singleNodeIR("n", {
      prompt: "fallback",
      promptFnRef: fn("(ctx) => undefined", "prompt"),
    });
    const ctx = ctxFor(ir);
    expect(buildPrompt(ctx, ctx.nodeMap.get("n")!)).toBe("");
  });

  it("falls back to the static prompt when the promptFnRef throws", () => {
    const ir = singleNodeIR("n", {
      prompt: "fallback",
      promptFnRef: fn('(ctx) => { throw new Error("boom") }', "prompt"),
    });
    const ctx = ctxFor(ir);
    expect(buildPrompt(ctx, ctx.nodeMap.get("n")!)).toBe("fallback");
  });

  it("promptFnRef can read a completed predecessor's output via ctx.output()", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "a", kind: "node", profileRef: "default", prompt: "a" },
        {
          id: "b",
          kind: "node",
          profileRef: "default",
          promptFnRef: fn('(ctx) => "use:" + JSON.stringify(ctx.output("a"))', "prompt"),
        },
      ],
      edges: [{ from: "a", to: "b", kind: "dep" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    ctx.runState.nodes.get("a")!.status = "completed";
    ctx.runState.nodes.get("a")!.parsedOutput = { verdict: "ok" };
    expect(buildPrompt(ctx, ctx.nodeMap.get("b")!)).toBe('use:{"verdict":"ok"}');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// failNode
// ═══════════════════════════════════════════════════════════════════════════

describe("failNode", () => {
  it("marks the node failed with the message and sets endedAt", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "b", kind: "node", profileRef: "default", prompt: "b" },
        { id: "c", kind: "node", profileRef: "default", prompt: "c" },
      ],
      edges: [{ from: "b", to: "c", kind: "dep" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    const rt = ctx.runState.nodes.get("b")!;
    const before = Date.now();

    failNode(ctx, "b", rt, "kaboom");

    expect(rt.status).toBe("failed");
    expect(rt.error).toBe("kaboom");
    expect(rt.endedAt).toBeGreaterThanOrEqual(before);
  });

  it("propagates 'dep-failed' skip to transitive dependents (default reason)", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "a", kind: "node", profileRef: "default", prompt: "a" },
        { id: "b", kind: "node", profileRef: "default", prompt: "b" },
        { id: "c", kind: "node", profileRef: "default", prompt: "c" },
        { id: "d", kind: "node", profileRef: "default", prompt: "d" },
      ],
      edges: [
        { from: "a", to: "b", kind: "dep" },
        { from: "b", to: "c", kind: "dep" },
        { from: "c", to: "d", kind: "dep" },
      ],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    const rt = ctx.runState.nodes.get("b")!;

    failNode(ctx, "b", rt, "b failed");

    // b failed, c and d transitively skipped with dep-failed.
    expect(ctx.runState.nodes.get("b")?.status).toBe("failed");
    expect(ctx.runState.nodes.get("c")?.status).toBe("skipped");
    expect(ctx.runState.nodes.get("c")?.error).toBe("dep-failed");
    expect(ctx.runState.nodes.get("d")?.status).toBe("skipped");
    expect(ctx.runState.nodes.get("d")?.error).toBe("dep-failed");
    // a is independent of b → untouched.
    expect(ctx.runState.nodes.get("a")?.status).toBe("pending");
  });

  it("accepts a custom skip reason", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "g", kind: "node", profileRef: "default", prompt: "g" },
        { id: "c", kind: "node", profileRef: "default", prompt: "c" },
      ],
      edges: [{ from: "g", to: "c", kind: "cond:branch" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    const rt = ctx.runState.nodes.get("g")!;

    failNode(ctx, "g", rt, "gate failed", "cond-not-taken");

    expect(ctx.runState.nodes.get("c")?.status).toBe("skipped");
    expect(ctx.runState.nodes.get("c")?.error).toBe("cond-not-taken");
  });

  it("does NOT skip an already-completed dependent", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "a", kind: "node", profileRef: "default", prompt: "a" },
        { id: "b", kind: "node", profileRef: "default", prompt: "b" },
        { id: "c", kind: "node", profileRef: "default", prompt: "c" },
      ],
      edges: [
        { from: "a", to: "b", kind: "dep" },
        { from: "b", to: "c", kind: "dep" },
      ],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    // b already completed before a failed (independent timing).
    ctx.runState.nodes.get("b")!.status = "completed";
    const rt = ctx.runState.nodes.get("a")!;

    failNode(ctx, "a", rt, "a failed");

    expect(ctx.runState.nodes.get("b")?.status).toBe("completed");
  });

  it("invokes notify after failing", () => {
    const ir = singleNodeIR("n");
    const notify = vi.fn();
    const ctx = ctxFor(ir, { notify });
    const rt = ctx.runState.nodes.get("n")!;

    failNode(ctx, "n", rt, "x");

    expect(notify).toHaveBeenCalled();
  });

  it("writes audit.nodeFail + audit.nodeSkip for each skipped dependent when audit is set", () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "a", kind: "node", profileRef: "default", prompt: "a" },
        { id: "b", kind: "node", profileRef: "default", prompt: "b" },
        { id: "c", kind: "node", profileRef: "default", prompt: "c" },
      ],
      edges: [
        { from: "a", to: "b", kind: "dep" },
        { from: "b", to: "c", kind: "dep" },
      ],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const audit = makeFakeAudit();
    const ctx = ctxFor(ir, { audit });
    const rt = ctx.runState.nodes.get("a")!;

    failNode(ctx, "a", rt, "a failed");

    expect(audit.nodeFail).toHaveBeenCalledWith("a", "a failed");
    // b and c both skipped → nodeSkip called for each with "dep-failed".
    const skippedIds = audit.nodeSkip.mock.calls.map((c) => c[0]);
    expect(skippedIds).toEqual(expect.arrayContaining(["b", "c"]));
    for (const call of audit.nodeSkip.mock.calls) {
      expect(call[1]).toBe("dep-failed");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runNode
// ═══════════════════════════════════════════════════════════════════════════

describe("runNode", () => {
  it("completes a node on a successful adapter run and records telemetry", async () => {
    const ir = singleNodeIR("n");
    const ctx = ctxFor(ir, {
      getAdapter: () =>
        scriptedAdapter(() => [
          { type: "session", id: "sess-1" },
          { type: "tool_call", name: "edit", args: { path: "a.ts" } },
          {
            type: "done",
            sessionId: "sess-1",
            finalText: "all done",
            durationMs: 7,
            toolCallCount: 1,
          },
        ]),
    });
    const node = ctx.nodeMap.get("n")!;
    const schedulable = acquireAndRun(ctx, node);

    await runNode(ctx, node, schedulable);

    const rt = ctx.runState.nodes.get("n")!;
    expect(rt.status).toBe("completed");
    expect(rt.attempts).toBe(1);
    expect(rt.sessionId).toBe("sess-1");
    expect(rt.finalText).toBe("all done");
    expect(rt.toolCount).toBe(1);
    expect(rt.endedAt).toBeGreaterThanOrEqual(rt.startedAt!);
    // Slot released back to the pool.
    expect(ctx.scheduler.usage().global.used).toBe(0);
  });

  it("synthesizes a done event when the adapter stream lacks one", async () => {
    const ir = singleNodeIR("n");
    const ctx = ctxFor(ir, {
      getAdapter: () =>
        scriptedAdapter(() => [
          { type: "session", id: "s2" },
          { type: "message_complete", text: "streamed final text" },
        ]),
    });
    const node = ctx.nodeMap.get("n")!;
    const schedulable = acquireAndRun(ctx, node);

    await runNode(ctx, node, schedulable);

    const rt = ctx.runState.nodes.get("n")!;
    expect(rt.status).toBe("completed");
    // finalText reconciled from the synthesized done event (message_complete).
    expect(rt.finalText).toBe("streamed final text");
  });

  it("fails a node on a non-retryable error when retries are exhausted (0 retries)", async () => {
    const ir = singleNodeIR("n", {}, { defaultRetries: 0 });
    const ctx = ctxFor(ir, {
      defaultRetries: 0,
      getAdapter: () =>
        scriptedAdapter(() => [{ type: "error", message: "fatal", retryable: false }]),
    });
    const node = ctx.nodeMap.get("n")!;
    const schedulable = acquireAndRun(ctx, node);

    await runNode(ctx, node, schedulable);

    const rt = ctx.runState.nodes.get("n")!;
    expect(rt.status).toBe("failed");
    expect(rt.error).toBe("fatal");
    expect(rt.attempts).toBe(1);
    expect(ctx.scheduler.usage().global.used).toBe(0);
  });

  it("retries a retryable error with fresh session, then succeeds within budget", async () => {
    const ir = singleNodeIR("n", {}, { defaultRetries: 1 });
    const ctx = ctxFor(ir, {
      defaultRetries: 1,
      retryBackoff: 5,
      getAdapter: () =>
        scriptedAdapter((c) => {
          if ((c?.attempt ?? 1) <= 1) {
            return [{ type: "error", message: "transient", retryable: true }];
          }
          return [
            { type: "session", id: "sess-2" },
            {
              type: "done",
              sessionId: "sess-2",
              finalText: "recovered",
              durationMs: 1,
              toolCallCount: 0,
            },
          ];
        }),
    });
    const node = ctx.nodeMap.get("n")!;
    const schedulable = acquireAndRun(ctx, node);

    await runNode(ctx, node, schedulable);

    const rt = ctx.runState.nodes.get("n")!;
    expect(rt.status).toBe("completed");
    expect(rt.attempts).toBe(2);
    expect(rt.finalText).toBe("recovered");
    expect(ctx.scheduler.usage().global.used).toBe(0);
  });

  it("fails after exhausting retries on a persistently-retryable error", async () => {
    const ir = singleNodeIR("n", {}, { defaultRetries: 1 });
    const ctx = ctxFor(ir, {
      defaultRetries: 1,
      retryBackoff: 5,
      getAdapter: () =>
        scriptedAdapter(() => [{ type: "error", message: "always", retryable: true }]),
    });
    const node = ctx.nodeMap.get("n")!;
    const schedulable = acquireAndRun(ctx, node);

    await runNode(ctx, node, schedulable);

    const rt = ctx.runState.nodes.get("n")!;
    expect(rt.status).toBe("failed");
    expect(rt.error).toBe("always");
    // 1 initial + 1 retry = 2 attempts.
    expect(rt.attempts).toBe(2);
    expect(ctx.scheduler.usage().global.used).toBe(0);
  });

  it("completes with parsedOutput when the output matches outputSchema", async () => {
    const schema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    };
    const ir = singleNodeIR("n", { outputSchema: schema }, {});
    const ctx = ctxFor(ir, {
      getAdapter: () =>
        scriptedAdapter(() => [
          { type: "session", id: "s" },
          {
            type: "done",
            sessionId: "s",
            finalText: JSON.stringify({ verdict: "approved" }),
            durationMs: 1,
            toolCallCount: 0,
          },
        ]),
    });
    const node = ctx.nodeMap.get("n")!;
    const schedulable = acquireAndRun(ctx, node);

    await runNode(ctx, node, schedulable);

    const rt = ctx.runState.nodes.get("n")!;
    expect(rt.status).toBe("completed");
    expect(rt.parsedOutput).toEqual({ verdict: "approved" });
  });

  it("fails (0 retries) when the output violates outputSchema", async () => {
    const schema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    };
    const ir = singleNodeIR("n", { outputSchema: schema }, { defaultRetries: 0 });
    const ctx = ctxFor(ir, {
      defaultRetries: 0,
      getAdapter: () =>
        scriptedAdapter(() => [
          { type: "session", id: "s" },
          {
            type: "done",
            sessionId: "s",
            finalText: JSON.stringify({ wrong: "shape" }),
            durationMs: 1,
            toolCallCount: 0,
          },
        ]),
    });
    const node = ctx.nodeMap.get("n")!;
    const schedulable = acquireAndRun(ctx, node);

    await runNode(ctx, node, schedulable);

    const rt = ctx.runState.nodes.get("n")!;
    expect(rt.status).toBe("failed");
    expect(rt.error ?? "").toMatch(/schema validation failed/i);
  });

  it("prefers ir.schemas[nodeId] over node.outputSchema for validation", async () => {
    const nodeSchema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    const irSchema = {
      type: "object",
      properties: { b: { type: "string" } },
      required: ["b"],
    };
    const ir = singleNodeIR("n", { outputSchema: nodeSchema });
    ir.schemas["n"] = irSchema;
    const ctx = ctxFor(ir, {
      getAdapter: () =>
        scriptedAdapter(() => [
          { type: "session", id: "s" },
          {
            type: "done",
            sessionId: "s",
            finalText: JSON.stringify({ b: "ok" }),
            durationMs: 1,
            toolCallCount: 0,
          },
        ]),
    });
    const node = ctx.nodeMap.get("n")!;
    const schedulable = acquireAndRun(ctx, node);

    await runNode(ctx, node, schedulable);

    // ir.schemas won → { b: "ok" } validates, { a } would not.
    const rt = ctx.runState.nodes.get("n")!;
    expect(rt.status).toBe("completed");
    expect(rt.parsedOutput).toEqual({ b: "ok" });
  });

  it("fails with 'aborted' when the signal is already aborted at attempt start", async () => {
    const ir = singleNodeIR("n");
    const controller = new AbortController();
    controller.abort();
    const ctx = ctxFor(ir, {
      signal: controller.signal,
      getAdapter: () =>
        scriptedAdapter(() => [
          { type: "session", id: "s" },
          { type: "done", sessionId: "s", finalText: "x", durationMs: 1, toolCallCount: 0 },
        ]),
    });
    const node = ctx.nodeMap.get("n")!;
    const schedulable = acquireAndRun(ctx, node);

    await runNode(ctx, node, schedulable);

    const rt = ctx.runState.nodes.get("n")!;
    expect(rt.status).toBe("failed");
    expect(rt.error).toBe("aborted");
    expect(ctx.scheduler.usage().global.used).toBe(0);
  });

  it("fails with 'aborted' when the signal aborts after the run completes but before outcome evaluation", async () => {
    const ir = singleNodeIR("n");
    const controller = new AbortController();
    const ctx = ctxFor(ir, {
      signal: controller.signal,
      getAdapter: () =>
        createFakeAdapter({
          sessionId: "s",
          finalText: "done-ish",
          durationMs: 1,
          events: (): NormalizedEvent[] => {
            // Abort right as the (synchronous) event stream is produced,
            // before invokeAdapter resolves back to runNode.
            controller.abort();
            return [
              { type: "session", id: "s" },
              {
                type: "done",
                sessionId: "s",
                finalText: "done-ish",
                durationMs: 1,
                toolCallCount: 0,
              },
            ];
          },
        }),
    });
    const node = ctx.nodeMap.get("n")!;
    const schedulable = acquireAndRun(ctx, node);

    await runNode(ctx, node, schedulable);

    const rt = ctx.runState.nodes.get("n")!;
    expect(rt.status).toBe("failed");
    expect(rt.error).toBe("aborted");
    expect(ctx.scheduler.usage().global.used).toBe(0);
  });

  it("captures an adapter throw (emitEvents rejects) as a non-retryable node failure and releases the slot", async () => {
    const ir = singleNodeIR("n", {}, { defaultRetries: 3 });
    const ctx = ctxFor(ir, {
      defaultRetries: 3,
      getAdapter: () => {
        const a = createFakeAdapter({});
        a.emitEvents = async (): Promise<void> => {
          throw new Error("adapter exploded");
        };
        return a;
      },
    });
    const node = ctx.nodeMap.get("n")!;
    const schedulable = acquireAndRun(ctx, node);

    await runNode(ctx, node, schedulable);

    const rt = ctx.runState.nodes.get("n")!;
    expect(rt.status).toBe("failed");
    expect(rt.error ?? "").toMatch(/adapter exploded/);
    expect(ctx.scheduler.usage().global.used).toBe(0);
  });

  it("records audit.nodeTool / nodeComplete / nodeRetry events when audit is set", async () => {
    const ir = singleNodeIR("n", {}, { defaultRetries: 1 });
    const audit = makeFakeAudit();
    const ctx = ctxFor(ir, {
      defaultRetries: 1,
      retryBackoff: 5,
      audit,
      getAdapter: () =>
        scriptedAdapter((c) => {
          if ((c?.attempt ?? 1) <= 1) {
            return [
              { type: "session", id: "s" },
              { type: "tool_call", name: "edit", args: { path: "x.ts" } },
              { type: "error", message: "transient", retryable: true },
            ];
          }
          return [
            { type: "session", id: "s" },
            {
              type: "done",
              sessionId: "s",
              finalText: "ok",
              durationMs: 1,
              toolCallCount: 1,
            },
          ];
        }),
    });
    const node = ctx.nodeMap.get("n")!;
    const schedulable = acquireAndRun(ctx, node);

    await runNode(ctx, node, schedulable);

    // tool event emitted during the first attempt.
    expect(audit.nodeTool).toHaveBeenCalledWith("n", "edit");
    // retry audited for attempt 1.
    expect(audit.nodeRetry).toHaveBeenCalledWith("n", 1, expect.any(String));
    // completion audited.
    expect(audit.nodeComplete).toHaveBeenCalledWith(
      "n",
      expect.objectContaining({ sessionId: "s" }),
    );
  });

  it("propagates skip to dependents when a node fails (end-to-end within runNode)", async () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: { defaultRetries: 0 },
      nodes: [
        { id: "a", kind: "node", profileRef: "default", prompt: "a" },
        { id: "b", kind: "node", profileRef: "default", prompt: "b" },
      ],
      edges: [{ from: "a", to: "b", kind: "dep" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir, {
      defaultRetries: 0,
      getAdapter: (_t, nodeId) =>
        nodeId === "a"
          ? scriptedAdapter(() => [{ type: "error", message: "a-fail", retryable: false }])
          : scriptedAdapter(() => [
              { type: "done", sessionId: "s", finalText: "b", durationMs: 1, toolCallCount: 0 },
            ]),
    });
    const node = ctx.nodeMap.get("a")!;
    const schedulable = acquireAndRun(ctx, node);

    await runNode(ctx, node, schedulable);

    expect(ctx.runState.nodes.get("a")?.status).toBe("failed");
    // b is a dependent of a → must be skipped via failNode → propagateSkip.
    expect(ctx.runState.nodes.get("b")?.status).toBe("skipped");
    expect(ctx.runState.nodes.get("b")?.error).toBe("dep-failed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Slot-release invariant across all runNode exit paths (unit level)
// ═══════════════════════════════════════════════════════════════════════════

describe("runNode slot-release invariant", () => {
  function twoPoolCtx(): { ctx: ExecutorContext; node: IRNode } {
    const ir = singleNodeIR("n", {}, { defaultRetries: 0 });
    const ctx = ctxFor(ir, {
      scheduler: createScheduler({
        maxAgentConcurrency: 2,
        limits: { byProvider: { zai: 1 } },
      }),
      defaultRetries: 0,
      // Failing adapter so the node fails non-retryably.
      getAdapter: () =>
        scriptedAdapter(() => [{ type: "error", message: "boom", retryable: false }]),
      profiles: { inlineProfiles: { default: { provider: "zai" } } },
    });
    return { ctx, node: ctx.nodeMap.get("n")! };
  }

  it("releases both global and provider slots on a non-retryable failure", async () => {
    const { ctx, node } = twoPoolCtx();
    // Provider-pool schedulable mirrors what executeDAG would build.
    const schedulable: SchedulableNode = { agentType: resolveAgentType(node), provider: "zai" };
    ctx.scheduler.tryAcquire(schedulable);
    const rt = ctx.runState.nodes.get(node.id)!;
    rt.status = "running";
    rt.startedAt = Date.now();

    await runNode(ctx, node, schedulable);

    expect(ctx.runState.nodes.get("n")?.status).toBe("failed");
    expect(ctx.scheduler.usage().global.used).toBe(0);
    expect(ctx.scheduler.usage().byProvider.zai?.used ?? 0).toBe(0);
  });
});
