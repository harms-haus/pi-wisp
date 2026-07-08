// ═══════════════════════════════════════════════════════════════════════════
// Concurrency-pool scheduler — AND-semantics layered pools (S28 / PLAN §9).
//
// Tests the Scheduler contract in total isolation: pure pool accounting, no
// adapters, no spawning. Every node is a plain `SchedulableNode` object with
// agentType / provider / model.
//
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { createScheduler, type SchedulableNode } from "../../engine/scheduler.js";
import type { PoolUsage, WispConfig } from "../../types.js";
import { CONFIG_DEFAULTS } from "../../constants.js";

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Shorthand to create a resolvable node with explicit agentType.
 * The scheduler is called with these objects directly; it looks at
 * agentType, provider, and model.
 */
function node(overrides: Partial<SchedulableNode> = {}): SchedulableNode {
  return {
    agentType: "pi",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    ...overrides,
  };
}

/**
 * Shorthand to build a config with limits. Omits `limits` entirely when not
 * needed (the global pool always applies via maxAgentConcurrency).
 */
function config(overrides: Partial<WispConfig> = {}): WispConfig {
  return {
    maxAgentConcurrency: overrides.maxAgentConcurrency ?? CONFIG_DEFAULTS.maxAgentConcurrency,
    defaultRetries: 3,
    retryBackoffMs: 2000,
    limits: overrides.limits,
  };
}

/**
 * Assert that a PoolUsage value has the expected used/cap counts.
 * Supplies a default cap of 0 when the key is absent (meaning no limit).
 */
function expectPoolSlot(
  usage: PoolUsage,
  field: "global" | "byAgentType" | "byProvider" | "byModel",
  key: string | undefined,
  expectedUsed: number,
  expectedCap?: number,
): void {
  let slot: { used: number; cap: number } | undefined;
  switch (field) {
    case "global":
      slot = usage.global;
      break;
    case "byAgentType":
      slot = key !== undefined ? usage.byAgentType[key] : undefined;
      break;
    case "byProvider":
      slot = key !== undefined ? usage.byProvider[key] : undefined;
      break;
    case "byModel":
      slot = key !== undefined ? usage.byModel[key] : undefined;
      break;
  }
  expect(slot).toBeDefined();
  expect(slot!.used).toBe(expectedUsed);
  if (expectedCap !== undefined) {
    expect(slot!.cap).toBe(expectedCap);
  }
}

// ─── Tests ───────────────────────────────────────────────────────

describe("createScheduler", () => {
  it("returns a working scheduler with default config (no throw)", () => {
    const scheduler = createScheduler();
    expect(scheduler.tryAcquire(node())).toBe(true);
    const u = scheduler.usage();
    expect(u.global.used).toBe(1);
    expect(u.global.cap).toBe(CONFIG_DEFAULTS.maxAgentConcurrency);
  });
});

// ─── Pool membership — which pools a node belongs to ──────────────
//
// These tests assert that the scheduler correctly determines the set of
// pools a node requires. The membership logic is:
//
//   pools = [global]
//   if agentType limit exists       → pools += byAgentType[agentType]
//   if provider limit exists        → pools += byProvider[provider]
//   if model limit exists           → pools += byModel[provider/model]
//                                    (fallback: bare model if not found)
//
// AND semantics: tryAcquire succeeds ONLY when ALL pools have a free slot.

describe("tryAcquire — basic pool membership", () => {
  it("global pool alone — node with no limits defined", () => {
    // Config has maxAgentConcurrency=12, no per-type limits
    const scheduler = createScheduler(config({ maxAgentConcurrency: 12 }));

    // A plain node should only contend for the global pool
    const n = node({ agentType: "pi", provider: "anthropic", model: "claude-sonnet-4" });
    expect(scheduler.tryAcquire(n)).toBe(true);

    const u = scheduler.usage();
    expect(u.global.used).toBe(1);
    expect(u.global.cap).toBe(12);
    // Per-type pools should be empty (no limits defined)
    expect(Object.keys(u.byAgentType)).toHaveLength(0);
    expect(Object.keys(u.byProvider)).toHaveLength(0);
    expect(Object.keys(u.byModel)).toHaveLength(0);
  });

  it("byAgentType pool — node with agentType matching a configured limit", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: { byAgentType: { codex: 3 } },
      }),
    );

    // codex agent — belongs to global + byAgentType[codex]
    const n = node({ agentType: "codex" });
    expect(scheduler.tryAcquire(n)).toBe(true);

    const u = scheduler.usage();
    expectPoolSlot(u, "global", undefined, 1, 12);
    expectPoolSlot(u, "byAgentType", "codex", 1, 3);
    // Other agent types should not appear
    expect(u.byAgentType["pi"]).toBeUndefined();
  });

  it("byProvider pool — node with provider matching a configured limit", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: { byProvider: { anthropic: 5 } },
      }),
    );

    const n = node({ provider: "anthropic" });
    expect(scheduler.tryAcquire(n)).toBe(true);

    const u = scheduler.usage();
    expectPoolSlot(u, "global", undefined, 1, 12);
    expectPoolSlot(u, "byProvider", "anthropic", 1, 5);
  });

  it("byModel pool — uses provider/model key when limit defined", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: { byModel: { "anthropic/claude-sonnet-4-20250514": 3 } },
      }),
    );

    const n = node({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
    expect(scheduler.tryAcquire(n)).toBe(true);

    const u = scheduler.usage();
    expectPoolSlot(u, "byModel", "anthropic/claude-sonnet-4-20250514", 1, 3);
  });

  it("byModel pool — falls back to bare model key when provider/model not found", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: { byModel: { "claude-sonnet-4-20250514": 3 } },
      }),
    );

    // The limit is defined on bare model, not provider/model
    const n = node({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
    expect(scheduler.tryAcquire(n)).toBe(true);

    const u = scheduler.usage();
    // Should have matched the bare model key
    expectPoolSlot(u, "byModel", "claude-sonnet-4-20250514", 1, 3);
    // The composite key should NOT exist
    expect(u.byModel["anthropic/claude-sonnet-4-20250514"]).toBeUndefined();
  });

  it("byModel pool — provider/key preferred over bare model when both are defined", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byModel: {
            "anthropic/claude-sonnet-4-20250514": 2,
            "claude-sonnet-4-20250514": 5,
          },
        },
      }),
    );

    const n = node({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
    expect(scheduler.tryAcquire(n)).toBe(true);

    const u = scheduler.usage();
    // Must use the composite key (limit 2), not the bare model (limit 5)
    expectPoolSlot(u, "byModel", "anthropic/claude-sonnet-4-20250514", 1, 2);
    expect(u.byModel["claude-sonnet-4-20250514"]).toBeUndefined();
  });
});

// ─── AND-semantics — the critical property ───────────────────────
//
// A node must have room in ALL its pools before it can proceed. This makes
// the scheduler fundamentally different from OR-semantics (where you'd try
// up to N pools and accept any that fits).

describe("AND-semantics: tryAcquire requires ALL pools to have capacity", () => {
  it("denies when byModel pool is full even though byProvider has room", () => {
    // provider cap = 5, model cap = 3
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byProvider: { anthropic: 5 },
          byModel: { "anthropic/claude-sonnet-4": 3 },
        },
      }),
    );

    const n = node({ provider: "anthropic", model: "claude-sonnet-4" });

    // Fill the model pool to capacity (3 slots)
    expect(scheduler.tryAcquire(n)).toBe(true); // 1
    expect(scheduler.tryAcquire(n)).toBe(true); // 2
    expect(scheduler.tryAcquire(n)).toBe(true); // 3

    // Model pool is full (3/3). Provider pool still has room (3/5).
    // tryAcquire should return FALSE because the model pool is full.
    expect(scheduler.tryAcquire(n)).toBe(false);

    // Usage should still show provider 3/5 and model 3/3 (nothing leaked)
    const u = scheduler.usage();
    expectPoolSlot(u, "byProvider", "anthropic", 3, 5);
    expectPoolSlot(u, "byModel", "anthropic/claude-sonnet-4", 3, 3);
  });

  it("denies when global pool is full even though per-type pools have room", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 2,
        limits: {
          byProvider: { anthropic: 10 },
        },
      }),
    );

    const n = node({ provider: "anthropic" });

    // Fill the global pool to capacity (2/2)
    expect(scheduler.tryAcquire(n)).toBe(true); // 1
    expect(scheduler.tryAcquire(n)).toBe(true); // 2

    // Global is full (2/2); provider still has room (2/10).
    // tryAcquire should return FALSE.
    expect(scheduler.tryAcquire(n)).toBe(false);

    const u = scheduler.usage();
    expect(u.global.used).toBe(2);
    expect(u.global.cap).toBe(2);
    expectPoolSlot(u, "byProvider", "anthropic", 2, 10);
  });

  it("denies when byAgentType pool is full even though global has room", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byAgentType: { codex: 1 },
        },
      }),
    );

    const n = node({ agentType: "codex" });

    // Fill agent-type pool (1/1)
    expect(scheduler.tryAcquire(n)).toBe(true);

    // Agent-type pool is full; global (1/12) has room.
    expect(scheduler.tryAcquire(n)).toBe(false);

    const u = scheduler.usage();
    expect(u.global.used).toBe(1);
    expectPoolSlot(u, "byAgentType", "codex", 1, 1);
  });

  it("denies when byProvider pool is full even though global + model have room", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byProvider: { anthropic: 2 },
          byModel: { "anthropic/claude-sonnet-4": 5 },
        },
      }),
    );

    const n = node({ provider: "anthropic", model: "claude-sonnet-4" });

    // Fill provider pool (2/2)
    expect(scheduler.tryAcquire(n)).toBe(true);
    expect(scheduler.tryAcquire(n)).toBe(true);

    // Provider full (2/2); model (2/5) and global (2/12) have room.
    expect(scheduler.tryAcquire(n)).toBe(false);
  });

  it("recovers after releasing a slot in the full pool", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byProvider: { anthropic: 5 },
          byModel: { "anthropic/claude-sonnet-4": 2 },
        },
      }),
    );

    const n = node({ provider: "anthropic", model: "claude-sonnet-4" });

    // Fill model pool (2/2)
    expect(scheduler.tryAcquire(n)).toBe(true);
    expect(scheduler.tryAcquire(n)).toBe(true);

    // Model pool full — denied
    expect(scheduler.tryAcquire(n)).toBe(false);

    // Release one slot
    scheduler.release(n); // release one acquires worth

    // Now tryAcquire should succeed again
    expect(scheduler.tryAcquire(n)).toBe(true);

    const u = scheduler.usage();
    // After release of 1 then acquire of 1: net effect = 2 still in use
    expectPoolSlot(u, "byProvider", "anthropic", 2, 5);
    expectPoolSlot(u, "byModel", "anthropic/claude-sonnet-4", 2, 2);
  });
});

// ─── release — decrements all pools ──────────────────────────────

describe("release", () => {
  it("decrements all pools the node belonged to", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byAgentType: { codex: 3 },
          byProvider: { anthropic: 5 },
          byModel: { "anthropic/claude-sonnet-4": 4 },
        },
      }),
    );

    const n = node({ agentType: "codex", provider: "anthropic", model: "claude-sonnet-4" });

    // Claim one slot in all pools
    expect(scheduler.tryAcquire(n)).toBe(true);

    const u1 = scheduler.usage();
    expectPoolSlot(u1, "global", undefined, 1, 12);
    expectPoolSlot(u1, "byAgentType", "codex", 1, 3);
    expectPoolSlot(u1, "byProvider", "anthropic", 1, 5);
    expectPoolSlot(u1, "byModel", "anthropic/claude-sonnet-4", 1, 4);

    // Release
    scheduler.release(n);

    const u2 = scheduler.usage();
    expectPoolSlot(u2, "global", undefined, 0, 12);
    expectPoolSlot(u2, "byAgentType", "codex", 0, 3);
    expectPoolSlot(u2, "byProvider", "anthropic", 0, 5);
    expectPoolSlot(u2, "byModel", "anthropic/claude-sonnet-4", 0, 4);
  });

  it("releasing a node that was never acquired does not underflow", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byProvider: { anthropic: 5 },
        },
      }),
    );

    const n = node({ provider: "anthropic" });

    // Should not throw (implementation should clamp at 0)
    expect(() => {
      scheduler.release(n);
    }).not.toThrow();

    // Usage should remain at 0
    const u = scheduler.usage();
    expect(u.global.used).toBe(0);
    expectPoolSlot(u, "byProvider", "anthropic", 0, 5);
  });

  it("multiple releases without acquires only affect the specific node's pools", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byProvider: { anthropic: 5, openai: 3 },
        },
      }),
    );

    // Acquire an anthropic node and an openai node
    const anthro = node({ provider: "anthropic" });
    const openai = node({ provider: "openai" });

    expect(scheduler.tryAcquire(anthro)).toBe(true);
    expect(scheduler.tryAcquire(openai)).toBe(true);

    // Release the anthropic node
    scheduler.release(anthro);

    const u = scheduler.usage();
    // Anthropic pool should be freed; openai pool should remain
    expectPoolSlot(u, "byProvider", "anthropic", 0, 5);
    expectPoolSlot(u, "byProvider", "openai", 1, 3);
  });
});

// ─── usage() — snapshot ──────────────────────────────────────────

describe("usage()", () => {
  it("returns a PoolUsage with the correct shape when no pools exist", () => {
    const scheduler = createScheduler(config({ maxAgentConcurrency: 12 }));

    const u = scheduler.usage();

    // All must be present with correct types
    expect(u).toHaveProperty("global");
    expect(u.global).toHaveProperty("used");
    expect(u.global).toHaveProperty("cap");
    expect(u.global.used).toBe(0);
    expect(u.global.cap).toBe(12);

    // Per-type pools are empty objects
    expect(u.byAgentType).toEqual({});
    expect(u.byProvider).toEqual({});
    expect(u.byModel).toEqual({});
  });

  it("reflects acquired and released state accurately", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 10,
        limits: {
          byProvider: { anthropic: 5 },
          byModel: { "anthropic/claude-sonnet-4": 4 },
        },
      }),
    );

    const n = node({ provider: "anthropic", model: "claude-sonnet-4" });

    // Acquire 3 nodes
    expect(scheduler.tryAcquire(n)).toBe(true);
    expect(scheduler.tryAcquire(n)).toBe(true);
    expect(scheduler.tryAcquire(n)).toBe(true);

    const u1 = scheduler.usage();
    expectPoolSlot(u1, "global", undefined, 3, 10);
    expectPoolSlot(u1, "byProvider", "anthropic", 3, 5);
    expectPoolSlot(u1, "byModel", "anthropic/claude-sonnet-4", 3, 4);

    // Release 1
    scheduler.release(n);

    const u2 = scheduler.usage();
    expectPoolSlot(u2, "global", undefined, 2, 10);
    expectPoolSlot(u2, "byProvider", "anthropic", 2, 5);
    expectPoolSlot(u2, "byModel", "anthropic/claude-sonnet-4", 2, 4);
  });

  it("shows byAgentType pools when limits are defined", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byAgentType: { pi: 4, codex: 2 },
        },
      }),
    );

    const piNode = node({ agentType: "pi" });
    const codexNode = node({ agentType: "codex" });

    expect(scheduler.tryAcquire(piNode)).toBe(true);
    expect(scheduler.tryAcquire(piNode)).toBe(true);
    expect(scheduler.tryAcquire(codexNode)).toBe(true);

    const u = scheduler.usage();
    expectPoolSlot(u, "byAgentType", "pi", 2, 4);
    expectPoolSlot(u, "byAgentType", "codex", 1, 2);
  });

  it("shows byModel pools with both composite and bare keys when applicable", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byModel: {
            "anthropic/claude-sonnet-4": 3,
            "openai/gpt-4o": 2,
          },
        },
      }),
    );

    const claude = node({ provider: "anthropic", model: "claude-sonnet-4" });
    const gpt = node({ provider: "openai", model: "gpt-4o" });

    expect(scheduler.tryAcquire(claude)).toBe(true);
    expect(scheduler.tryAcquire(claude)).toBe(true);
    expect(scheduler.tryAcquire(gpt)).toBe(true);

    const u = scheduler.usage();
    expectPoolSlot(u, "byModel", "anthropic/claude-sonnet-4", 2, 3);
    expectPoolSlot(u, "byModel", "openai/gpt-4o", 1, 2);
  });
});

// ─── agentType default ──────────────────────────────────────────

describe("agentType defaults to 'pi'", () => {
  it("uses 'pi' as the agentType when the field is absent", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byAgentType: { pi: 3 },
        },
      }),
    );

    // Node with NO agentType set — should default to "pi"
    const n: SchedulableNode = { provider: "anthropic", model: "claude-sonnet-4" };

    expect(scheduler.tryAcquire(n)).toBe(true);

    const u = scheduler.usage();
    expectPoolSlot(u, "byAgentType", "pi", 1, 3);
  });
});

// ─── global cap independent ─────────────────────────────────────

describe("global cap is independent of per-type pools", () => {
  it("global pool fills independently of per-type pools", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 3,
        limits: {
          byProvider: { anthropic: 5 },
          byModel: { "anthropic/claude-sonnet-4": 5 },
        },
      }),
    );

    const n = node({ provider: "anthropic", model: "claude-sonnet-4" });

    // Per-type pools have high caps; only global will constrain
    expect(scheduler.tryAcquire(n)).toBe(true);
    expect(scheduler.tryAcquire(n)).toBe(true);
    expect(scheduler.tryAcquire(n)).toBe(true);

    // Global is full (3/3); per-type pools still have room
    expect(scheduler.tryAcquire(n)).toBe(false);

    const u = scheduler.usage();
    expect(u.global.used).toBe(3);
    expect(u.global.cap).toBe(3);
    expectPoolSlot(u, "byProvider", "anthropic", 3, 5);
    expectPoolSlot(u, "byModel", "anthropic/claude-sonnet-4", 3, 5);
  });

  it("global pool with no per-type limits — only global constrains", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 2,
      }),
    );

    const n = node();

    expect(scheduler.tryAcquire(n)).toBe(true);
    expect(scheduler.tryAcquire(n)).toBe(true);
    expect(scheduler.tryAcquire(n)).toBe(false);
  });
});

// ─── Config with no limits ──────────────────────────────────────

describe("config with no limits → only global pool applies", () => {
  it("default config limits: maxAgentConcurrency=12, no per-type limits", () => {
    const scheduler = createScheduler(); // no config at all

    const n = node();
    expect(scheduler.tryAcquire(n)).toBe(true);

    const u = scheduler.usage();
    expect(u.global.used).toBe(1);
    expect(u.global.cap).toBe(CONFIG_DEFAULTS.maxAgentConcurrency); // 12
    expect(Object.keys(u.byAgentType)).toHaveLength(0);
    expect(Object.keys(u.byProvider)).toHaveLength(0);
    expect(Object.keys(u.byModel)).toHaveLength(0);
  });

  it("config with limits undefined → only global pool", () => {
    const scheduler = createScheduler(config({ maxAgentConcurrency: 5, limits: undefined }));

    const n = node({ agentType: "codex", provider: "openai", model: "gpt-4o" });
    expect(scheduler.tryAcquire(n)).toBe(true);

    const u = scheduler.usage();
    expect(u.global.used).toBe(1);
    expect(u.global.cap).toBe(5);
    // No per-type pools even though node has agentType/provider/model
    expect(Object.keys(u.byAgentType)).toHaveLength(0);
    expect(Object.keys(u.byProvider)).toHaveLength(0);
    expect(Object.keys(u.byModel)).toHaveLength(0);
  });
});

// ─── Mixed nodes — multiple concurrent agents ───────────────────

describe("mixed nodes with different pool memberships", () => {
  it("different providers only compete on global pool", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 3,
        limits: {
          byProvider: { anthropic: 2, openai: 2 },
          byModel: {
            "anthropic/claude-sonnet-4": 2,
            "openai/gpt-4o": 2,
          },
        },
      }),
    );

    const anthro = node({ provider: "anthropic", model: "claude-sonnet-4" });
    const openai = node({ provider: "openai", model: "gpt-4o" });

    // Fill both per-type pools — each provider has 2 slots
    expect(scheduler.tryAcquire(anthro)).toBe(true);
    expect(scheduler.tryAcquire(anthro)).toBe(true);
    expect(scheduler.tryAcquire(openai)).toBe(true);

    // Each provider is full; global is 3/3
    expect(scheduler.tryAcquire(anthro)).toBe(false);
    expect(scheduler.tryAcquire(openai)).toBe(false);
  });

  it("nodes with no model key still respect the provider cap (AND semantics)", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byProvider: { anthropic: 2 },
          byModel: { "anthropic/claude-sonnet-4": 2 },
        },
      }),
    );

    // Node A has a model (binds to model pool)
    const withModel = node({ provider: "anthropic", model: "claude-sonnet-4" });
    // Node B has no model (only global + provider)
    const withoutModel: SchedulableNode = { provider: "anthropic" };

    expect(scheduler.tryAcquire(withModel)).toBe(true);
    expect(scheduler.tryAcquire(withModel)).toBe(true); // provider + model now full (2/2)

    // Node B has no model pool, but provider (2/2) is full → denied by AND semantics.
    expect(scheduler.tryAcquire(withoutModel)).toBe(false);

    const u = scheduler.usage();
    expect(u.global.used).toBe(2);
    expectPoolSlot(u, "byProvider", "anthropic", 2, 2);
    expectPoolSlot(u, "byModel", "anthropic/claude-sonnet-4", 2, 2);

    // Release one withModel slot; provider frees up → withoutModel now succeeds.
    scheduler.release(withModel);
    expect(scheduler.tryAcquire(withoutModel)).toBe(true);
  });

  // The above test reveals a subtlety: if node B has NO model, it doesn't
  // check the model pool... but it DOES check the provider pool (cap 2).
  // After acquiring withModel twice, provider is 2/2. So withoutModel
  // should be DENIED. Let me fix the test:
  it("(corrected) nodes with no model key still respect provider cap", () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byProvider: { anthropic: 2 },
          byModel: { "anthropic/claude-sonnet-4": 5 }, // high cap
        },
      }),
    );

    const withModel = node({ provider: "anthropic", model: "claude-sonnet-4" });
    const withoutModel: SchedulableNode = { provider: "anthropic" };

    expect(scheduler.tryAcquire(withModel)).toBe(true);
    expect(scheduler.tryAcquire(withModel)).toBe(true);

    // Provider pool is full (2/2) — withoutModel should be denied
    // even though it has no model pool to contend with.
    expect(scheduler.tryAcquire(withoutModel)).toBe(false);

    // Release one slot from withModel
    scheduler.release(withModel);

    // Now provider has room (1/2) — withoutModel should succeed
    expect(scheduler.tryAcquire(withoutModel)).toBe(true);
  });
});

// ─── acquire() — async blocking acquire (FIFO, AbortSignal) ───────

describe("acquire()", () => {
  it("returns true immediately when tryAcquire succeeds (no contention)", async () => {
    const scheduler = createScheduler(config({ maxAgentConcurrency: 12 }));
    const n = node();
    const result = await scheduler.acquire(n);
    expect(result).toBe(true);
    expect(scheduler.usage().global.used).toBe(1);
  });

  it("returns false when signal is already aborted on entry", async () => {
    const scheduler = createScheduler(config({ maxAgentConcurrency: 1 }));
    const n = node();

    // Fill the pool
    expect(scheduler.tryAcquire(n)).toBe(true);

    const controller = new AbortController();
    controller.abort();

    const result = await scheduler.acquire(n, controller.signal);
    expect(result).toBe(false);
    // Pool usage unchanged (no slot claimed)
    expect(scheduler.usage().global.used).toBe(1);
  });

  it("waiter wakes when a slot is released", async () => {
    const scheduler = createScheduler(config({ maxAgentConcurrency: 1 }));
    const n = node();

    // Fill the pool (1/1)
    expect(scheduler.tryAcquire(n)).toBe(true);
    expect(scheduler.usage().global.used).toBe(1);

    // Start an acquire that must wait
    const acquirePromise = scheduler.acquire(n);

    // Give the promise a tick to queue the waiter
    await new Promise((r) => setTimeout(r, 5));

    // Release the held slot — should wake the waiter
    scheduler.release(n);

    const result = await acquirePromise;
    expect(result).toBe(true);
    // The waiter now holds the slot
    expect(scheduler.usage().global.used).toBe(1);
  });

  it("aborted waiter returns false and does not steal a slot", async () => {
    const scheduler = createScheduler(config({ maxAgentConcurrency: 1 }));
    const n = node();

    // Fill the pool
    expect(scheduler.tryAcquire(n)).toBe(true);

    const controller = new AbortController();
    const acquirePromise = scheduler.acquire(n, controller.signal);

    // Give the promise a tick to queue the waiter
    await new Promise((r) => setTimeout(r, 5));

    // Abort the waiter
    controller.abort();

    const result = await acquirePromise;
    expect(result).toBe(false);

    // The original slot should still be held
    expect(scheduler.usage().global.used).toBe(1);

    // Releasing that slot should free it (no leak from the aborted waiter)
    scheduler.release(n);
    expect(scheduler.usage().global.used).toBe(0);
  });

  it("aborted waiter does not prevent other waiters from being woken", async () => {
    const scheduler = createScheduler(config({ maxAgentConcurrency: 1 }));
    const n = node();

    // Fill the pool
    expect(scheduler.tryAcquire(n)).toBe(true);

    // Queue waiter A (will be aborted)
    const ctrlA = new AbortController();
    const promiseA = scheduler.acquire(n, ctrlA.signal);

    // Queue waiter B (no abort)
    const promiseB = scheduler.acquire(n);

    // Give both a tick to queue
    await new Promise((r) => setTimeout(r, 5));

    // Abort A
    ctrlA.abort();
    const resultA = await promiseA;
    expect(resultA).toBe(false);

    // Release the held slot — B should wake
    scheduler.release(n);
    const resultB = await promiseB;
    expect(resultB).toBe(true);

    expect(scheduler.usage().global.used).toBe(1);
  });

  it("FIFO fairness: waiters are woken in insertion order", async () => {
    const scheduler = createScheduler(config({ maxAgentConcurrency: 1 }));
    const n = node();

    // Fill the pool
    expect(scheduler.tryAcquire(n)).toBe(true);

    const order: number[] = [];

    // Queue 3 waiters
    const p1 = scheduler.acquire(n).then((ok) => {
      order.push(1);
      return ok;
    });
    const p2 = scheduler.acquire(n).then((ok) => {
      order.push(2);
      return ok;
    });
    const p3 = scheduler.acquire(n).then((ok) => {
      order.push(3);
      return ok;
    });

    // Give them a tick to queue
    await new Promise((r) => setTimeout(r, 5));

    // Release once — first waiter should wake
    scheduler.release(n);
    expect(await p1).toBe(true);
    expect(order).toEqual([1]);

    // Release again — second waiter should wake
    scheduler.release(n);
    expect(await p2).toBe(true);
    expect(order).toEqual([1, 2]);

    // Release again — third waiter should wake
    scheduler.release(n);
    expect(await p3).toBe(true);
    expect(order).toEqual([1, 2, 3]);

    expect(scheduler.usage().global.used).toBe(1);
  });

  it("no deadlock under contention: many waiters with gradual release", async () => {
    // Global cap = 3; 10 competing nodes; release one at a time.
    const scheduler = createScheduler(config({ maxAgentConcurrency: 3 }));
    const n = node();

    // Acquire 3 slots to fill the pool
    expect(scheduler.tryAcquire(n)).toBe(true);
    expect(scheduler.tryAcquire(n)).toBe(true);
    expect(scheduler.tryAcquire(n)).toBe(true);

    const results: boolean[] = [];
    const waiters: Promise<boolean>[] = [];

    // Queue 7 more waiters (total competition: 10)
    for (let i = 0; i < 7; i++) {
      waiters.push(
        scheduler.acquire(n).then((ok) => {
          results.push(ok);
          return ok;
        }),
      );
    }

    // Give them a tick to queue
    await new Promise((r) => setTimeout(r, 5));

    // Release all 3 slots one at a time — each release should wake one waiter
    scheduler.release(n);
    scheduler.release(n);
    scheduler.release(n);

    // Wait for all waiters to settle (first 3 succeed, remaining 4 still queued)
    await new Promise((r) => setTimeout(r, 10));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(results).toHaveLength(3);
    // Exactly 3 slots should be held
    expect(scheduler.usage().global.used).toBe(3);

    // Release the 3 held slots — this should wake the remaining 4 waiters
    results.length = 0;
    scheduler.release(n);
    await new Promise((r) => setTimeout(r, 10));
    scheduler.release(n);
    await new Promise((r) => setTimeout(r, 10));
    scheduler.release(n);
    await new Promise((r) => setTimeout(r, 10));

    // 3 waiters should have succeeded by now
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(scheduler.usage().global.used).toBe(3);

    // Release one more to wake the 7th waiter
    scheduler.release(n);
    await new Promise((r) => setTimeout(r, 10));
    expect(results.filter(Boolean)).toHaveLength(4);
  });

  it("AND-semantics: waiter waits until ALL its pools have capacity", async () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byProvider: { anthropic: 1 },
          byModel: { "anthropic/claude-sonnet-4": 1 },
        },
      }),
    );

    const n = node({ provider: "anthropic", model: "claude-sonnet-4" });

    // Fill both per-type pools
    expect(scheduler.tryAcquire(n)).toBe(true);

    // Start an acquire that must wait
    const acquirePromise = scheduler.acquire(n);
    await new Promise((r) => setTimeout(r, 5));

    // It's still queued — global has room but provider and model are full
    // Releasing only the global slot doesn't help the waiter (still blocked
    // on provider & model). We need to release all the *node's* pools.
    // Actually, `release(n)` releases all pools n belongs to (global + provider + model).
    // But we only filled them once. Let me use a different approach:

    // Release the held slot — this frees global (12→11), provider (1→0), model (1→0)
    scheduler.release(n);

    const result = await acquirePromise;
    expect(result).toBe(true);
    // The waiter now holds all three pools
    expect(scheduler.usage().global.used).toBe(1);
    expectPoolSlot(scheduler.usage(), "byProvider", "anthropic", 1, 1);
    expectPoolSlot(scheduler.usage(), "byModel", "anthropic/claude-sonnet-4", 1, 1);
  });

  it("AND-semantics: waiter stays queued when only SOME pools free up", async () => {
    const scheduler = createScheduler(
      config({
        maxAgentConcurrency: 12,
        limits: {
          byProvider: { anthropic: 2 },
          byModel: { "anthropic/claude-sonnet-4": 1 },
        },
      }),
    );

    const n1 = node({ provider: "anthropic", model: "claude-sonnet-4" });
    const n2 = node({ provider: "anthropic", model: "gpt-4o" }); // different model, same provider

    // Fill model pool (1/1) with n1; also uses provider (1/2)
    expect(scheduler.tryAcquire(n1)).toBe(true);

    // Fill provider pool (2/2) with n2; model pool is different, so it uses provider only
    // n2's model "gpt-4o" has no configured limit, so it only uses global + provider
    expect(scheduler.tryAcquire(n2)).toBe(true);

    // Now: provider 2/2, model 1/1
    // Start an acquire for n1 (needs both provider + model) — both are full
    const acquirePromise = scheduler.acquire(n1);
    await new Promise((r) => setTimeout(r, 5));

    // Release n2 — this frees provider (2→1) but model is still full (1/1)
    scheduler.release(n2);
    await new Promise((r) => setTimeout(r, 10));

    // Waiter is STILL queued (model is still full)
    expectPoolSlot(scheduler.usage(), "byProvider", "anthropic", 1, 2);
    expectPoolSlot(scheduler.usage(), "byModel", "anthropic/claude-sonnet-4", 1, 1);

    // Release n1 — frees provider (1→0) and model (1→0)
    scheduler.release(n1);

    const result = await acquirePromise;
    expect(result).toBe(true);

    // Waiter now holds all its pools
    expect(scheduler.usage().global.used).toBe(1);
    expectPoolSlot(scheduler.usage(), "byProvider", "anthropic", 1, 2);
    expectPoolSlot(scheduler.usage(), "byModel", "anthropic/claude-sonnet-4", 1, 1);
  });
});

// ─── abort-during-registration race (no stale waiter) ───────────
//
// `acquire()` must register the waiter in the waitQueue BEFORE wiring up the
// abort listener. Otherwise, if the signal fires in the window between
// listener setup and `waitQueue.push(entry)`, the onAbort handler cannot find
// the entry to splice it — leaving a stale entry behind. That stale entry is
// never removed: the next `release()` "wakes" it, acquiring a pool slot that
// nobody holds and never releases (a permanent capacity leak + queue
// pollution).
//
// A real AbortController only ever fires its listener during an explicit
// `abort()` call, so to deterministically exercise the registration window we
// use a minimal fake signal that dispatches its listener synchronously the
// instant it is registered. This models the race without relying on scheduler
// internals or private state.

describe("acquire() — abort-during-registration leaves no stale waiter", () => {
  /**
   * Minimal AbortSignal double. `addEventListener` fires the callback
   * SYNCHRONOUSLY at registration time — i.e. the abort happens in the exact
   * window between the listener being wired up and the entry being pushed to
   * the waitQueue. `aborted` is intentionally kept `false` so the race is
   * driven purely by the listener dispatch, not by an already-aborted flag.
   */
  function racingSignal(): AbortSignal {
    return {
      get aborted(): boolean {
        return false;
      },
      addEventListener(_type: string, cb: () => void): void {
        // Fire immediately: this is the race. The listener exists, but the
        // waiter entry may not yet be in the queue.
        cb();
      },
      removeEventListener(): void {
        /* no-op */
      },
    } as unknown as AbortSignal;
  }

  it("does not leak a slot when abort fires during listener registration", async () => {
    // Capacity 1: first acquire fills the pool, second acquire must queue.
    const scheduler = createScheduler(config({ maxAgentConcurrency: 1 }));
    const n = node();

    // 1. Fill the pool (1/1).
    expect(scheduler.tryAcquire(n)).toBe(true);

    // 2. Second acquire queues; the racing signal "aborts" while the waiter
    //    entry is being set up. The acquire must resolve to false.
    const result = await scheduler.acquire(n, racingSignal());
    expect(result).toBe(false);

    // 3. Release the only real holder. The pool must drain to zero.
    //    BUGGY (register-then-push): onAbort ran before the push, so it could
    //    not splice the entry; the now-stale entry gets woken here, stealing a
    //    slot nobody holds → global.used stays at 1 (a leak).
    //    FIXED (push-then-register): onAbort finds and removes the entry, so
    //    nothing is left to wake → global.used is 0.
    scheduler.release(n);
    expect(scheduler.usage().global.used).toBe(0);
  });

  it("leaves the waitQueue empty so a fresh acquire succeeds immediately", async () => {
    const scheduler = createScheduler(config({ maxAgentConcurrency: 1 }));
    const n = node();

    // Fill the pool, then perform a racing (aborted) acquire.
    expect(scheduler.tryAcquire(n)).toBe(true);
    expect(await scheduler.acquire(n, racingSignal())).toBe(false);

    // Free the pool.
    scheduler.release(n);
    expect(scheduler.usage().global.used).toBe(0);

    // A brand-new acquire with no signal must succeed synchronously — proving
    // no stale (already-resolved) waiter is lingering ahead of it to consume
    // the slot. BUGGY: the stale entry steals the slot, so this resolves true
    // only via the stale waiter being woken AND global.used ends at 1 with the
    // fresh acquire returning false (denied) instead.
    const fresh = scheduler.acquire(n);
    expect(await fresh).toBe(true);
    expect(scheduler.usage().global.used).toBe(1);
  });
});
