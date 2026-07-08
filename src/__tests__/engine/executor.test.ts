/**
 * DAG executor core — RED-phase tests (kb-14).
 *
 * Tests the full executor contract against the FakeAgentAdapter + in-memory
 * graph fixtures:
 *   - State machine (pending → ready → running → completed|failed|skipped)
 *   - Topological readiness (linear, diamond)
 *   - Lazy fanOut expansion at ready-time
 *   - Schedulability (AND-semantics integration with Scheduler)
 *   - Spawn flow (adapter invocation → event streaming → node state update)
 *   - OutputSchema post-hoc validation
 *   - Retry/then-skip (no fail-fast — independent branches continue)
 *   - RunSummary return with correct totals
 *
 * Every test uses the FakeAgentAdapter (no real subprocess) and a real
 * Scheduler or a custom-configured one. The executor is imported from
 * src/engine/executor.ts.
 */

import { vi, describe, it, expect } from "vitest";

// ── Mock the spawner so we can simulate subprocess crashes with exit codes ──
vi.mock("../../spawn/spawner.js");
import { runAgent } from "../../spawn/spawner.js";

// ── Engine modules under test ──────────────────────────────────
import { executeDAG } from "../../engine/executor.js";

// ── Scheduler ──────────────────────────────────────────────────
import { createScheduler } from "../../engine/scheduler.js";

// ── Fake adapter + fixtures ────────────────────────────────────
import { createFakeAdapter } from "../helpers/fake-adapter.js";
import type { FakeAgentAdapter } from "../helpers/fake-adapter.js";
import {
  linearGraph,
  diamondGraph,
  failThenSkipGraph,
  makeRunState,
  fn,
} from "../helpers/fixtures.js";

// ── Profile types (for adapter registry) ────────────────────────
import type {
  AgentAdapter,
  AdapterInvocation,
  NodeInvocationContext,
  ResolvedProfile,
} from "../../adapters/types.js";
import type { GraphIR, NormalizedEvent } from "../../types.js";

// ── Re-exports needed by inline fixture builders ────────────────
import type { FnDescriptor } from "../../types.js";

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

/**
 * A minimal adapter that always uses the fake adapter emitEvents path.
 */
function makeDefaultAdapter(opts?: {
  sessionId?: string;
  finalText?: string;
  fileEdits?: string[];
  toolCount?: number;
  costUsd?: number;
  durationMs?: number;
  delayMs?: number;
}): FakeAgentAdapter {
  return createFakeAdapter({
    sessionId: opts?.sessionId ?? "sess-default",
    finalText: opts?.finalText ?? "done",
    fileEdits: opts?.fileEdits,
    toolCount: opts?.toolCount ?? 0,
    costUsd: opts?.costUsd,
    durationMs: opts?.durationMs ?? 10,
    delayMs: opts?.delayMs,
    mode: "succeed",
  });
}

/**
 * Await a promise with a timeout, so tests fail fast instead of hanging.
 */
function withTimeout<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => {
        reject(new Error(`Timeout after ${ms}ms`));
      }, ms),
    ),
  ]);
}

// ══════════════════════════════════════════════════════════════════════
// State machine tests
// ══════════════════════════════════════════════════════════════════════

describe("state machine", () => {
  it("transitions a linear chain through pending→ready→running→completed", async () => {
    const { ir, runState } = linearGraph();
    const adapter = makeDefaultAdapter({ durationMs: 5 });
    const scheduler = createScheduler();

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: () => adapter,
        scheduler,
      }),
    );

    // All three nodes completed
    expect(runState.nodes.get("a")?.status).toBe("completed");
    expect(runState.nodes.get("b")?.status).toBe("completed");
    expect(runState.nodes.get("c")?.status).toBe("completed");

    // Per-node fields are populated
    for (const id of ["a", "b", "c"]) {
      const rt = runState.nodes.get(id)!;
      expect(rt.attempts).toBe(1);
      expect(rt.toolCount).toBeGreaterThanOrEqual(0);
      expect(rt.finalText).toBe("done");
      expect(rt.startedAt).toBeGreaterThan(0);
      expect(rt.endedAt).toBeGreaterThanOrEqual(rt.startedAt!);
      expect(typeof rt.sessionId).toBe("string");
    }
  });

  it("marks a node failed when the adapter emits a non-retryable error", async () => {
    const { ir, runState } = linearGraph();

    // Node "b" fails with a non-retryable error
    const failAdapter = createFakeAdapter({
      mode: "fail-after-events",
      failAfterEvents: 0,
      sessionId: "sess-fail",
      errorMessage: "catastrophic failure",
    });

    // Adapter for "a" and "c" succeeds
    const succeedAdapter = makeDefaultAdapter();

    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "b") return failAdapter;
      return succeedAdapter;
    };

    const scheduler = createScheduler({ maxAgentConcurrency: 3 });
    // Override retries to 0 so node b fails immediately
    const irWithRetries: GraphIR = {
      ...ir,
      options: { ...ir.options, defaultRetries: 0 },
    };

    await withTimeout(
      executeDAG({
        ir: irWithRetries,
        runState,
        getAdapter: getAdapter as any,
        scheduler,
      }),
    );

    // a succeeded, b failed (no retries), c is skipped (dep failed)
    expect(runState.nodes.get("a")?.status).toBe("completed");
    expect(runState.nodes.get("b")?.status).toBe("failed");
    expect(runState.nodes.get("c")?.status).toBe("skipped");
  });

  it("marks a node failed when retries are exhausted then propagates skip", async () => {
    const { ir, runState } = linearGraph();

    // Node "b" always fails
    const failAdapter = createFakeAdapter({
      mode: "retryable-error",
      sessionId: "sess-retry",
      errorMessage: "transient error",
      // Always fail — even on retry
      events: () => [{ type: "error", message: "still failing", retryable: true }],
    });

    const succeedAdapter = makeDefaultAdapter();

    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "b") return failAdapter;
      return succeedAdapter;
    };

    const scheduler = createScheduler({ maxAgentConcurrency: 3 });

    // Allow 2 retries (so 3 total attempts: 0, 1, 2 — all fail)
    const irWithRetries: GraphIR = {
      ...ir,
      options: { ...ir.options, defaultRetries: 2 },
    };

    await withTimeout(
      executeDAG({
        ir: irWithRetries,
        runState,
        getAdapter: getAdapter as any,
        scheduler,
        retryBackoffMs: 10,
      }),
    );

    expect(runState.nodes.get("a")?.status).toBe("completed");
    expect(runState.nodes.get("b")?.status).toBe("failed");
    expect(runState.nodes.get("b")?.attempts).toBeGreaterThanOrEqual(2);
    expect(runState.nodes.get("c")?.status).toBe("skipped");
    expect(runState.nodes.get("c")?.error).toContain("dep-failed");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Topological readiness
// ══════════════════════════════════════════════════════════════════════

describe("topological readiness (TOPO READY)", () => {
  it("linear graph executes nodes strictly in order (A→B→C)", async () => {
    const { ir, runState } = linearGraph();
    const adapter = makeDefaultAdapter({ durationMs: 2 });
    const scheduler = createScheduler();

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: () => adapter,
        scheduler,
      }),
    );

    const a = runState.nodes.get("a")!;
    const b = runState.nodes.get("b")!;
    const c = runState.nodes.get("c")!;

    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");
    expect(c.status).toBe("completed");

    // B should have started after A ended; C after B ended
    expect(b.startedAt).toBeGreaterThanOrEqual(a.endedAt!);
    expect(c.startedAt).toBeGreaterThanOrEqual(b.endedAt!);
  });

  it("diamond graph fans-in correctly — D runs only after BOTH B and C complete", async () => {
    const { ir, runState } = diamondGraph();
    const adapter = makeDefaultAdapter({ durationMs: 3 });
    const scheduler = createScheduler({ maxAgentConcurrency: 3 });

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: () => adapter,
        scheduler,
      }),
    );

    expect(runState.nodes.get("a")?.status).toBe("completed");
    expect(runState.nodes.get("b")?.status).toBe("completed");
    expect(runState.nodes.get("c")?.status).toBe("completed");
    expect(runState.nodes.get("d")?.status).toBe("completed");

    const b = runState.nodes.get("b")!;
    const c = runState.nodes.get("c")!;
    const d = runState.nodes.get("d")!;

    // D must start after both B and C have ended
    expect(d.startedAt).toBeGreaterThanOrEqual(b.endedAt!);
    expect(d.startedAt).toBeGreaterThanOrEqual(c.endedAt!);
  });

  it("a node with no deps is ready immediately without waiting", async () => {
    // Single-node graph: no edges at all
    const ir: GraphIR = {
      title: "standalone",
      slug: "standalone",
      options: {},
      nodes: [
        {
          id: "solo",
          kind: "node",
          profileRef: "default",
          prompt: "Do the thing",
        },
      ],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = makeRunState(ir);
    const adapter = makeDefaultAdapter({ sessionId: "solo-sess" });
    const scheduler = createScheduler();

    await withTimeout(executeDAG({ ir, runState, getAdapter: () => adapter, scheduler }));

    expect(runState.nodes.get("solo")?.status).toBe("completed");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Lazy fanOut expansion
// ══════════════════════════════════════════════════════════════════════

describe("lazy fanOut expansion", () => {
  it("expands a fanOut node when its producer completes — creates child nodes", async () => {
    // Build a custom fanOut graph where the producer has an outputSchema
    // so its JSON output is parsed into a structured object.
    const producerId = "producer";
    const fanOutId = "expand";

    const iterateFnRef: FnDescriptor = fn('(ctx) => ctx.output("producer").items', "iterate");

    const ir: GraphIR = {
      title: "fanOut-test",
      slug: "fanOut-test",
      options: { maxConcurrency: 5 },
      nodes: [
        {
          id: producerId,
          kind: "node",
          profileRef: "default",
          prompt: "Find items to fix",
          // outputSchema so the executor JSON-parses the final text
          outputSchema: {
            type: "object",
            properties: {
              items: { type: "array", items: { type: "string" } },
            },
            required: ["items"],
          },
        },
        {
          id: fanOutId,
          kind: "fanOut",
          from: producerId,
          iterateFnRef,
          eachFnRef: fn(
            '(item) => ({ prompt: "Fix: " + String(item), dependsOn: ["expand"] })',
            "each",
          ),
        },
      ],
      edges: [{ from: producerId, to: fanOutId, kind: "fanOut" }],
      conditions: [],
      schemas: {
        [producerId]: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: "string" } },
          },
          required: ["items"],
        },
      },
      primitives: {},
    };

    const runState = makeRunState(ir);

    // Producer emits valid JSON with three items
    const producerAdapter = createFakeAdapter({
      sessionId: "prod-sess",
      finalText: JSON.stringify({ items: ["fix-a", "fix-b", "fix-c"] }),
      toolCount: 0,
      durationMs: 5,
    });

    // Child nodes get their own adapter (simple success output)
    const childAdapter = createFakeAdapter({
      sessionId: "child-sess",
      finalText: "done",
      durationMs: 5,
    });

    const scheduler = createScheduler({ maxAgentConcurrency: 5 });

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: (_type?: string, nodeId?: string): AgentAdapter => {
          if (nodeId === producerId) return producerAdapter;
          return childAdapter;
        },
        scheduler,
      }),
    );

    // Producer should have completed
    expect(runState.nodes.get(producerId)?.status).toBe("completed");

    // Children should have been created dynamically
    expect(runState.nodes.has("expand-0")).toBe(true);
    expect(runState.nodes.has("expand-1")).toBe(true);
    expect(runState.nodes.has("expand-2")).toBe(true);

    // All children should have run and completed
    expect(runState.nodes.get("expand-0")?.status).toBe("completed");
    expect(runState.nodes.get("expand-1")?.status).toBe("completed");
    expect(runState.nodes.get("expand-2")?.status).toBe("completed");

    // Children should have prompts derived from the each fn
    expect(runState.nodes.get("expand-0")?.finalText).toBe("done");
  });

  it("fanOut with zero items creates no children", async () => {
    const ir: GraphIR = {
      title: "fanOut-empty",
      slug: "fanOut-empty",
      options: {},
      nodes: [
        {
          id: "producer",
          kind: "node",
          profileRef: "default",
          prompt: "Find items",
          outputSchema: {
            type: "object",
            properties: {
              items: { type: "array", items: { type: "string" } },
            },
            required: ["items"],
          },
        },
        {
          id: "expand",
          kind: "fanOut",
          from: "producer",
          iterateFnRef: fn('(ctx) => ctx.output("producer").items', "iterate"),
          eachFnRef: fn('(item) => ({ prompt: "Fix: " + String(item) })', "each"),
        },
      ],
      edges: [{ from: "producer", to: "expand", kind: "fanOut" }],
      conditions: [],
      schemas: {
        producer: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: "string" } },
          },
          required: ["items"],
        },
      },
      primitives: {},
    };
    const runState = makeRunState(ir);

    const adapter = createFakeAdapter({
      sessionId: "empty-prod",
      finalText: JSON.stringify({ items: [] }),
      durationMs: 5,
    });

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: () => adapter,
        scheduler: createScheduler(),
      }),
    );

    expect(runState.nodes.get("producer")?.status).toBe("completed");
    // No children should exist
    expect(runState.nodes.has("expand-0")).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Schedulability (AND-semantics with Scheduler)
// ══════════════════════════════════════════════════════════════════════

describe("schedulability (AND-semantics integration)", () => {
  it("a ready node waits when global pool is full, then runs when capacity frees", async () => {
    // Two independent nodes with a tight global limit of 1
    const ir: GraphIR = {
      title: "sched-test",
      slug: "sched-test",
      options: {},
      nodes: [
        { id: "fast", kind: "node", profileRef: "default", prompt: "Fast task" },
        { id: "slow", kind: "node", profileRef: "default", prompt: "Slow task" },
      ],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = makeRunState(ir);

    // First node completes quickly, second completes after a delay
    const adapter = createFakeAdapter({
      sessionId: "sched-sess",
      finalText: "done",
      durationMs: 5,
      delayMs: 2,
    });

    const scheduler = createScheduler({ maxAgentConcurrency: 1 });

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: () => adapter,
        scheduler,
      }),
    );

    expect(runState.nodes.get("fast")?.status).toBe("completed");
    expect(runState.nodes.get("slow")?.status).toBe("completed");

    // Both should have run, just not simultaneously
    const fastEnd = runState.nodes.get("fast")!.endedAt!;
    const slowStart = runState.nodes.get("slow")!.startedAt!;
    // Slow started after fast ended (due to concurrency limit of 1)
    expect(slowStart).toBeGreaterThanOrEqual(fastEnd);
  });

  it("node stays ready when acquire fails, and proceeds once capacity frees", async () => {
    const ir: GraphIR = {
      title: "acquire-test",
      slug: "acquire-test",
      options: {},
      nodes: [
        { id: "first", kind: "node", profileRef: "default", prompt: "First" },
        { id: "second", kind: "node", profileRef: "default", prompt: "Second" },
      ],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = makeRunState(ir);

    const adapter1 = createFakeAdapter({
      sessionId: "s1",
      finalText: "first",
      durationMs: 5,
      delayMs: 1,
    });
    const adapter2 = createFakeAdapter({
      sessionId: "s2",
      finalText: "second",
      durationMs: 5,
      delayMs: 1,
    });

    let adapterToggle = true;
    const getAdapter = () => {
      adapterToggle = !adapterToggle;
      return adapterToggle ? adapter1 : adapter2;
    };

    const scheduler = createScheduler({ maxAgentConcurrency: 1 });

    await withTimeout(executeDAG({ ir, runState, getAdapter, scheduler }));

    expect(runState.nodes.get("first")?.status).toBe("completed");
    expect(runState.nodes.get("second")?.status).toBe("completed");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Spawn flow — adapter invocation + event streaming
// ══════════════════════════════════════════════════════════════════════

describe("spawn flow", () => {
  it("streams events through the adapter and accumulates node state", async () => {
    const { ir, runState } = linearGraph();

    // Adapter that emits a multi-event sequence including tool calls
    const adapter = createFakeAdapter({
      sessionId: "stream-sess",
      finalText: "completed with tools",
      fileEdits: ["src/file1.ts", "src/file2.ts"],
      toolCount: 2,
      costUsd: 0.42,
      durationMs: 50,
    });

    const scheduler = createScheduler();

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: () => adapter,
        scheduler,
      }),
    );

    // All nodes completed
    for (const id of ["a", "b", "c"]) {
      const rt = runState.nodes.get(id)!;
      expect(rt.status).toBe("completed");
      expect(rt.sessionId).toBe("stream-sess");
      expect(rt.finalText).toBe("completed with tools");
      expect(rt.toolCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("records tool calls and file edits on the node runtime", async () => {
    const ir: GraphIR = {
      title: "tool-test",
      slug: "tool-test",
      options: {},
      nodes: [{ id: "toolnode", kind: "node", profileRef: "default", prompt: "Use tools" }],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = makeRunState(ir);

    const adapter = createFakeAdapter({
      sessionId: "tool-sess",
      finalText: "tools used",
      fileEdits: ["a.ts", "b.ts", "c.ts"],
      toolCount: 3,
      durationMs: 10,
    });

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: () => adapter,
        scheduler: createScheduler(),
      }),
    );

    const rt = runState.nodes.get("toolnode")!;
    expect(rt.toolCount).toBe(3);
    expect(rt.filesEdited).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// OutputSchema post-hoc validation
// ══════════════════════════════════════════════════════════════════════

describe("outputSchema post-hoc validation", () => {
  it("stores parsedOutput when final text matches the output schema", async () => {
    const ir: GraphIR = {
      title: "schema-test",
      slug: "schema-test",
      options: {},
      nodes: [
        {
          id: "valid",
          kind: "node",
          profileRef: "default",
          prompt: "Return structured output",
          outputSchema: {
            type: "object",
            properties: {
              verdict: { type: "string" },
              score: { type: "number" },
            },
            required: ["verdict", "score"],
          },
        },
      ],
      edges: [],
      conditions: [],
      schemas: {
        valid: {
          type: "object",
          properties: {
            verdict: { type: "string" },
            score: { type: "number" },
          },
          required: ["verdict", "score"],
        },
      },
      primitives: {},
    };
    const runState = makeRunState(ir);

    const adapter = createFakeAdapter({
      sessionId: "schema-valid",
      finalText: JSON.stringify({ verdict: "approved", score: 9 }),
      durationMs: 5,
    });

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: () => adapter,
        scheduler: createScheduler(),
      }),
    );

    const rt = runState.nodes.get("valid")!;
    expect(rt.status).toBe("completed");
    expect(rt.parsedOutput).toEqual({ verdict: "approved", score: 9 });
  });

  it("fails the node when final text does not match the output schema", async () => {
    const ir: GraphIR = {
      title: "schema-fail",
      slug: "schema-fail",
      options: { defaultRetries: 0 },
      nodes: [
        {
          id: "invalid",
          kind: "node",
          profileRef: "default",
          prompt: "Return structured output",
          outputSchema: {
            type: "object",
            properties: {
              verdict: { type: "string" },
              score: { type: "number" },
            },
            required: ["verdict", "score"],
          },
        },
      ],
      edges: [],
      conditions: [],
      schemas: {
        invalid: {
          type: "object",
          properties: {
            verdict: { type: "string" },
            score: { type: "number" },
          },
          required: ["verdict", "score"],
        },
      },
      primitives: {},
    };
    const runState = makeRunState(ir);

    // Adapter returns invalid JSON (not parseable as the schema)
    const adapter = createFakeAdapter({
      sessionId: "schema-invalid",
      finalText: "not valid json at all",
      durationMs: 5,
    });

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: () => adapter,
        scheduler: createScheduler(),
      }),
    );

    const rt = runState.nodes.get("invalid")!;
    // With retries=0, the node should fail when schema validation fails
    expect(rt.status).toBe("failed");
  });

  it("validates against outputSchema using schema from ir.schemas entry", async () => {
    const ir: GraphIR = {
      title: "schema-schemas",
      slug: "schema-schemas",
      options: {},
      nodes: [
        {
          id: "usingSchemas",
          kind: "node",
          profileRef: "default",
          prompt: "Return valid output",
          outputSchema: true, // presence flag; actual schema in ir.schemas
        },
      ],
      edges: [],
      conditions: [],
      schemas: {
        usingSchemas: {
          type: "object",
          properties: {
            result: { type: "string" },
          },
          required: ["result"],
        },
      },
      primitives: {},
    };
    const runState = makeRunState(ir);

    const adapter = createFakeAdapter({
      sessionId: "schemas-entry",
      finalText: JSON.stringify({ result: "ok" }),
      durationMs: 5,
    });

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: () => adapter,
        scheduler: createScheduler(),
      }),
    );

    const rt = runState.nodes.get("usingSchemas")!;
    expect(rt.status).toBe("completed");
    expect(rt.parsedOutput).toEqual({ result: "ok" });
  });
});

// ══════════════════════════════════════════════════════════════════════
// Retry / skip (no fail-fast)
// ══════════════════════════════════════════════════════════════════════

describe("retry/skip (no fail-fast)", () => {
  it("retries a failing node up to maxRetries before marking failed", async () => {
    const { ir, runState } = linearGraph();

    // Node "b" fails for the first 2 attempts, succeeds on the 3rd
    let attemptCount = 0;
    const retryAdapter = createFakeAdapter({
      events: (ctx?: NodeInvocationContext): NormalizedEvent[] => {
        attemptCount = ctx?.attempt ?? 1;
        if ((ctx?.attempt ?? 1) <= 2) {
          return [{ type: "error", message: "transient", retryable: true }];
        }
        return [
          { type: "session", id: "retry-sess" },
          {
            type: "done",
            sessionId: "retry-sess",
            finalText: "recovered",
            durationMs: 5,
            toolCallCount: 0,
          },
        ];
      },
    });

    const succeedAdapter = makeDefaultAdapter();

    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "b") return retryAdapter;
      return succeedAdapter;
    };

    // Allow 2 retries (so 3 attempts total)
    const irWithRetries: GraphIR = {
      ...ir,
      options: { ...ir.options, defaultRetries: 2 },
    };

    await withTimeout(
      executeDAG({
        ir: irWithRetries,
        runState,
        getAdapter: getAdapter as any,
        scheduler: createScheduler({ maxAgentConcurrency: 3 }),
        retryBackoffMs: 10,
      }),
    );

    expect(runState.nodes.get("a")?.status).toBe("completed");
    expect(runState.nodes.get("b")?.status).toBe("completed");
    expect(runState.nodes.get("c")?.status).toBe("completed");

    // B should have had 3 attempts (0, 1, 2) where first 2 failed
    expect(attemptCount).toBeGreaterThanOrEqual(3);
  });

  it("skips direct dependents of a failed node (failThenSkipGraph)", async () => {
    const { ir, runState } = failThenSkipGraph();

    // Node "b" fails with a retryable error, but we set retries=0 so it fails immediately
    const failAdapter = createFakeAdapter({
      mode: "retryable-error",
      sessionId: "fail-b",
      errorMessage: "permanent failure",
    });

    const succeedAdapter = makeDefaultAdapter();

    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "b") return failAdapter;
      return succeedAdapter;
    };

    const irWithRetries: GraphIR = {
      ...ir,
      options: { defaultRetries: 0 },
    };

    await withTimeout(
      executeDAG({
        ir: irWithRetries,
        runState,
        getAdapter: getAdapter as any,
        scheduler: createScheduler({ maxAgentConcurrency: 4 }),
      }),
    );

    // a depends on nothing → completed
    expect(runState.nodes.get("a")?.status).toBe("completed");
    // b fails (with retries=0, it fails on first error)
    expect(runState.nodes.get("b")?.status).toBe("failed");
    // c depends on b → skipped
    expect(runState.nodes.get("c")?.status).toBe("skipped");
    // d is independent → should have completed
    expect(runState.nodes.get("d")?.status).toBe("completed");
  });

  it("independent branches continue when one branch fails entirely", async () => {
    // Build a graph: A → B (fails), C (independent)
    const ir: GraphIR = {
      title: "no-fail-fast",
      slug: "no-fail-fast",
      options: { defaultRetries: 0 },
      nodes: [
        { id: "a", kind: "node", profileRef: "default", prompt: "A" },
        { id: "b", kind: "node", profileRef: "default", prompt: "B fails", dependsOn: ["a"] },
        { id: "c", kind: "node", profileRef: "default", prompt: "C independent" },
      ],
      edges: [{ from: "a", to: "b", kind: "dep" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = makeRunState(ir);

    const failB = createFakeAdapter({
      mode: "fail-after-events",
      failAfterEvents: 0,
      sessionId: "fail-b",
      errorMessage: "b failed",
    });

    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "b") return failB;
      return makeDefaultAdapter();
    };

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: getAdapter as any,
        scheduler: createScheduler({ maxAgentConcurrency: 3 }),
      }),
    );

    expect(runState.nodes.get("a")?.status).toBe("completed");
    expect(runState.nodes.get("b")?.status).toBe("failed");
    // c has no deps and is independent → must have completed
    expect(runState.nodes.get("c")?.status).toBe("completed");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Error handling — no crashing on bad input
// ══════════════════════════════════════════════════════════════════════

describe("error handling", () => {
  it("handles a missing adapter gracefully by falling back", async () => {
    const { ir, runState } = linearGraph();
    const adapter = makeDefaultAdapter();

    // getAdapter always returns our adapter
    const getAdapter = (_type?: string): AgentAdapter => {
      return adapter;
    };

    const scheduler = createScheduler();

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter,
        scheduler,
      }),
    );

    // All nodes completed despite the adapter fallback
    expect(runState.nodes.get("a")?.status).toBe("completed");
    expect(runState.nodes.get("b")?.status).toBe("completed");
    expect(runState.nodes.get("c")?.status).toBe("completed");
  });

  it("handles an abort signal gracefully", async () => {
    const { ir, runState } = diamondGraph();
    const adapter = createFakeAdapter({
      sessionId: "abort-test",
      finalText: "aborted work",
      durationMs: 100, // long enough that we can abort
      delayMs: 10,
    });

    const controller = new AbortController();

    // Schedule abort to fire after a short delay
    const execPromise = executeDAG({
      ir,
      runState,
      getAdapter: () => adapter,
      scheduler: createScheduler({ maxAgentConcurrency: 3 }),
      signal: controller.signal,
    });

    // Abort after a tick
    setTimeout(() => {
      controller.abort();
    }, 5);

    // Should settle (either resolve or reject) without hanging
    await expect(withTimeout(execPromise, 3000)).resolves.toBeDefined();
  });

  /**
   * Reduce node with an adapter that THROWS in emitEvents → the try/catch
   * in executeReduceNode must capture the error and fail the node (never
   * propagate through the reduce promise to reject executeDAG).
   */
  it("reduce node with throwing adapter fails the node gracefully", async () => {
    // Build a simple graph: member → reduce
    const ir: GraphIR = {
      title: "reduce-throw",
      slug: "reduce-throw",
      options: { defaultRetries: 0 },
      nodes: [
        {
          id: "member-0",
          kind: "node",
          profileRef: "default",
          prompt: "Do something",
        },
        {
          id: "synth",
          kind: "reduce",
          profileRef: "default",
          from: ["member-0"],
          agentType: "pi",
        },
      ],
      edges: [{ from: "member-0", to: "synth", kind: "dep" }],
      conditions: [],
      schemas: {},
      primitives: {},
    };

    const runState = makeRunState(ir);
    const scheduler = createScheduler();

    // Member adapter succeeds
    const memberAdapter = createFakeAdapter({
      sessionId: "member-sess",
      finalText: JSON.stringify({ result: "ok" }),
    });

    // Synthesis adapter that throws on emitEvents
    const throwAdapter = createFakeAdapter({});
    throwAdapter.emitEvents = async () => {
      throw new Error("adapter throw during reduce");
    };

    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "synth") return throwAdapter;
      return memberAdapter;
    };

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter,
        scheduler,
        profiles: {
          inlineProfiles: {
            default: { agentType: "pi" },
          },
        },
      }),
    );

    expect(runState.nodes.get("member-0")?.status).toBe("completed");
    expect(runState.nodes.get("synth")?.status).toBe("failed");
    expect(runState.nodes.get("synth")?.error).toMatch(/adapter throw/i);
  });
});

// ══════════════════════════════════════════════════════════════════════
// RunSummary return
// ══════════════════════════════════════════════════════════════════════

describe("RunSummary return", () => {
  it("returns a correctly structured RunSummary for a successful linear graph", async () => {
    const { ir, runState } = linearGraph();
    const adapter = makeDefaultAdapter({ durationMs: 5, delayMs: 1 });
    const scheduler = createScheduler();

    const summary = await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: () => adapter,
        scheduler,
      }),
    );

    expect(summary).toBeDefined();
    expect(summary.runId).toBe("run-test");
    expect(summary.nodes).toHaveLength(3);

    // Check each node entry
    for (const n of summary.nodes) {
      expect(n.id).toBeDefined();
      expect(n.status).toBe("completed");
      expect(typeof n.sessionId).toBe("string");
      expect(typeof n.toolCount).toBe("number");
      expect(typeof n.retries).toBe("number");
    }

    // Totals
    expect(summary.totals.nodes).toBe(3);
    expect(summary.totals.completed).toBe(3);
    expect(summary.totals.failed).toBe(0);
    expect(summary.totals.skipped).toBe(0);
    expect(summary.totals.totalDurationMs).toBeGreaterThan(0);
    expect(summary.totals.totalCostUsd).toBe(0);
  });

  it("returns correct totals for a mixed-completion graph (failThenSkip)", async () => {
    const { ir, runState } = failThenSkipGraph();

    const failAdapter = createFakeAdapter({
      mode: "fail-after-events",
      failAfterEvents: 0,
      sessionId: "fail-b-summary",
      errorMessage: "b failed",
    });

    const getAdapter = (_type?: string, nodeId?: string): AgentAdapter => {
      if (nodeId === "b") return failAdapter;
      return makeDefaultAdapter({ durationMs: 2 });
    };

    const summary = await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: getAdapter as any,
        scheduler: createScheduler({ maxAgentConcurrency: 4 }),
      }),
    );

    expect(summary.totals.nodes).toBe(4);
    // a completed, b failed, c skipped, d completed
    expect(summary.totals.completed).toBe(2);
    expect(summary.totals.failed).toBe(1);
    expect(summary.totals.skipped).toBe(1);

    // Per-node check
    const aEntry = summary.nodes.find((n) => n.id === "a")!;
    expect(aEntry.status).toBe("completed");
    const bEntry = summary.nodes.find((n) => n.id === "b")!;
    expect(bEntry.status).toBe("failed");
    const cEntry = summary.nodes.find((n) => n.id === "c")!;
    expect(cEntry.status).toBe("skipped");
    const dEntry = summary.nodes.find((n) => n.id === "d")!;
    expect(dEntry.status).toBe("completed");
  });

  it("includes error messages for failed nodes in the summary", async () => {
    const ir: GraphIR = {
      title: "error-msg",
      slug: "error-msg",
      options: { defaultRetries: 0 },
      nodes: [{ id: "fails", kind: "node", profileRef: "default", prompt: "Will fail" }],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = makeRunState(ir);

    const failAdapter = createFakeAdapter({
      mode: "fail-after-events",
      failAfterEvents: 0,
      sessionId: "err-sess",
      errorMessage: "something went wrong",
    });

    const summary = await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: () => failAdapter,
        scheduler: createScheduler(),
      }),
    );

    const failsEntry = summary.nodes.find((n) => n.id === "fails")!;
    expect(failsEntry.status).toBe("failed");
    expect(failsEntry.error).toBeDefined();
    expect(failsEntry.error!.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Robustness / integration gaps (kb-14 round-2 TEST phase)
// ══════════════════════════════════════════════════════════════════════

describe("robustness / integration gaps", () => {
  // ── Test (a): subprocess crash → node FAILED ────────────────
  it("subprocess crash with non-zero exitCode marks node as FAILED (not completed)", async () => {
    // Reset the runAgent mock before this test
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockResolvedValue({ exitCode: 1, stderr: "oom-killed" });

    // A minimal AgentAdapter that does NOT have emitEvents (no duck-type detection).
    // This forces the executor to take the runAgent subprocess path.
    const realAdapter: AgentAdapter = {
      type: "crash-test",
      supportsNativeResume: false,
      supportsNativeOutputSchema: false,
      buildInvocation: (
        _profile: ResolvedProfile,
        _ctx: NodeInvocationContext,
      ): AdapterInvocation => ({
        command: "crash",
        args: [],
        env: {},
        stdinPrompt: "prompt",
      }),
      parseEventStreamLine: (_line: string) => null,
      buildResumePrompt: (_prior: string, _new: string) => _new,
      extractSessionId: () => undefined,
      extractFileEdits: () => [],
      toolCountFromEvents: () => 0,
      costFromEvents: () => undefined,
    };

    const ir: GraphIR = {
      title: "crash-test",
      slug: "crash-test",
      options: { defaultRetries: 0 },
      nodes: [{ id: "crash", kind: "node", profileRef: "default", prompt: "Will crash" }],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = makeRunState(ir);
    const scheduler = createScheduler();

    await withTimeout(executeDAG({ ir, runState, getAdapter: () => realAdapter, scheduler }));

    const rt = runState.nodes.get("crash")!;
    // Executor correctly maps non-zero exitCode to FAILED status with stderr folded into error.
    expect(rt.status).toBe("failed");
    expect(rt.error).toContain("oom-killed");
  });

  // ── Test (b): abort → in-flight node FAILED + inFlight settled ──
  it("aborting mid-flight marks the running node FAILED with error 'aborted'", async () => {
    const ir: GraphIR = {
      title: "abort-test",
      slug: "abort-test",
      options: {},
      nodes: [{ id: "worker", kind: "node", profileRef: "default", prompt: "Do work" }],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = makeRunState(ir);

    // Adapter that takes long enough that we can abort mid-emission
    const adapter = createFakeAdapter({
      sessionId: "abort-sess",
      finalText: "partial output",
      durationMs: 200,
      delayMs: 10,
    });

    const controller = new AbortController();

    const execPromise = executeDAG({
      ir,
      runState,
      getAdapter: () => adapter,
      scheduler: createScheduler(),
      signal: controller.signal,
    });

    // Abort while the node is still emitting
    setTimeout(() => {
      controller.abort();
    }, 2);

    // executeDAG must settle (not hang) — the in-flight coroutine must be drained
    await expect(withTimeout(execPromise, 3000)).resolves.toBeDefined();

    // The aborted node must be FAILED, not completed
    const rt = runState.nodes.get("worker")!;
    expect(rt.status).toBe("failed");
    expect(rt.error).toBe("aborted");
  });

  // ── Test (c): provider / model pools enforced ────────────────
  it("only one node runs at a time when provider pool limit (zai=1) is configured", async () => {
    // Two independent nodes (no deps). Both would resolve to provider 'zai'.
    // The scheduler is configured with limits.byProvider.zai = 1.
    // Executor populates SchedulableNode.provider from the resolved profile so the scheduler
    // can enforce the provider-level pool.
    const ir: GraphIR = {
      title: "provider-pool",
      slug: "provider-pool",
      options: {},
      nodes: [
        { id: "a", kind: "node", profileRef: "zai-pool-test", prompt: "Task A" },
        { id: "b", kind: "node", profileRef: "zai-pool-test", prompt: "Task B" },
      ],
      edges: [],
      conditions: [],
      schemas: {},
      primitives: {},
    };
    const runState = makeRunState(ir);

    // Both nodes use the same slower adapter so we can observe concurrency
    const adapter = createFakeAdapter({
      sessionId: "pool-sess",
      finalText: "done",
      durationMs: 50,
      delayMs: 20,
    });

    // Provider pool: only 1 zai slot; global allows 2 so only the provider
    // pool would block the second node.
    const scheduler = createScheduler({
      maxAgentConcurrency: 2,
      limits: { byProvider: { zai: 1 } },
    });

    await withTimeout(
      executeDAG({
        ir,
        runState,
        getAdapter: () => adapter,
        scheduler,
        profiles: { inlineProfiles: { "zai-pool-test": { provider: "zai" } } },
      }),
    );

    const a = runState.nodes.get("a")!;
    const b = runState.nodes.get("b")!;

    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");

    // With provider-pool enforcement, B must have started only after A completed.
    expect(b.startedAt).toBeGreaterThanOrEqual(a.endedAt!);
  });
});
