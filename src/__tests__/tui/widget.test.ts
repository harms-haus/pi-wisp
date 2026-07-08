// ═══════════════════════════════════════════════════════════════════════════
// TUI widget — tests (kb-18 / PLAN S33).
//
// Tests every public export of src/tui/widget.ts:
//   renderWidget — produces widget content string from RunState + PoolUsage
//   clearWidget  — clears the widget and status via ctx.ui
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from "vitest";
import type { NodeRuntime, PoolUsage, RunState } from "../../types.js";

// ── Module under test ──────────────────────────────────────────
import { renderWidget, clearWidget } from "../../tui/widget.js";

// ══════════════════════════════════════════════════════════════════════════
// Fixture helpers
// ══════════════════════════════════════════════════════════════════════════

/**
 * Build a NodeRuntime with minimal defaults.
 */
function node(overrides: Partial<NodeRuntime> = {}): NodeRuntime {
  return {
    status: "pending",
    attempts: 0,
    toolCount: 0,
    filesEdited: [],
    ...overrides,
  };
}

/**
 * Build a RunState for the test workflow from the IMPLEMENTATION §14 example.
 *
 * Nodes:
 *   review   — completed, 4.2s, 11 tools, 2 files
 *   fix-0    — running,   1.1s,  3 tools, 0 files
 *   fix-1    — pending
 *   fix-2    — pending
 *   verify   — skipped
 */
function makeExampleRunState(): RunState {
  const nodes = new Map<string, NodeRuntime>();
  nodes.set(
    "review",
    node({
      status: "completed",
      startedAt: 0,
      endedAt: 4200,
      toolCount: 11,
      filesEdited: ["src/bug1.ts", "src/bug2.ts"],
    }),
  );
  nodes.set(
    "fix-0",
    node({
      status: "running",
      startedAt: 3100,
      endedAt: 4200,
      toolCount: 3,
    }),
  );
  nodes.set("fix-1", node({ status: "pending" }));
  nodes.set("fix-2", node({ status: "pending" }));
  nodes.set("verify", node({ status: "skipped" }));

  return {
    runId: "run-abc123",
    title: "fix-bugs",
    slug: "fix-bugs",
    startedAt: 0,
    status: "running",
    nodes,
  };
}

/**
 * Build a PoolUsage for the example footer (global 4/12, zai 5/7).
 */
function makeExampleUsage(): PoolUsage {
  return {
    global: { used: 4, cap: 12 },
    byAgentType: { zai: { used: 5, cap: 7 } },
    byProvider: {},
    byModel: {},
  };
}

/**
 * Stage labels for the example workflow, keyed by node id.
 *
 * The review loop breaks down as:
 *   "review"  → do-work   (the worker that fixes bugs)
 *   "fix-0"   → do-work   (fanOut children)
 *   "fix-1"   → do-work
 *   "fix-2"   → do-work
 *   "verify"  → review    (the review-loop gate)
 */
const EXAMPLE_STAGES: Record<string, string> = {
  review: "do-work",
  "fix-0": "do-work",
  "fix-1": "do-work",
  "fix-2": "do-work",
  verify: "review",
};

// ══════════════════════════════════════════════════════════════════════════
// renderWidget
// ══════════════════════════════════════════════════════════════════════════

describe("renderWidget", () => {
  it("includes the workflow title in the header", () => {
    const rs = makeExampleRunState();
    const usage = makeExampleUsage();
    const out = renderWidget(rs, usage, EXAMPLE_STAGES).join("\n");

    expect(out).toContain("fix-bugs");
  });

  it("shows the total and completed node counts in the header", () => {
    const rs = makeExampleRunState();
    const usage = makeExampleUsage();
    const out = renderWidget(rs, usage, EXAMPLE_STAGES).join("\n");

    // 1 completed (review), 5 total nodes
    expect(out).toContain("1");
    expect(out).toContain("5");
  });

  it("shows the stage in the header", () => {
    const rs = makeExampleRunState();
    const usage = makeExampleUsage();
    const out = renderWidget(rs, usage, EXAMPLE_STAGES).join("\n");

    // The header stage should be derived from the first active node or an
    // aggregate. At minimum the word "stage" or a stage label should appear.
    expect(out).toMatch(/stage/i);
  });

  it("shows 'failed' in the header when all nodes have failed", () => {
    const nodes = new Map<string, NodeRuntime>();
    nodes.set("a", node({ status: "failed", error: "err a" }));
    nodes.set("b", node({ status: "failed", error: "err b" }));
    const rs: RunState = {
      runId: "run-all-fail",
      title: "all-fail",
      slug: "all-fail",
      startedAt: 0,
      status: "failed",
      nodes,
    };
    const usage: PoolUsage = {
      global: { used: 0, cap: 12 },
      byAgentType: {},
      byProvider: {},
      byModel: {},
    };
    const out = renderWidget(rs, usage, { a: "do-work", b: "do-work" }).join("\n");

    // The header should show 'failed' because all nodes failed
    expect(out).toContain("failed");
  });

  it("shows 'failed' in the header when some nodes failed and none are running/ready/pending", () => {
    const nodes = new Map<string, NodeRuntime>();
    nodes.set("a", node({ status: "completed" }));
    nodes.set("b", node({ status: "failed" }));
    const rs: RunState = {
      runId: "run-partial-fail",
      title: "partial-fail",
      slug: "partial-fail",
      startedAt: 0,
      status: "failed",
      nodes,
    };
    const usage: PoolUsage = {
      global: { used: 0, cap: 12 },
      byAgentType: {},
      byProvider: {},
      byModel: {},
    };
    const out = renderWidget(rs, usage, { a: "do-work", b: "do-work" }).join("\n");

    // The header should show 'failed' because some nodes failed and nothing is active/queued
    expect(out).toContain("failed");
  });

  it("shows the running stage in the header when a node is running even if others failed", () => {
    const nodes = new Map<string, NodeRuntime>();
    nodes.set("a", node({ status: "running", startedAt: 100 }));
    nodes.set("b", node({ status: "failed" }));
    const rs: RunState = {
      runId: "run-mixed",
      title: "mixed",
      slug: "mixed",
      startedAt: 0,
      status: "running",
      nodes,
    };
    const usage: PoolUsage = {
      global: { used: 0, cap: 12 },
      byAgentType: {},
      byProvider: {},
      byModel: {},
    };
    const out = renderWidget(rs, usage, { a: "do-work", b: "do-work" }).join("\n");

    // Running should take priority over failed
    expect(out).toContain("do-work");
    expect(out).not.toContain("· stage: failed");
  });

  it("includes a row for each node in the run state", () => {
    const rs = makeExampleRunState();
    const usage = makeExampleUsage();
    const out = renderWidget(rs, usage, EXAMPLE_STAGES).join("\n");

    // All 5 node ids should appear somewhere in the rendered output
    expect(out).toContain("review");
    expect(out).toContain("fix-0");
    expect(out).toContain("fix-1");
    expect(out).toContain("fix-2");
    expect(out).toContain("verify");
  });

  it("shows the status glyph for each node", () => {
    const rs = makeExampleRunState();
    const usage = makeExampleUsage();
    const out = renderWidget(rs, usage, EXAMPLE_STAGES).join("\n");

    // The completed node "review" should show ✓
    expect(out).toContain("✓");

    // The running node "fix-0" should show ⏳
    expect(out).toContain("⏳");

    // Pending nodes should show ○ (hollow circle)
    expect(out).toContain("○");

    // The skipped node "verify" should show ◇
    expect(out).toContain("◇");

    // The · (middle dot) appears in row separators and for ready status,
    // so it should appear somewhere
    expect(out).toMatch(/·/);
  });

  it("shows elapsed time for nodes that have it", () => {
    const rs = makeExampleRunState();
    const usage = makeExampleUsage();
    const out = renderWidget(rs, usage, EXAMPLE_STAGES).join("\n");

    // review ran for 4.2s
    expect(out).toContain("4.2s");
    // fix-0 ran for 1.1s (4200 - 3100 = 1100ms)
    expect(out).toContain("1.1s");
  });

  it("shows tool counts for completed/running nodes", () => {
    const rs = makeExampleRunState();
    const usage = makeExampleUsage();
    const out = renderWidget(rs, usage, EXAMPLE_STAGES).join("\n");

    // review has 11 tools
    expect(out).toContain("11 tools");

    // fix-0 has 3 tools
    expect(out).toContain("3 tools");
  });

  it("shows file count for nodes with edited files", () => {
    const rs = makeExampleRunState();
    const usage = makeExampleUsage();
    const out = renderWidget(rs, usage, EXAMPLE_STAGES).join("\n");

    // review has 2 files
    expect(out).toContain("2 files");
  });

  it("shows the stage label per node row", () => {
    const rs = makeExampleRunState();
    const usage = makeExampleUsage();
    const out = renderWidget(rs, usage, EXAMPLE_STAGES).join("\n");

    // verify should have stage "review"
    expect(out).toContain("review");

    // review should have stage "do-work"
    // (this could match the word review as well since it's the node name,
    //  so also check that fix-0 has stage "do-work")
    expect(out).toContain("do-work");
  });

  it("includes the pool usage footer", () => {
    const rs = makeExampleRunState();
    const usage = makeExampleUsage();
    const out = renderWidget(rs, usage, EXAMPLE_STAGES).join("\n");

    // Footer should contain global pool info
    expect(out).toContain("global");
    expect(out).toContain("4");
    expect(out).toContain("12");

    // Footer should contain byAgentType pool info
    expect(out).toContain("zai");
    expect(out).toContain("5");
    expect(out).toContain("7");
  });

  it("shows 0/0 when there are no nodes", () => {
    const rs: RunState = {
      runId: "run-empty",
      title: "empty",
      slug: "empty",
      startedAt: 0,
      status: "running",
      nodes: new Map(),
    };
    const usage: PoolUsage = {
      global: { used: 0, cap: 12 },
      byAgentType: {},
      byProvider: {},
      byModel: {},
    };
    const out = renderWidget(rs, usage, {}).join("\n");

    expect(out).toContain("0/0");
    expect(out).toContain("empty");
  });

  it("handles a node with failed status and appends error snippet", () => {
    const nodes = new Map<string, NodeRuntime>();
    nodes.set(
      "fail-node",
      node({
        status: "failed",
        startedAt: 0,
        endedAt: 500,
        toolCount: 2,
        error: "Something went wrong",
      }),
    );
    const rs: RunState = {
      runId: "run-fail",
      title: "failing-workflow",
      slug: "failing-workflow",
      startedAt: 0,
      status: "failed",
      nodes,
    };
    const usage: PoolUsage = {
      global: { used: 0, cap: 12 },
      byAgentType: {},
      byProvider: {},
      byModel: {},
    };
    const out = renderWidget(rs, usage, { "fail-node": "do-work" }).join("\n");

    // Should show ✗ for failed status
    expect(out).toContain("✗");
    // Should show the node id
    expect(out).toContain("fail-node");
    // Should show the error snippet with ⚠
    expect(out).toContain("⚠");
    expect(out).toContain("Something went wrong");
  });

  it("truncates error snippet for failed nodes when error is long", () => {
    // Use a unique trailing marker that would never appear in the first 57 chars.
    const marker = "<<<TRUNCATED>>>";
    const shortPart = "x".repeat(57);
    const longError = shortPart + marker;
    const nodes = new Map<string, NodeRuntime>();
    nodes.set(
      "fail-node",
      node({
        status: "failed",
        error: longError,
      }),
    );
    const rs: RunState = {
      runId: "run-fail",
      title: "failing",
      slug: "failing",
      startedAt: 0,
      status: "failed",
      nodes,
    };
    const usage: PoolUsage = {
      global: { used: 0, cap: 12 },
      byAgentType: {},
      byProvider: {},
      byModel: {},
    };
    const out = renderWidget(rs, usage, { "fail-node": "do-work" }).join("\n");

    // Should contain the truncated error (57 chars + …)
    expect(out).toContain("⚠");
    expect(out).toContain(shortPart);
    expect(out).toContain("…");
    // The unique marker should NOT appear (truncated away)
    expect(out).not.toContain(marker);
  });

  it("does not append error snippet for non-failed nodes even when error is set", () => {
    const nodes = new Map<string, NodeRuntime>();
    nodes.set(
      "running-node",
      node({
        status: "running",
        error: "should not appear",
      }),
    );
    const rs: RunState = {
      runId: "run-running",
      title: "running",
      slug: "running",
      startedAt: 0,
      status: "running",
      nodes,
    };
    const usage: PoolUsage = {
      global: { used: 0, cap: 12 },
      byAgentType: {},
      byProvider: {},
      byModel: {},
    };
    const out = renderWidget(rs, usage, { "running-node": "do-work" }).join("\n");

    expect(out).toContain("running-node");
    expect(out).not.toContain("⚠");
    expect(out).not.toContain("should not appear");
  });

  it("uses wisp: prefix in the header label", () => {
    const rs = makeExampleRunState();
    const usage = makeExampleUsage();
    const out = renderWidget(rs, usage, EXAMPLE_STAGES).join("\n");

    expect(out).toMatch(/wisp:/i);
  });

  it("renders all completed/total/failed counts when some nodes are in each state", () => {
    const nodes = new Map<string, NodeRuntime>();
    nodes.set("a", node({ status: "completed", toolCount: 2, filesEdited: ["a.ts"] }));
    nodes.set("b", node({ status: "failed" }));
    nodes.set("c", node({ status: "pending" }));
    nodes.set("d", node({ status: "skipped" }));
    const rs: RunState = {
      runId: "run-counts",
      title: "counts",
      slug: "counts",
      startedAt: 0,
      status: "running",
      nodes,
    };
    const usage: PoolUsage = {
      global: { used: 2, cap: 12 },
      byAgentType: {},
      byProvider: {},
      byModel: {},
    };
    const out = renderWidget(rs, usage, {
      a: "do-work",
      b: "do-work",
      c: "do-work",
      d: "do-work",
    }).join("\n");

    // Should show 1/4 completed (only 'a' is completed)
    expect(out).toContain("1");
    expect(out).toContain("4");
    // Should show ✗ for the failed node
    expect(out).toContain("✗");
    // Should show ◇ for the skipped node
    expect(out).toContain("◇");
    // Should show ○ for pending (not ·)
    expect(out).toContain("○");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// clearWidget
// ══════════════════════════════════════════════════════════════════════════

describe("clearWidget", () => {
  it("calls ctx.ui.setWidget with 'wisp' and undefined to clear the widget", () => {
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const ctx = {
      ui: { setWidget, setStatus },
    };

    clearWidget(ctx);

    expect(setWidget).toHaveBeenCalledWith("wisp", undefined);
  });

  it("clears the status line via ctx.ui.setStatus", () => {
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const ctx = {
      ui: { setWidget, setStatus },
    };

    clearWidget(ctx);

    expect(setStatus).toHaveBeenCalledWith("wisp", undefined);
  });

  it("does not throw when ctx.ui is undefined (defensive)", () => {
    // In some test or edge-case scenarios, ctx might not have ui.
    expect(() => {
      clearWidget({ ui: undefined });
    }).not.toThrow();
  });

  it("does not throw when setWidget is missing (defensive)", () => {
    expect(() => {
      clearWidget({ ui: { setWidget: undefined, setStatus: vi.fn() } });
    }).not.toThrow();
  });
});
