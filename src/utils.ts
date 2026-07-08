/**
 * pi-wisp shared utilities.
 */

// ─── NotImplementedError ──────────────────────────────────────────────

/**
 * Error thrown by stub implementations that have not been implemented yet.
 * Used during the RED-phase of test-driven development.
 */
export class NotImplementedError extends Error {
  constructor(message?: string) {
    super(message ?? "Not implemented");
    this.name = "NotImplementedError";
  }
}

// ─── kebabCase ─────────────────────────────────────────────────────

/**
 * Convert a string to kebab-case.

/**
 * Convert a string to kebab-case.
 *
 * Handles camelCase / PascalCase word boundaries, collapses runs of
 * non-alphanumeric characters into a single hyphen, lowercases, and trims
 * leading/trailing hyphens.
 */
export function kebabCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

// ─── timecode ──────────────────────────────────────────────────────

/**
 * Produce a timecode string in `YYYYMMDD-HHMM` format (zero-padded) from a
 * Date. Defaults to the current date when no argument is given.
 */
export function timecode(d?: Date): string {
  const date = d ?? new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}${m}${day}-${h}${min}`;
}

// ─── debounce ──────────────────────────────────────────────────────

/** A debounced function with explicit call / flush / cancel controls. */
export interface Debounced<TArgs extends unknown[], TReturn> {
  /** Schedule (or reschedule) an invocation; the latest arguments win. */
  call(...args: TArgs): void;
  /** Trigger the pending invocation immediately (if any) and return its value. */
  flush(): TReturn | undefined;
  /** Cancel any pending invocation. */
  cancel(): void;
}

/**
 * Create a debounced function that coalesces multiple calls within `ms`
 * milliseconds into a single trailing invocation. The returned controller
 * exposes `call`, `flush`, and `cancel`.
 */
export function debounce<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
  ms: number,
): Debounced<TArgs, TReturn> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: TArgs | undefined;

  const invoke = (): TReturn | undefined => {
    timer = undefined;
    const args = lastArgs;
    lastArgs = undefined;
    if (args === undefined) {
      return undefined;
    }
    return fn(...args);
  };

  return {
    call(...args: TArgs): void {
      lastArgs = args;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(invoke, ms);
    },
    flush(): TReturn | undefined {
      if (timer === undefined) {
        return undefined;
      }
      return invoke();
    },
    cancel(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      lastArgs = undefined;
    },
  };
}

// ─── stripAnsi ─────────────────────────────────────────────────────

/**
 * Regex matching ANSI escape codes: CSI/SGR sequences, cursor movement, and
 * OSC sequences (terminated by BEL or ST). Ported from
 * `@harms-haus/pi-subagents` with OSC handling added.
 * Built via String.fromCharCode / new RegExp to avoid no-control-regex on
 * the regex literal.
 */
const esc = String.fromCharCode(27);
const csi = String.fromCharCode(155);
const bel = String.fromCharCode(7);

const ANSI_REGEX = new RegExp(
  "[" +
    esc +
    csi +
    "][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|" +
    esc +
    "][^" +
    bel +
    "]*(?:" +
    bel +
    "|" +
    esc +
    "\\\\" +
    ")",
  "g",
);

/**
 * Remove ANSI / OSC escape codes from text.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

// ─── mapWithConcurrencyLimit ───────────────────────────────────────

/**
 * Map an array with a concurrency limit using a work-stealing worker pool.
 * Processes items in parallel but never more than `concurrency` at a time,
 * and returns results in the original input order. Ported from
 * `@harms-haus/pi-subagents`.
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array<TOut>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: limit }, async () => {
    for (;;) {
      const current = nextIndex++;
      if (current >= items.length) {
        return;
      }
      // index verified in-bounds; ! satisfies noUncheckedIndexedAccess
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const item = items[current]!;
      results[current] = await fn(item, current);
    }
  });
  await Promise.all(workers);
  return results;
}
