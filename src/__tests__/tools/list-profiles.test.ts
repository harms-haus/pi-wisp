// ═══════════════════════════════════════════════════════════════════════════
// Green tests — list_profiles tool (S35 / PLAN §13 / kb-19).
//
// Tests the list_profiles tool's execute behaviour across scopes and entry
// shapes. Schema validation tests pass because the TypeBox schema is final.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";

import { listProfilesTool, ListProfilesParams } from "../../tools/list-profiles.js";

// ─── Types ──────────────────────────────────────────────────────────

/** Mock context shape. */
interface MockToolCtx {
  cwd: string;
}

// ─── Mocks ─────────────────────────────────────────────────────────

/** Create a minimal mock context. */
function mockCtx(): MockToolCtx {
  return { cwd: "/tmp/test-cwd" };
}

// ─── Schema validation tests (should PASS — schema is final) ──────

describe("list_profiles — schema", () => {
  it("validates params with scope 'all'", () => {
    expect(Value.Check(ListProfilesParams, { scope: "all" })).toBe(true);
  });

  it("validates params with scope 'global'", () => {
    expect(Value.Check(ListProfilesParams, { scope: "global" })).toBe(true);
  });

  it("validates params with scope 'project'", () => {
    expect(Value.Check(ListProfilesParams, { scope: "project" })).toBe(true);
  });

  it("validates params with scope 'run' and runId", () => {
    expect(
      Value.Check(ListProfilesParams, {
        scope: "run",
        runId: "/tmp/.wisp/runs/20250707-test",
      }),
    ).toBe(true);
  });

  it("validates empty params (default scope 'all')", () => {
    expect(Value.Check(ListProfilesParams, {})).toBe(true);
  });

  it("rejects non-string scope", () => {
    expect(Value.Check(ListProfilesParams, { scope: 42 })).toBe(false);
  });

  it("accepts extra keys (Value.Check does not enforce closed objects by default)", () => {
    expect(Value.Check(ListProfilesParams, { extraKey: "oops" })).toBe(true);
  });
});

// ─── Execute behaviour tests ──────────────────────────────────────

describe("list_profiles — execute", () => {
  // ── Basic listing ─────────────────────────────────────────────────

  it("returns profiles across all scopes when called with empty params", async () => {
    const ctx = mockCtx();

    const result = await listProfilesTool.execute("call-1", {}, undefined, undefined, ctx);

    expect(result.content).toBeDefined();
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBeTruthy();
    const details = result.details as { profiles?: unknown[] };
    expect(details).toHaveProperty("profiles");
    expect(Array.isArray(details.profiles)).toBe(true);
  });

  it("returns profiles across all scopes when called with scope 'all'", async () => {
    const ctx = mockCtx();
    const result = await listProfilesTool.execute(
      "call-2",
      { scope: "all" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0]!.text).toBeTruthy();
    const details = result.details as { profiles?: unknown[] };
    expect(Array.isArray(details.profiles)).toBe(true);
  });

  // ── Scope filtering ────────────────────────────────────────────────

  it("returns only global profiles when scope is 'global'", async () => {
    const ctx = mockCtx();
    const result = await listProfilesTool.execute(
      "call-3",
      { scope: "global" },
      undefined,
      undefined,
      ctx,
    );
    const profiles = (result.details as { profiles?: Array<{ source: string }> }).profiles ?? [];
    expect(profiles.every((p) => p.source === "global")).toBe(true);
  });

  it("returns only project profiles when scope is 'project'", async () => {
    const ctx = mockCtx();
    const result = await listProfilesTool.execute(
      "call-4",
      { scope: "project" },
      undefined,
      undefined,
      ctx,
    );
    const profiles = (result.details as { profiles?: Array<{ source: string }> }).profiles ?? [];
    expect(profiles.every((p) => p.source === "project")).toBe(true);
  });

  it("returns only run-artifact profiles when scope is 'run'", async () => {
    const ctx = mockCtx();
    const result = await listProfilesTool.execute(
      "call-5",
      { scope: "run", runId: "/tmp/.wisp/runs/20250707-test" },
      undefined,
      undefined,
      ctx,
    );
    const profiles = (result.details as { profiles?: Array<{ source: string }> }).profiles ?? [];
    expect(profiles.every((p) => p.source === "run-artifact")).toBe(true);
  });

  // ── Entry shape ─────────────────────────────────────────────────────

  it("each entry has the correct shape", async () => {
    const ctx = mockCtx();
    const result = await listProfilesTool.execute(
      "call-6",
      { scope: "all" },
      undefined,
      undefined,
      ctx,
    );
    const profiles =
      (result.details as { profiles?: Array<Record<string, unknown>> }).profiles ?? [];
    for (const entry of profiles) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("agentType");
      expect(entry).toHaveProperty("provider");
      expect(entry).toHaveProperty("model");
      expect(entry).toHaveProperty("thinkingLevel");
      expect(entry).toHaveProperty("toolSummary");
      expect(entry).toHaveProperty("source");
    }
  });

  // ── Input validation ────────────────────────────────────────────────

  it("requires runId when scope is 'run'", async () => {
    const ctx = mockCtx();

    const result = await listProfilesTool.execute(
      "call-7",
      { scope: "run" },
      undefined,
      undefined,
      ctx,
    );

    const details = result.details as { kind?: string; message?: string };
    expect(details.kind).toBe("validation");
    expect(details.message).toBeDefined();
    expect(details.message!.toLowerCase()).toContain("runid");
  });
});
