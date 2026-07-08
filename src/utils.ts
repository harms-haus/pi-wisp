/**
 * pi-wisp shared utilities.
 */

// ─── compact ──────────────────────────────────────────────────────

/**
 * Return a shallow copy of `obj` with every `undefined`-valued entry
 * omitted. Lets callers assemble an optional-property object literal in one
 * place (`compact({ a, b, c })`) instead of one
 * `...(x !== undefined ? { x } : {})` spread per field. `null` and other
 * falsy-but-defined values are preserved; only `undefined` is stripped.
 */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T & string)[]) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

// ─── kebabCase ─────────────────────────────────────────────────────

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
interface Debounced<TArgs extends unknown[], TReturn> {
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
