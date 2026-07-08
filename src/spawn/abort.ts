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
 * Minimal shape of a killable process. A real `ChildProcess` satisfies this, as
 * do the lightweight mock objects (`{ pid, kill }`) used in tests.
 */
export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * Extended view used internally to attach early-exit listeners. `on` is present
 * on a real `ChildProcess` but absent on plain mock objects, so it stays optional.
 */
type ListenableProcess = KillableProcess & {
  on?(event: string, listener: (...args: unknown[]) => void): void;
};

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

  return new Promise<void>((resolve) => {
    // No pid — nothing to kill.
    if (pid === undefined) {
      resolve();
      return;
    }

    let done = false;

    // 1. SIGTERM immediately.
    treeKill(pid, "SIGTERM");

    // 2. Escalate to SIGKILL after the grace period.
    const sigkillTimer = setTimeout(() => {
      treeKill(pid, "SIGKILL");
    }, sigtermGraceMs);

    // 3. Force-resolve after a further guard period (D-state / uninterruptible).
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(sigkillTimer);
      clearTimeout(forceTimer);
      resolve();
    };

    const forceTimer = setTimeout(finish, sigtermGraceMs + forceResolveMs);

    // Early-exit when the process dies. A real ChildProcess exposes `on`; the
    // lightweight mock objects used in tests do not, so this is best-effort.
    const listenable: ListenableProcess = proc;
    if (typeof listenable.on === "function") {
      listenable.on("exit", finish);
      listenable.on("close", finish);
    }
  });
}
