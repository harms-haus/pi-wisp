// ═══════════════════════════════════════════════════════════════════════════
// DSL subprocess — spawn a node subprocess, accumulate stdout/stderr, and
// resolve on close with the captured buffers + exit code + a timeout flag.
//
// Extracted from compile.ts. Used by the tsx compile orchestration
// (compileWorkflow) to run the user's rewritten workflow script under
// `node --import tsx` and capture its IR-JSON stdout / classified stderr.
// ═══════════════════════════════════════════════════════════════════════════

import { spawn } from "node:child_process";

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Spawn a node subprocess, accumulate stdout/stderr, and resolve on close with
 * the captured buffers + exit code + a timeout flag.
 *
 * A `timeoutMs` guard aborts the child via the spawn `signal` option (Node 22
 * kills the direct child on abort); the resulting close/error event is
 * resolved with `timedOut: true`.
 */
export function runSubprocess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    // `const`: the timer is set once and cleared from `finish`. `finish` is
    // only ever invoked from async callbacks that fire after this synchronous
    // body completes, so the const is always initialised before use.
    const timer = setTimeout(() => {
      ac.abort();
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: SubprocessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args, {
        // A compile subprocess must NOT outlive the host: keep it in the
        // parent's process group (no `detached: true`) so it is reaped with
        // the extension host; the AbortSignal below still enforces the timeout.
        stdio: ["pipe", "pipe", "pipe"],
        signal: ac.signal,
      });
    } catch (error) {
      finish({
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}spawn failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        exitCode: null,
        timedOut: false,
      });
      return;
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err: Error) => {
      // On abort the signal emits an AbortError here; otherwise it's a spawn
      // failure (e.g. ENOENT).
      finish({
        stdout,
        stderr: ac.signal.aborted ? stderr : `${stderr}${stderr ? "\n" : ""}${err.message}`,
        exitCode: null,
        timedOut: ac.signal.aborted,
      });
    });

    proc.on("close", (code: number | null) => {
      finish({ stdout, stderr, exitCode: code, timedOut: ac.signal.aborted });
    });
  });
}
