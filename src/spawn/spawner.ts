// ═══════════════════════════════════════════════════════════════════════════
// Generic agent-process spawner — runAgent (S10)
//
// Spawns a child process, pipes the prompt via stdin, line-buffers stdout,
// fires TUI update requests, captures stderr, and wires an AbortSignal to
// `killProcessTree`. This is adapter-agnostic: callers supply a `parseLine`
// function (typically the adapter's `parseEventStreamLine`) that turns each
// complete stdout line into a `NormalizedEvent`.
//
// Buffer/debounce/abort logic ported from
// `@harms-haus/pi-subagents/src/spawner.ts`.
//
// NOTE: The executor's `notify` is already debounced at 50ms, so runAgent
// passes `onUpdate` through WITHOUT a second debounce layer.
// ═══════════════════════════════════════════════════════════════════════════

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { NormalizedEvent } from "../types.js";
import { killProcessTree } from "./abort.js";

/**
 * Options for {@link runAgent}.
 */
export interface RunAgentOptions {
  /** Executable path or name. */
  command: string;
  /** CLI arguments. */
  args: string[];
  /** Environment variable overrides (merged into the parent process env). */
  env: Record<string, string>;
  /** Content piped to the subprocess on stdin. */
  stdinPrompt: string;
  /** Optional abort signal for cancellation. */
  signal?: AbortSignal;
  /**
   * Line-parsing function (typically the adapter's `parseEventStreamLine`).
   * Each complete stdout line is parsed; the result is forwarded to `onEvent`.
   */
  parseLine: (line: string) => NormalizedEvent | null;
  /** Callback for each parsed event (may be `null` for ignorable lines). */
  onEvent: (event: NormalizedEvent | null) => void;
  /**
   * Update callback (debounced internally at 50ms). Called to request a TUI
   * re-render.
   */
  onUpdate: () => void;
  /** Working directory for the spawned process. */
  cwd?: string;
}

/**
 * Result returned by {@link runAgent}.
 */
export interface RunAgentResult {
  /** Exit code (`null` means the process was killed by a signal). */
  exitCode: number | null;
  /** All stderr text accumulated during the process lifetime. */
  stderr: string;
}

/**
 * Spawn a child process, pipe the prompt via stdin, line-buffer stdout, and
 * call `onEvent` (per parsed line) / `onUpdate` (debounced at 50ms) as events
 * stream in.
 *
 * - Stdout is accumulated and split on `\n`; complete lines are parsed and
 *   forwarded immediately, while the incomplete trailing tail is held until the
 *   next newline (or flushed on process close).
 * - The prompt is written to stdin which is then ended (avoids ARG_MAX limits
 *   and the `-p` positional-swallowing trap).
 * - Stderr is accumulated verbatim and returned in the result.
 * - `onUpdate` is coalesced at 50ms; `onEvent` always fires immediately.
 * - If `signal` aborts, the process tree is killed via {@link killProcessTree}.
 * - A spawn `'error'` event (e.g. ENOENT) rejects the returned promise.
 */
export function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const { command, args, env, stdinPrompt, signal, parseLine, onEvent, onUpdate, cwd } = options;

  return new Promise<RunAgentResult>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      detached: true,
      shell: false,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutBuffer = "";
    let stderrText = "";
    let settled = false;

    const processLine = (line: string): void => {
      const event = parseLine(line);
      onEvent(event);
      onUpdate();
    };

    // Line-buffer stdout: decode each chunk (multibyte-safe), accumulate,
    // split on \n, and hold the incomplete trailing tail until the next
    // newline (or close flush). The decoder buffers incomplete trailing
    // UTF-8 bytes so multibyte characters split across chunks never produce
    // U+FFFD replacement characters.
    proc.stdout.on("data", (data: Buffer) => {
      stdoutBuffer += stdoutDecoder.write(data);
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    });

    // Capture stderr verbatim (multibyte-safe) for error reporting.
    proc.stderr.on("data", (data: Buffer) => {
      stderrText += stderrDecoder.write(data);
    });

    // Ignore stdin write errors (EPIPE / stream destroyed) — the process may
    // have exited before we finished writing; real failures surface via exit.
    // Captured as a named handler so it can be removed on every terminal path
    // (proc outlives the promise), preventing one leaked listener per run.
    const onStdinError = (): void => {
      /* no-op */
    };
    proc.stdin.on("error", onStdinError);

    // Abort handling: kill the process tree on cancellation. The listener is
    // captured so it can be removed on every terminal path (close / error) to
    // avoid leaking listeners on a long-lived AbortSignal.
    let removeAbortListener: (() => void) | undefined;
    if (signal) {
      const handleAbort = (): void => {
        void killProcessTree(proc);
      };
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener("abort", handleAbort, { once: true });
        removeAbortListener = (): void => {
          signal.removeEventListener("abort", handleAbort);
        };
      }
    }

    // Spawn error (e.g. ENOENT) — reject immediately.
    proc.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      proc.stdin.removeListener("error", onStdinError);
      removeAbortListener?.();
      reject(err);
    });

    proc.on("close", (code: number | null) => {
      if (settled) return;
      // Flush any remaining multibyte bytes held by the decoders, then process
      // the trailing buffered line (no trailing newline) before resolving.
      stdoutBuffer += stdoutDecoder.end();
      stderrText += stderrDecoder.end();
      if (stdoutBuffer.length > 0) {
        processLine(stdoutBuffer);
        stdoutBuffer = "";
      }
      settled = true;
      proc.stdin.removeListener("error", onStdinError);
      onUpdate();
      removeAbortListener?.();
      resolve({ exitCode: code, stderr: stderrText });
    });

    // Write the prompt via stdin (avoids ARG_MAX limits; required by `-p`).
    proc.stdin.write(stdinPrompt);
    proc.stdin.end();
  });
}
