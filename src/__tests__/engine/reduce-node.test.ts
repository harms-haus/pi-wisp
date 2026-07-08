/**
 * RED-phase tests — reduce-node.ts (executeReduceNode).
 *
 * Pins the reduce / synthesis behavior currently inlined as a closure inside
 * `executeDAG` (`executeReduceNode(node)`). The green team will extract it to
 * `src/engine/reduce-node.ts` as `executeReduceNode(ctx, node)` receiving an
 * {@link ExecutorContext}.
 *
 * Behaviors pinned (mirror the inline closure exactly):
 *   - no-op for non-reduce nodes and for reduce nodes absent from runState
 *   - pure-JS merge (no profileRef): deep-merge member parsedOutputs
 *   - agent-run synthesis (profileRef): dispatch to adapter, parse output
 *   - adapter throw captured into node failure (never rejects) + propagateSkip
 *   - executeSynthesis error → node failed + propagateSkip
 *   - council instruction prompt (primitive.meta.prompt) plumbed to synthesis
 *   - audit.nodeFail / nodeSkip emitted on the failure path
 *
 * RED today because `src/engine/reduce-node.ts` does not exist.
 */

import { describe, it, expect } from "vitest";

import { executeReduceNode } from "../../engine/reduce-node.js";
import type { ExecutorContext } from "../../engine/executor-types.js";

import type { GraphIR, IRNode, NormalizedEvent } from "../../types.js";
import type { NodeInvocationContext } from "../../adapters/types.js";
import { createFakeAdapter } from "../helpers/fake-adapter.js";
import {
  makeExecutorContext,
  makeFakeAudit,
  type MakeCtxOptions,
} from "../helpers/executor-context.js";
import { makeRunState } from "../helpers/fixtures.js";

// ── Helpers ──────────────────────────────────────────────────────────

function ctxFor(ir: GraphIR, opts: Partial<MakeCtxOptions> = {}): ExecutorContext {
  return makeExecutorContext({ ir, runState: makeRunState(ir), ...opts });
}

/** Mark a node completed with a parsed output object. */
function complete(ctx: ExecutorContext, id: string, output: unknown): void {
  const rt = ctx.runState.nodes.get(id);
  if (!rt) throw new Error(`node ${id} missing`);
  rt.status = "completed";
  rt.parsedOutput = output;
}

function reduceIR(
  reduceId: string,
  from: string[],
  memberPrompts: Record<string, string>,
  extra: Partial<IRNode> = {},
): GraphIR {
  const nodes: IRNode[] = [];
  for (const memberId of from) {
    nodes.push({
      id: memberId,
      kind: "node",
      profileRef: "default",
      prompt: memberPrompts[memberId] ?? "m",
    });
  }
  nodes.push({ id: reduceId, kind: "reduce", from, ...extra } as IRNode);
  return {
    title: "reduce",
    slug: "reduce",
    options: {},
    nodes,
    edges: from.map((m) => ({ from: m, to: reduceId, kind: "dep" as const })),
    conditions: [],
    schemas: {},
    primitives: {},
  };
}

/** A fake adapter that captures the prompt it was invoked with, then emits JSON. */
function capturingAdapter(finalJson: string): {
  adapter: ReturnType<typeof createFakeAdapter>;
  capturedPrompt: () => string;
} {
  let prompt = "";
  const adapter = createFakeAdapter({});
  adapter.emitEvents = async (
    onEvent: (event: NormalizedEvent) => void,
    ctx?: NodeInvocationContext,
  ): Promise<void> => {
    prompt = ctx?.prompt ?? "";
    onEvent({ type: "session", id: "synth-sess" });
    onEvent({
      type: "done",
      sessionId: "synth-sess",
      finalText: finalJson,
      durationMs: 1,
      toolCallCount: 0,
    });
  };
  return { adapter, capturedPrompt: () => prompt };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("executeReduceNode", () => {
  it("is a no-op for a non-reduce node kind", async () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [{ id: "plain", kind: "node", profileRef: "default", prompt: "p" }],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir);
    const before = ctx.runState.nodes.get("plain")?.status;

    await executeReduceNode(ctx, ctx.nodeMap.get("plain")!);

    expect(ctx.runState.nodes.get("plain")?.status).toBe(before);
  });

  it("is a no-op when the reduce node is absent from runState", async () => {
    const ir = reduceIR("r", ["m1"], { m1: "m1" });
    const ctx = ctxFor(ir);
    ctx.runState.nodes.delete("r");

    await executeReduceNode(ctx, ctx.nodeMap.get("r")!);

    // Nothing re-created; no throw.
    expect(ctx.runState.nodes.has("r")).toBe(false);
  });

  it("pure-JS deep-merges member parsedOutputs when no profile is set", async () => {
    const ir = reduceIR("r", ["m1", "m2"], { m1: "m1", m2: "m2" });
    const ctx = ctxFor(ir);
    complete(ctx, "m1", { a: 1, shared: "from-m1" });
    complete(ctx, "m2", { a: 2, b: 3, shared: "from-m2" });

    await executeReduceNode(ctx, ctx.nodeMap.get("r")!);

    const rt = ctx.runState.nodes.get("r")!;
    expect(rt.status).toBe("completed");
    // last-writer-wins for `a` and `shared`; b preserved.
    expect(rt.parsedOutput).toEqual({ a: 2, b: 3, shared: "from-m2" });
    expect(rt.finalText).toBe(JSON.stringify({ a: 2, shared: "from-m2", b: 3 }, null, 2));
    expect(rt.endedAt).toBeGreaterThan(0);
  });

  it("pure-JS merge wraps mixed/scalar outputs into { merged, count }", async () => {
    const ir = reduceIR("r", ["m1", "m2"], { m1: "m1", m2: "m2" });
    const ctx = ctxFor(ir);
    complete(ctx, "m1", "a string");
    complete(ctx, "m2", 42);

    await executeReduceNode(ctx, ctx.nodeMap.get("r")!);

    const rt = ctx.runState.nodes.get("r")!;
    expect(rt.status).toBe("completed");
    expect(rt.parsedOutput).toEqual({ merged: ["a string", 42], count: 2 });
  });

  it("agent-run synthesis: parses the adapter's JSON output into parsedOutput", async () => {
    const ir = reduceIR("r", ["m1"], { m1: "m1" }, { profileRef: "default", agentType: "pi" });
    const { adapter } = capturingAdapter(JSON.stringify({ verdict: "merged" }));
    const ctx = ctxFor(ir, {
      getAdapter: () => adapter,
      profiles: { inlineProfiles: { default: { agentType: "pi" } } },
    });
    complete(ctx, "m1", { result: "ok" });

    await executeReduceNode(ctx, ctx.nodeMap.get("r")!);

    const rt = ctx.runState.nodes.get("r")!;
    expect(rt.status).toBe("completed");
    expect(rt.parsedOutput).toEqual({ verdict: "merged" });
    // finalText is the re-stringified parsed output.
    expect(rt.finalText).toBe(JSON.stringify({ verdict: "merged" }, null, 2));
  });

  it("agent-run synthesis: uses raw text as output when not valid JSON", async () => {
    const ir = reduceIR("r", ["m1"], { m1: "m1" }, { profileRef: "default", agentType: "pi" });
    const { adapter } = capturingAdapter("not json at all");
    const ctx = ctxFor(ir, {
      getAdapter: () => adapter,
      profiles: { inlineProfiles: { default: { agentType: "pi" } } },
    });
    complete(ctx, "m1", { result: "ok" });

    await executeReduceNode(ctx, ctx.nodeMap.get("r")!);

    const rt = ctx.runState.nodes.get("r")!;
    expect(rt.status).toBe("completed");
    // executeSynthesis returns the raw string; executeReduceNode keeps it as-is.
    expect(rt.parsedOutput).toBe("not json at all");
    expect(rt.finalText).toBe("not json at all");
  });

  it("captures an adapter throw into a node failure (never rejects) + propagates skip", async () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "m1", kind: "node", profileRef: "default", prompt: "m" },
        {
          id: "r",
          kind: "reduce",
          from: ["m1"],
          profileRef: "default",
          agentType: "pi",
        },
        { id: "downstream", kind: "node", profileRef: "default", prompt: "d" },
      ],
      edges: [
        { from: "m1", to: "r", kind: "dep" },
        { from: "r", to: "downstream", kind: "dep" },
      ],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const throwingAdapter = createFakeAdapter({});
    throwingAdapter.emitEvents = async (): Promise<void> => {
      throw new Error("synth adapter exploded");
    };
    const ctx = ctxFor(ir, {
      getAdapter: (_t, nodeId) => (nodeId === "r" ? throwingAdapter : createFakeAdapter({})),
      profiles: { inlineProfiles: { default: { agentType: "pi" } } },
    });
    complete(ctx, "m1", { result: "ok" });

    // Must not reject.
    await expect(executeReduceNode(ctx, ctx.nodeMap.get("r")!)).resolves.toBeUndefined();

    const rt = ctx.runState.nodes.get("r")!;
    expect(rt.status).toBe("failed");
    expect(rt.error ?? "").toMatch(/synth adapter exploded/i);
    // Dependent of r is skipped.
    expect(ctx.runState.nodes.get("downstream")?.status).toBe("skipped");
    expect(ctx.runState.nodes.get("downstream")?.error).toBe("dep-failed");
  });

  it("marks the node failed + propagates skip when executeSynthesis returns an error (missing member)", async () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        // m1 referenced by `from` but NOT completed.
        { id: "m1", kind: "node", profileRef: "default", prompt: "m" },
        { id: "r", kind: "reduce", from: ["m1"], profileRef: "default", agentType: "pi" },
        { id: "dep", kind: "node", profileRef: "default", prompt: "d" },
      ],
      edges: [
        { from: "m1", to: "r", kind: "dep" },
        { from: "r", to: "dep", kind: "dep" },
      ],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const ctx = ctxFor(ir, {
      getAdapter: () => createFakeAdapter({}),
      profiles: { inlineProfiles: { default: { agentType: "pi" } } },
    });
    // m1 deliberately left pending.

    await executeReduceNode(ctx, ctx.nodeMap.get("r")!);

    const rt = ctx.runState.nodes.get("r")!;
    expect(rt.status).toBe("failed");
    expect(rt.error ?? "").toMatch(/m1/i);
    expect(ctx.runState.nodes.get("dep")?.status).toBe("skipped");
  });

  it("writes audit.nodeFail + audit.nodeSkip on the failure path", async () => {
    const ir: GraphIR = {
      title: "t",
      slug: "t",
      options: {},
      nodes: [
        { id: "m1", kind: "node", profileRef: "default", prompt: "m" },
        { id: "r", kind: "reduce", from: ["m1"], profileRef: "default", agentType: "pi" },
        { id: "dep", kind: "node", profileRef: "default", prompt: "d" },
      ],
      edges: [
        { from: "m1", to: "r", kind: "dep" },
        { from: "r", to: "dep", kind: "dep" },
      ],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const audit = makeFakeAudit();
    const throwingAdapter = createFakeAdapter({});
    throwingAdapter.emitEvents = async (): Promise<void> => {
      throw new Error("boom");
    };
    const ctx = ctxFor(ir, {
      audit,
      getAdapter: (_t, nodeId) => (nodeId === "r" ? throwingAdapter : createFakeAdapter({})),
      profiles: { inlineProfiles: { default: { agentType: "pi" } } },
    });
    complete(ctx, "m1", { result: "ok" });

    await executeReduceNode(ctx, ctx.nodeMap.get("r")!);

    expect(audit.nodeFail).toHaveBeenCalledWith("r", expect.stringMatching(/boom/i));
    expect(audit.nodeSkip).toHaveBeenCalledWith("dep", "dep-failed");
  });

  it("plumbs the council instruction prompt (primitive.meta.prompt) to the synthesis adapter", async () => {
    const ir = reduceIR(
      "r",
      ["m1"],
      { m1: "m1" },
      {
        profileRef: "default",
        agentType: "pi",
        primitive: { kind: "council", meta: { prompt: "Weigh disagreement carefully." } },
      },
    );
    const { adapter, capturedPrompt } = capturingAdapter(JSON.stringify({ out: 1 }));
    const ctx = ctxFor(ir, {
      getAdapter: () => adapter,
      profiles: { inlineProfiles: { default: { agentType: "pi" } } },
    });
    complete(ctx, "m1", { view: "A" });

    await executeReduceNode(ctx, ctx.nodeMap.get("r")!);

    expect(ctx.runState.nodes.get("r")?.status).toBe("completed");
    // The custom instruction must appear in the merge prompt sent to the adapter.
    expect(capturedPrompt()).toContain("Weigh disagreement carefully.");
  });
});
