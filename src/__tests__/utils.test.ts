import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { kebabCase, timecode, debounce } from "../utils.js";

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
