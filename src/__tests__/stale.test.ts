import { describe, it, expect } from "vitest";

import { isStaleError, withStaleGuard } from "../stale.js";

// ─── isStaleError ─────────────────────────────────────────────────

describe("isStaleError", () => {
  it("returns true for an Error whose message includes 'stale'", () => {
    const err = new Error("stale context — session was replaced");
    expect(isStaleError(err)).toBe(true);
  });

  it("returns true when 'stale' appears at the start of the message", () => {
    const err = new Error("stale session detected");
    expect(isStaleError(err)).toBe(true);
  });

  it("returns true when 'stale' appears at the end of the message", () => {
    const err = new Error("async handler caught stale");
    expect(isStaleError(err)).toBe(true);
  });

  it("returns false for a plain Error without 'stale' in the message", () => {
    const err = new Error("something went wrong");
    expect(isStaleError(err)).toBe(false);
  });

  it("returns false for a TypeError (non-stale)", () => {
    const err = new TypeError("x is not a function");
    expect(isStaleError(err)).toBe(false);
  });

  it("returns false for a non-Error value (string)", () => {
    expect(isStaleError("stale")).toBe(false);
  });

  it("returns false for a non-Error value (null)", () => {
    expect(isStaleError(null)).toBe(false);
  });

  it("returns false for a non-Error value (undefined)", () => {
    expect(isStaleError(undefined)).toBe(false);
  });

  it("returns false for a plain object with message", () => {
    expect(isStaleError({ message: "stale context" })).toBe(false);
  });

  it("returns true for an Error subclass with 'stale' in message", () => {
    class CustomError extends Error {}
    const err = new CustomError("table is stale");
    expect(isStaleError(err)).toBe(true);
  });
});

// ─── withStaleGuard ───────────────────────────────────────────────

describe("withStaleGuard", () => {
  it("swallows a stale error (does not throw)", () => {
    const fn = () => {
      throw new Error("stale session");
    };

    // Must not throw
    expect(() => {
      withStaleGuard(fn);
    }).not.toThrow();
  });

  it("rethrows a non-stale error", () => {
    const fn = () => {
      throw new Error("real problem");
    };

    expect(() => {
      withStaleGuard(fn);
    }).toThrow("real problem");
  });

  it("rethrows a TypeError (non-stale)", () => {
    const fn = () => {
      throw new TypeError("x is not a function");
    };

    expect(() => {
      withStaleGuard(fn);
    }).toThrow(TypeError);
  });

  it("calls the wrapped function when no error occurs", () => {
    let called = false;
    const fn = () => {
      called = true;
    };

    withStaleGuard(fn);
    expect(called).toBe(true);
  });

  it("passes nothing through (the function is called for its side effects)", () => {
    // The guard receives a 0-arg function, but the function can capture scope.
    const captured: number[] = [];
    const fn = () => {
      captured.push(42);
    };

    withStaleGuard(fn);
    expect(captured).toEqual([42]);
  });

  it("rethrows stale-adjacent errors that don't contain the substring 'stale'", () => {
    const fn = () => {
      throw new Error("the data is outdated");
    };

    // "outdated" is not detected as stale by the simple substring check
    expect(() => {
      withStaleGuard(fn);
    }).toThrow("the data is outdated");
  });
});
