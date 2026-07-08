import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { kebabCase, timecode, debounce, stripAnsi, mapWithConcurrencyLimit } from "../utils.js";

// ─── kebabCase ─────────────────────────────────────────────────────

describe("kebabCase", () => {
  it('converts "Fix Bugs!" to "fix-bugs"', () => {
    expect(kebabCase("Fix Bugs!")).toBe("fix-bugs");
  });

  it("converts camelCase to kebab-case", () => {
    expect(kebabCase("helloWorld")).toBe("hello-world");
  });

  it("converts PascalCase to kebab-case", () => {
    expect(kebabCase("HelloWorld")).toBe("hello-world");
  });

  it("converts UPPER_CASE with underscores", () => {
    expect(kebabCase("UPPER_CASE")).toBe("upper-case");
  });

  it("preserves already-kebab-case strings", () => {
    expect(kebabCase("already-kebab")).toBe("already-kebab");
  });

  it("trims whitespace and lowercases", () => {
    expect(kebabCase("   Trim   Me   ")).toBe("trim-me");
  });

  it("handles strings with numbers", () => {
    expect(kebabCase("Step 1 of 3")).toBe("step-1-of-3");
  });

  it("collapses multiple special characters", () => {
    expect(kebabCase("Hello & World!!!")).toBe("hello-world");
  });

  it("returns an empty string for empty input", () => {
    expect(kebabCase("")).toBe("");
  });

  it("handles mixed punctuation and case", () => {
    expect(kebabCase("_Hello_World_")).toBe("hello-world");
  });
});

// ─── timecode ──────────────────────────────────────────────────────

describe("timecode", () => {
  it("returns a string matching YYYYMMDD-HHMM format", () => {
    const result = timecode();
    expect(result).toMatch(/^\d{8}-\d{4}$/);
  });

  it("returns the correct format for a known date", () => {
    // 2025-06-15T14:30:00
    const d = new Date(2025, 5, 15, 14, 30, 0, 0);
    expect(timecode(d)).toBe("20250615-1430");
  });

  it("zero-pads month, day, hour, and minute", () => {
    // 2025-01-05T09:05:00
    const d = new Date(2025, 0, 5, 9, 5, 0, 0);
    expect(timecode(d)).toBe("20250105-0905");
  });

  it("defaults to the current date when no argument is given", () => {
    const now = new Date();
    const y = String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const h = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");
    const expected = `${y}${m}${d}-${h}${min}`;
    expect(timecode()).toBe(expected);
  });

  it("handles midnight and end-of-month boundaries", () => {
    // 2025-12-31T23:59:00
    const d = new Date(2025, 11, 31, 23, 59, 0, 0);
    expect(timecode(d)).toBe("20251231-2359");
  });
});

// ─── debounce ──────────────────────────────────────────────────────

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces multiple calls within the delay into a single invocation", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced.call("a");
    debounced.call("b");
    debounced.call("c");

    // fn should not have been called yet (within the delay)
    expect(fn).not.toHaveBeenCalled();

    // Advance time past the delay
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c"); // last args win
  });

  it("flush triggers the pending invocation immediately", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced.call("flush-me");

    // Before the delay, fn should not have been called
    expect(fn).not.toHaveBeenCalled();

    // flush triggers immediately
    const result = debounced.flush();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("flush-me");
    // flush returns the return value of the underlying fn
    expect(result).toBe(fn.mock.results[0]?.value);
  });

  it("cancel prevents the pending invocation", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced.call("will-be-cancelled");
    debounced.cancel();

    // Advance time past the delay
    vi.advanceTimersByTime(100);

    // fn should never have been called
    expect(fn).not.toHaveBeenCalled();
  });

  it("flush on an already-executed invocation does nothing", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced.call("first");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);

    // flush after the timer has already fired
    const result = debounced.flush();
    expect(fn).toHaveBeenCalledTimes(1); // no additional call
    expect(result).toBeUndefined();
  });

  it("cancel on an already-executed invocation does nothing", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced.call("first");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);

    // cancel after the timer fired
    debounced.cancel();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("multiple flush calls in a row invoke once per flush cycle", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced.call("a");
    debounced.flush();
    expect(fn).toHaveBeenCalledTimes(1);

    // Second flush with no pending call should not re-invoke
    debounced.flush();
    expect(fn).toHaveBeenCalledTimes(1);

    // A new call + flush should invoke again
    debounced.call("b");
    debounced.flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("b");
  });
});

// ─── stripAnsi ─────────────────────────────────────────────────────

describe("stripAnsi", () => {
  it("removes ANSI escape codes from a string", () => {
    const colored = "\u001b[31mHello\u001b[0m";
    expect(stripAnsi(colored)).toBe("Hello");
  });

  it("removes multiple ANSI sequences", () => {
    const colored = "\u001b[1m\u001b[32mBold Green\u001b[0m";
    expect(stripAnsi(colored)).toBe("Bold Green");
  });

  it("leaves plain text unchanged", () => {
    const plain = "Hello, world!";
    expect(stripAnsi(plain)).toBe("Hello, world!");
  });

  it("removes ANSI codes with complex sequences (SGR params)", () => {
    const complex = "\u001b[38;2;255;100;0morange\u001b[0m";
    expect(stripAnsi(complex)).toBe("orange");
  });

  it("removes cursor movement ANSI codes", () => {
    const withCursor = "\u001b[2J\u001b[HHello";
    expect(stripAnsi(withCursor)).toBe("Hello");
  });

  it("handles empty strings", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("handles strings with no ANSI codes", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  it("handles OSC sequences (e.g., title bar set)", () => {
    const osc = "\u001b]0;My Title\u0007Hello";
    expect(stripAnsi(osc)).toBe("Hello");
  });
});

// ─── mapWithConcurrencyLimit ───────────────────────────────────────

describe("mapWithConcurrencyLimit", () => {
  it("respects the concurrency limit (never more than limit in-flight)", async () => {
    const concurrency = 3;
    let maxInFlight = 0;
    let currentInFlight = 0;

    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    const worker = async (item: number, _index: number): Promise<number> => {
      currentInFlight++;
      maxInFlight = Math.max(maxInFlight, currentInFlight);

      // Simulate async work with a microtask yield
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      currentInFlight--;
      return item * 2;
    };

    const result = await mapWithConcurrencyLimit(items, concurrency, worker);

    // The concurrency limit must never be exceeded
    expect(maxInFlight).toBeLessThanOrEqual(concurrency);
    // All items must be processed
    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  });

  it("processes all items (work-stealing)", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const concurrency = 2;

    const worker = async (item: string, index: number): Promise<string> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return `${item}-${index}`;
    };

    const result = await mapWithConcurrencyLimit(items, concurrency, worker);

    expect(result).toEqual(["a-0", "b-1", "c-2", "d-3", "e-4"]);
  });

  it("handles concurrency larger than item count gracefully", async () => {
    const items = [1, 2, 3];
    const concurrency = 100;
    let maxInFlight = 0;
    let currentInFlight = 0;

    const worker = async (item: number): Promise<number> => {
      currentInFlight++;
      maxInFlight = Math.max(maxInFlight, currentInFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      currentInFlight--;
      return item;
    };

    const result = await mapWithConcurrencyLimit(items, concurrency, worker);

    // With 3 items and concurrency=100, all 3 should start at once
    expect(maxInFlight).toBe(3);
    expect(result).toEqual([1, 2, 3]);
  });

  it("handles concurrency of 1 (sequential)", async () => {
    const items = [1, 2, 3];
    const concurrency = 1;
    const executionOrder: number[] = [];

    const worker = async (item: number): Promise<number> => {
      executionOrder.push(item);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return item;
    };

    const result = await mapWithConcurrencyLimit(items, concurrency, worker);

    expect(executionOrder).toEqual([1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
  });

  it("returns results in the original order", async () => {
    // Each item resolves after a different delay to verify ordering
    const items = [300, 100, 200]; // delays in ms
    const concurrency = 3;

    const worker = async (delay: number, index: number): Promise<number> => {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      return index;
    };

    const result = await mapWithConcurrencyLimit(items, concurrency, worker);

    // Results must be in input order regardless of resolve order
    expect(result).toEqual([0, 1, 2]);
  });

  it("returns an empty array when items is empty", async () => {
    const worker = async (item: number): Promise<number> => item;

    const result = await mapWithConcurrencyLimit([], 3, worker);

    expect(result).toEqual([]);
  });

  it("handles a single item correctly", async () => {
    const items = [42];
    const concurrency = 5;
    let inFlight = 0;
    let maxInFlight = 0;

    const worker = async (item: number): Promise<number> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return item;
    };

    const result = await mapWithConcurrencyLimit(items, concurrency, worker);

    expect(result).toEqual([42]);
    expect(maxInFlight).toBe(1);
  });
});
