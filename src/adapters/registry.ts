// ═══════════════════════════════════════════════════════════════════════════
// Adapter registry — GREEN implementation.
//
// registerAdapter / getAdapter / listAdapters manage a module-level store
// of AgentAdapter instances. See tests in src/__tests__/adapters/registry.test.ts.
// ═══════════════════════════════════════════════════════════════════════════

import type { AgentAdapter } from "./types.js";

// ─── AdapterNotRegisteredError ──────────────────────────────────

/**
 * Thrown when `getAdapter()` cannot satisfy a request — either the exact type
 * is absent and no `"pi"` fallback is registered, or the type is unknown even
 * after fallback.
 */
export class AdapterNotRegisteredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterNotRegisteredError";
  }
}

// ─── Module-level store ─────────────────────────────────────────────

const adapters = new Map<string, AgentAdapter>();

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Register an adapter by its `.type` property. Any prior registration for the
 * same type is overwritten.
 */
export function registerAdapter(adapter: AgentAdapter): void {
  adapters.set(adapter.type, adapter);
}

/**
 * Remove all registered adapters. Intended for testing only.
 * @internal
 */
export function clearAdapters(): void {
  adapters.clear();
}

/**
 * Retrieve a registered adapter by type.
 *
 * When the type is unknown (not registered), falls back to the default `"pi"`
 * adapter if one is registered, emitting a `console.warn` with the requested
 * type name. Otherwise throws {@link AdapterNotRegisteredError}.
 *
 * @param type - Adapter type (e.g. `"pi"`, `"codex"`). Defaults to `"pi"`.
 */
export function getAdapter(type: string = "pi"): AgentAdapter {
  // 1. Exact match
  const exact = adapters.get(type);
  if (exact) return exact;

  // 2. Fallback to "pi" only when the requested type differs from "pi"
  if (type !== "pi") {
    const pi = adapters.get("pi");
    if (pi) {
      console.warn(`Adapter type "${type}" not registered, falling back to "pi"`);
      return pi;
    }
  }

  // 3. No fallback available
  throw new AdapterNotRegisteredError(
    `No adapter registered for type "${type}"${
      type !== "pi" ? ' and no fallback "pi" adapter available' : ""
    }`,
  );
}

/**
 * Return the type names of all registered adapters.
 */
export function listAdapters(): string[] {
  return [...adapters.keys()];
}
