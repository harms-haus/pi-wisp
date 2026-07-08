// ═══════════════════════════════════════════════════════════════════════════
// Process-abort utilities — killProcessTree (S10)
//
// Kills an entire process tree via `tree-kill` (SCOUTING C3 — pi-subagents'
// dependency, NOT pi-processes' native kill) with SIGTERM → SIGKILL escalation
// and a D-state force-resolve guard ported from pi-processes'
// `process-manager.ts` force-resolve pattern.
// ═══════════════════════════════════════════════════════════════════════════

import treeKill from "tree-kill";

/**
 * Options for {@link killProcessTree}.
 */
export interface KillProcessTreeOptions {
  /** Grace period (ms) after SIGTERM before escalating to SIGKILL. Default: 5000. */
  sigtermGraceMs?: number;
  /**
   * Additional period (ms) after SIGKILL before force-resolving the kill
   * promise (D-state guard). Default: 5000.
   */
  forceResolveMs?: number;
}

/**
 * Minimal shape of a process that {@link killProcessTree} can act on. A real
 * `ChildProcess` satisfies this, as do the mock objects used in tests.
 *
 * `killProcessTree` terminates the tree via `tree-kill` (not `proc.kill()`), so
 * `kill` is retained only to match the `ChildProcess` shape — its type is left
 * permissive (`unknown`) since the value is never read here.
 */
export interface KillableProcess {
  pid?: number;
  kill?: unknown;
}

/**
 * Extended view used internally to attach early-exit listeners. `on`/`off` are
 * present on a real `ChildProcess` (it extends `EventEmitter`) but absent on
 * plain mock objects, so they stay optional.
 */
type ListenableProcess = KillableProcess & {
  on?(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

/** Signals used to escalate a kill from graceful to forced. */
type KillSignal = "SIGTERM" | "SIGKILL";

/**
 * Invoke {@link treeKill} without ever throwing. {@link killProcessTree} must
 * never reject, so failures are surfaced via `console.warn` rather than
 * propagated.
 */
function safeTreeKill(pid: number, signal: KillSignal): void {
  try {
    treeKill(pid, signal);
  } catch (error) {
    console.warn(
      `killProcessTree: tree-kill ${signal} on pid ${pid} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Best-effort removal of an event listener. `EventEmitter.off` is the modern
 * alias for `removeListener`; fall back to `removeListener` for emitters that
 * only expose the older name.
 */
function removeListener(
  proc: ListenableProcess,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  if (typeof proc.off === "function") {
    proc.off(event, listener);
  } else if (typeof proc.removeListener === "function") {
    proc.removeListener(event, listener);
  }
}

/**
 * Kill a process tree with SIGTERM → SIGKILL escalation and a D-state
 * force-resolve guard.
 *
 * Escalation timeline (per SCOUTING C3 / pi-processes' force-resolve pattern):
 *   1. `tree-kill` sends `SIGTERM` to the whole process group immediately.
 *   2. After `sigtermGraceMs` (default 5000), escalates to `SIGKILL`.
 *   3. After a further `forceResolveMs` (default 5000), the returned promise is
 *      force-resolved regardless of process state (guards against D-state /
 *      uninterruptible sleeps).
 *
 * If the process supports event subscription (real `ChildProcess`), an
 * `exit`/`close` listener resolves the promise early and clears all pending
 * timers. A process with no `pid` resolves immediately without invoking
 * `tree-kill`.
 */
export function killProcessTree(
  proc: KillableProcess,
  options?: KillProcessTreeOptions,
): Promise<void> {
  const sigtermGraceMs = options?.sigtermGraceMs ?? 5000;
  const forceResolveMs = options?.forceResolveMs ?? 5000;
  const pid = proc.pid;

  const listenable: ListenableProcess = proc;

  return new Promise<void>((resolve) => {
    // No pid — nothing to kill.
    if (pid === undefined) {
      resolve();
      return;
    }

    let done = false;

    // 1. SIGTERM immediately.
    safeTreeKill(pid, "SIGTERM");

    // 2. Escalate to SIGKILL after the grace period.
    const sigkillTimer = setTimeout(() => {
      safeTreeKill(pid, "SIGKILL");
    }, sigtermGraceMs);

    // 3. Force-resolve after a further guard period (D-state / uninterruptible).
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(sigkillTimer);
      clearTimeout(forceTimer);
      // Detach the early-exit listeners so a process lingering in D-state
      // (uninterruptible sleep) cannot keep them attached forever.
      // `removeListener` is a no-op when the process exposes no EventEmitter
      // API, so it is always safe to call here.
      removeListener(listenable, "exit", finish);
      removeListener(listenable, "close", finish);
      resolve();
    };

    const forceTimer = setTimeout(finish, sigtermGraceMs + forceResolveMs);

    // Early-exit when the process dies. A real ChildProcess exposes `on`; the
    // lightweight mock objects used in tests do not, so this is best-effort.
    if (typeof listenable.on === "function") {
      listenable.on("exit", finish);
      listenable.on("close", finish);
    }
  });
}
