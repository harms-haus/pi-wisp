/**
 * Stale-context guards.
 *
 * A "stale" error occurs when the session a handler is operating on has been
 * replaced or reloaded mid-handler (e.g. the user switched branches/commits).
 * Such errors are safe to swallow because the discarded session's work is no
 * longer relevant. Ported from `@harms-haus/pi-workflows`.
 */

/**
 * Check if an error is a stale-context error (session was replaced/reloaded
 * mid-handler). Only real {@link Error} instances whose message contains the
 * substring "stale" qualify.
 */
export function isStaleError(e: unknown): boolean {
  return e instanceof Error && e.message.includes("stale");
}

/**
 * Wrap a synchronous handler so stale-context errors are silently swallowed.
 * Any other error is rethrown unchanged.
 */
export function withStaleGuard(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (isStaleError(e)) return;
    throw e;
  }
}
