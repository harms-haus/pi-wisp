import { describe, it, expect } from "vitest";

import type { IRNode, NodeRuntime, RunState } from "../../types.js";
import {
  resolvePolicy,
  shouldRetry,
  backoffMs,
  propagateSkip,
  buildSuccessorsMap,
  type RetryPolicy,
} from "../../engine/retry.js";

// ─── Constants ────────────────────────────────────────────────────

const DEFAULT_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;

// ─── Helpers ──────────────────────────────────────────────────────

function makeNode(overrides: Partial<IRNode> & { id: string }): IRNode {
  const { id, ...rest } = overrides;
  return {
    id,
    kind: "node" as const,
    agentType: "pi",
    profileRef: "default",
    prompt: "test prompt",
    ...rest,
  } as IRNode;
}

function makeRunState(completedNodes: Array<[string, Partial<NodeRuntime>]>): RunState {
  const nodes = new Map<string, NodeRuntime>();

  for (const [id, partial] of completedNodes) {
    const defaults: NodeRuntime = {
      status: "completed",
      sessionId: undefined,
      startedAt: 1000,
      endedAt: 2000,
      attempts: 1,
      toolCount: 0,
      filesEdited: [],
      costUsd: undefined,
      finalText: undefined,
      parsedOutput: undefined,
      error: undefined,
    };
    nodes.set(id, { ...defaults, ...partial });
  }

  return {
    runId: "retry-test",
    title: "Retry Test",
    slug: "retry-test",
    startedAt: 1000,
    status: "running" as const,
    nodes,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("resolvePolicy", () => {
  it("uses node.retries when specified", () => {
    const node = makeNode({ id: "a", retries: 5 });
    const policy = resolvePolicy(node, DEFAULT_RETRIES, RETRY_BACKOFF_MS);

    expect(policy.maxRetries).toBe(5);
  });

  it("falls back to defaultRetries when node has no retries property", () => {
    const node = makeNode({ id: "a" });
    const policy = resolvePolicy(node, DEFAULT_RETRIES, RETRY_BACKOFF_MS);

    expect(policy.maxRetries).toBe(DEFAULT_RETRIES);
  });

  it("falls back to defaultRetries when node.retries is 0", () => {
    const node = makeNode({ id: "a", retries: 0 });
    const policy = resolvePolicy(node, 2, RETRY_BACKOFF_MS);

    // 0 is falsy but is a valid "no retries" value — should use 0 (no retries).
    // This test asserts the contract: 0 means no retries.
    expect(policy.maxRetries).toBe(0);
  });

  it("uses the configured retryBackoffMs for the base", () => {
    const node = makeNode({ id: "a", retries: 3 });
    const policy = resolvePolicy(node, DEFAULT_RETRIES, 5000);

    expect(policy.backoffMs).toBe(5000);
  });

  it("returns a valid RetryPolicy object", () => {
    const node = makeNode({ id: "a", retries: 2 });
    const policy: RetryPolicy = resolvePolicy(node, DEFAULT_RETRIES, RETRY_BACKOFF_MS);

    expect(policy).toHaveProperty("maxRetries");
    expect(policy).toHaveProperty("backoffMs");
    expect(typeof policy.maxRetries).toBe("number");
    expect(typeof policy.backoffMs).toBe("number");
  });
});

describe("shouldRetry", () => {
  it("returns true when attempt count is less than maxRetries", () => {
    const policy: RetryPolicy = { maxRetries: 3, backoffMs: 2000 };

    // attempt 0 (first try), attempt 1 (first retry), attempt 2 (second retry)
    expect(shouldRetry(policy, 0)).toBe(true);
    expect(shouldRetry(policy, 1)).toBe(true);
    expect(shouldRetry(policy, 2)).toBe(true);
  });

  it("returns false when attempt count equals maxRetries", () => {
    const policy: RetryPolicy = { maxRetries: 3, backoffMs: 2000 };

    // after 3 retries (attempts 0,1,2,3), should stop
    expect(shouldRetry(policy, 3)).toBe(false);
  });

  it("returns false when attempt count exceeds maxRetries", () => {
    const policy: RetryPolicy = { maxRetries: 1, backoffMs: 2000 };

    expect(shouldRetry(policy, 0)).toBe(true); // first try
    expect(shouldRetry(policy, 1)).toBe(false); // after the one retry
    expect(shouldRetry(policy, 2)).toBe(false);
  });

  it("returns false when maxRetries is 0 (no retries allowed)", () => {
    const policy: RetryPolicy = { maxRetries: 0, backoffMs: 2000 };

    expect(shouldRetry(policy, 0)).toBe(false);
  });
});

describe("backoffMs", () => {
  it("returns the base backoff for attempt 1 (first retry)", () => {
    const policy: RetryPolicy = { maxRetries: 3, backoffMs: 2000 };

    // attempt 1 = base (2000 * 2^(1-1) = 2000 * 1 = 2000)
    expect(backoffMs(policy, 1)).toBe(2000);
  });

  it("returns doubled backoff for attempt 2", () => {
    const policy: RetryPolicy = { maxRetries: 3, backoffMs: 2000 };

    // attempt 2 = 2000 * 2^(2-1) = 2000 * 2 = 4000
    expect(backoffMs(policy, 2)).toBe(4000);
  });

  it("returns quadrupled backoff for attempt 3", () => {
    const policy: RetryPolicy = { maxRetries: 5, backoffMs: 1000 };

    // attempt 3 = 1000 * 2^(3-1) = 1000 * 4 = 4000
    expect(backoffMs(policy, 3)).toBe(4000);
  });

  it("returns 0 for attempt 0 (no retry needed)", () => {
    const policy: RetryPolicy = { maxRetries: 3, backoffMs: 2000 };

    // attempt 0 = first try, no backoff needed
    expect(backoffMs(policy, 0)).toBe(0);
  });

  it("works with custom backoff values", () => {
    const policy: RetryPolicy = { maxRetries: 3, backoffMs: 5000 };

    // attempt 1 = 5000 * 2^(1-1) = 5000
    expect(backoffMs(policy, 1)).toBe(5000);
    // attempt 2 = 5000 * 2 = 10000
    expect(backoffMs(policy, 2)).toBe(10000);
  });
});

describe("propagateSkip", () => {
  it("marks a node as failed, then marks its direct dependents as skipped", () => {
    // Graph: a → b → c
    // a fails → a=failed, b=skipped, c=skipped (transitive)
    const runState = makeRunState([
      ["a", { status: "running", attempts: 1 }],
      ["b", { status: "pending" }],
      ["c", { status: "pending" }],
    ]);

    const successors = buildSuccessorsMap([
      { from: "a", to: "b", kind: "dep" as const },
      { from: "b", to: "c", kind: "dep" as const },
    ]);

    propagateSkip("a", runState, "dep-failed", successors);

    expect(runState.nodes.get("a")?.status).toBe("failed");
    expect(runState.nodes.get("b")?.status).toBe("skipped");
    // c is transitively dependent on a via b, so it should also be skipped
    expect(runState.nodes.get("c")?.status).toBe("skipped");
  });

  it("leaves independent branches untouched when a separate branch fails", () => {
    // Graph: a → b (branch 1) and c → d (branch 2, independent)
    // b fails → b=failed, but c,d remain untouched
    const runState = makeRunState([
      ["a", { status: "running", attempts: 1 }],
      ["b", { status: "running" }],
      ["c", { status: "pending" }],
      ["d", { status: "pending" }],
    ]);

    const successors = buildSuccessorsMap([
      { from: "a", to: "b", kind: "dep" as const },
      { from: "c", to: "d", kind: "dep" as const },
    ]);

    propagateSkip("b", runState, "dep-failed", successors);

    // b should be marked failed (it's the failed node itself)
    expect(runState.nodes.get("b")?.status).toBe("failed");

    // Independent branch c→d must be untouched
    expect(runState.nodes.get("c")?.status).toBe("pending");
    expect(runState.nodes.get("d")?.status).toBe("pending");
  });

  it("propagates skip to direct dependents only when reason is dep-failed", () => {
    // Graph: a → b → c
    // a fails → a=failed, b=skipped (direct dep), c should also be skipped (transitive)
    const runState = makeRunState([
      ["a", { status: "running", attempts: 1 }],
      ["b", { status: "pending" }],
      ["c", { status: "pending" }],
    ]);

    const successors = buildSuccessorsMap([
      { from: "a", to: "b", kind: "dep" as const },
      { from: "b", to: "c", kind: "dep" as const },
    ]);

    propagateSkip("a", runState, "dep-failed", successors);

    expect(runState.nodes.get("a")?.status).toBe("failed");
    expect(runState.nodes.get("b")?.status).toBe("skipped");
    expect(runState.nodes.get("c")?.status).toBe("skipped");
  });

  it("does not re-skip already completed nodes", () => {
    // Graph: a → b. a fails but b is already completed.
    const runState = makeRunState([
      ["a", { status: "running", attempts: 1 }],
      ["b", { status: "completed" }],
    ]);

    const successors = buildSuccessorsMap([{ from: "a", to: "b", kind: "dep" as const }]);

    propagateSkip("a", runState, "dep-failed", successors);

    expect(runState.nodes.get("a")?.status).toBe("failed");
    // b was already completed, should stay completed
    expect(runState.nodes.get("b")?.status).toBe("completed");
  });

  it("skipped nodes get the provided reason code", () => {
    // Graph: a → b. a fails.
    const runState = makeRunState([
      ["a", { status: "running", attempts: 1 }],
      ["b", { status: "pending" }],
    ]);

    const successors = buildSuccessorsMap([{ from: "a", to: "b", kind: "dep" as const }]);

    propagateSkip("a", runState, "dep-failed", successors);

    // b should have its error set to the skip reason
    const skippedNode = runState.nodes.get("b");
    expect(skippedNode?.error).toContain("dep-failed");
  });

  it("handles the case where the failed node has no dependents", () => {
    // Graph: a alone (no edges)
    const runState = makeRunState([["a", { status: "running", attempts: 1 }]]);

    const successors = buildSuccessorsMap([]);

    // Should not throw when there are no dependents.
    expect(() => {
      propagateSkip("a", runState, "dep-failed", successors);
    }).not.toThrow();

    expect(runState.nodes.get("a")?.status).toBe("failed");
  });

  it("handles multiple independent dependents", () => {
    // Graph: a → b, a → c, a → d
    // a fails → all three dependents skipped
    const runState = makeRunState([
      ["a", { status: "running", attempts: 1 }],
      ["b", { status: "pending" }],
      ["c", { status: "pending" }],
      ["d", { status: "pending" }],
    ]);

    const successors = buildSuccessorsMap([
      { from: "a", to: "b", kind: "dep" as const },
      { from: "a", to: "c", kind: "dep" as const },
      { from: "a", to: "d", kind: "dep" as const },
    ]);

    propagateSkip("a", runState, "dep-failed", successors);

    expect(runState.nodes.get("a")?.status).toBe("failed");
    expect(runState.nodes.get("b")?.status).toBe("skipped");
    expect(runState.nodes.get("c")?.status).toBe("skipped");
    expect(runState.nodes.get("d")?.status).toBe("skipped");
  });

  it("skips all dependents — dep, cond:branch, and fanOut — when their predecessor fails", () => {
    // Graph:
    //   a ──dep────────→ b   ← skipped (dep edge)
    //   a ──cond:branch→ c   ← skipped (cond:branch edge)
    //   a ──fanOut─────→ d   ← skipped (fanOut edge)
    //
    // propagateSkip must follow ALL three edge kinds so no dependent is
    // left orphaned as `pending`.
    const runState = makeRunState([
      ["a", { status: "running", attempts: 1 }],
      ["b", { status: "pending" }],
      ["c", { status: "pending" }],
      ["d", { status: "pending" }],
    ]);

    const successors = buildSuccessorsMap([
      { from: "a", to: "b", kind: "dep" as const },
      { from: "a", to: "c", kind: "cond:branch" as const },
      { from: "a", to: "d", kind: "fanOut" as const },
    ]);

    propagateSkip("a", runState, "dep-failed", successors);

    // a itself must be failed
    expect(runState.nodes.get("a")?.status).toBe("failed");

    // All three edge kinds propagate skip
    expect(runState.nodes.get("b")?.status).toBe("skipped");
    expect(runState.nodes.get("c")?.status).toBe("skipped");
    expect(runState.nodes.get("d")?.status).toBe("skipped");
  });

  it("skips a fanOut successor when its producer fails", () => {
    // Graph: producer → fanOut (fanOut edge). When the producer fails, the
    // fanOut node must be marked skipped (not left orphaned as `pending`).
    const runState = makeRunState([
      ["producer", { status: "running", attempts: 1 }],
      ["expand", { status: "pending" }],
    ]);

    const successors = buildSuccessorsMap([
      { from: "producer", to: "expand", kind: "fanOut" as const },
    ]);

    propagateSkip("producer", runState, "dep-failed", successors);

    expect(runState.nodes.get("producer")?.status).toBe("failed");
    expect(runState.nodes.get("expand")?.status).toBe("skipped");
  });
});
