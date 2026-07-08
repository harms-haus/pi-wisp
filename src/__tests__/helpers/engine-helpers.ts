// ═══════════════════════════════════════════════════════════════════════════
// Engine / spawner test helpers.
//
// Ported from `@harms-haus/pi-subagents/src/__tests__/helpers.ts` and adapted
// to wisp's shapes:
//   - createMockProcess — EventEmitter-based ChildProcess (port)
// ═══════════════════════════════════════════════════════════════════════════

import { EventEmitter } from "node:events";
import { vi } from "vitest";

// ─── createMockProcess ──────────────────────────────────────────────
// Used by: spawner tests (S10).

/** Type for the mock ChildProcess returned by {@link createMockProcess}. */
export type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  pid: number | undefined;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

/**
 * Create a mock `ChildProcess` with `EventEmitter`-based stdout/stderr/stdin.
 * The `kill` mock emits `"exit"` with code `0` for `SIGTERM` and `1` otherwise.
 * Ported from pi-subagents' `createMockProcess`.
 */
export function createMockProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  proc.pid = 12345;
  proc.killed = false;
  proc.kill = vi.fn((signal: string) => {
    proc.killed = true;
    proc.emit("exit", signal === "SIGTERM" ? 0 : 1);
  });
  return proc;
}
