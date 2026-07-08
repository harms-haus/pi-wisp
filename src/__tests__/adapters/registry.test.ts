import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  AgentAdapter,
  NormalizedEvent,
  NodeInvocationContext,
  ResolvedProfile,
} from "../../adapters/types.js";
import {
  registerAdapter,
  getAdapter,
  listAdapters,
  clearAdapters,
} from "../../adapters/registry.js";

// ─── Fake adapter factory ─────────────────────────────────────────

/**
 * Build a minimal fake adapter for testing the registry.
 *
 * Every method returns predictable values so tests focus on registry behaviour
 * rather than adapter implementation.
 */
function fakeAdapter(type: string): AgentAdapter {
  return {
    type,

    buildInvocation(_profile: ResolvedProfile, _ctx: NodeInvocationContext) {
      return { command: "pi", args: ["--mode", "json"], env: {}, stdinPrompt: "hello" };
    },

    parseEventStreamLine(_line: string): NormalizedEvent | null {
      return null;
    },

    supportsNativeResume: false,

    buildResumePrompt(priorTranscript: string, newPrompt: string): string {
      return `Previously:\n\n${priorTranscript}\n\nInstructions:\n\n${newPrompt}`;
    },

    extractSessionId(_events: NormalizedEvent[]): string | undefined {
      return "session-fake";
    },

    extractFileEdits(_events: NormalizedEvent[]): string[] {
      return [];
    },
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────

const piAdapter = fakeAdapter("pi");
const codexAdapter = fakeAdapter("codex");

// ─── Tests ────────────────────────────────────────────────────────

describe("adapter registry", () => {
  // Reset registry state so each test starts clean.
  beforeEach(() => {
    clearAdapters();
  });

  // ── register + get (happy path) ───────────────────────────────

  it("registerAdapter stores an adapter that getAdapter retrieves", () => {
    registerAdapter(piAdapter);

    const retrieved = getAdapter("pi");
    expect(retrieved).toBe(piAdapter);
    expect(retrieved.type).toBe("pi");
  });

  // ── multiple adapters ─────────────────────────────────────────

  it("supports multiple adapters registered simultaneously", () => {
    registerAdapter(piAdapter);
    registerAdapter(codexAdapter);

    expect(getAdapter("pi").type).toBe("pi");
    expect(getAdapter("codex").type).toBe("codex");
  });

  // ── default fallback ──────────────────────────────────────────

  it("getAdapter for an unknown type returns the default 'pi' adapter", () => {
    registerAdapter(piAdapter);

    const fallback = getAdapter("unknown-type");
    expect(fallback).toBe(piAdapter);
    expect(fallback.type).toBe("pi");
  });

  it("getAdapter warns via console.warn when falling back to 'pi'", () => {
    registerAdapter(piAdapter);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fallback = getAdapter("codex");
    expect(fallback).toBe(piAdapter);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("codex"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("pi"));

    warnSpy.mockRestore();
  });

  // ── listAdapters ──────────────────────────────────────────────

  it("listAdapters returns the type names of all registered adapters", () => {
    registerAdapter(piAdapter);
    registerAdapter(codexAdapter);

    const names = listAdapters();
    expect(names).toContain("pi");
    expect(names).toContain("codex");
    expect(names.length).toBe(2);
  });

  // ── overwrite on same type ────────────────────────────────────

  it("registering a second adapter with the same type overwrites the first", () => {
    const v1 = fakeAdapter("pi");
    const v2 = fakeAdapter("pi");
    v2.buildInvocation = () => ({
      command: "pi",
      args: ["--version", "v2"],
      env: {},
      stdinPrompt: "overwritten",
    });

    registerAdapter(v1);
    registerAdapter(v2);

    const retrieved = getAdapter("pi");
    expect(retrieved).not.toBe(v1);
    expect(retrieved).toBe(v2);
  });

  // ── getAdapter defaults ───────────────────────────────────────

  it("getAdapter with no argument defaults to 'pi'", () => {
    registerAdapter(piAdapter);

    // Calling getAdapter() without arguments should behave like getAdapter("pi")
    const retrieved = getAdapter();
    expect(retrieved).toBe(piAdapter);
  });

  // ── empty registry: getAdapter of unknown type with no pi ─────

  it("getAdapter throws when neither the requested type nor 'pi' is registered", () => {
    // Register something that is NOT pi, so the fallback also fails
    registerAdapter(codexAdapter);

    // Should throw because "unknown" is not registered and no "pi" fallback exists
    expect(() => getAdapter("unknown")).toThrow();
  });

  // ── listAdapters empty ────────────────────────────────────────

  it("listAdapters returns an empty array when no adapters are registered", () => {
    const names = listAdapters();
    expect(names).toEqual([]);
  });
});
