// ═══════════════════════════════════════════════════════════════════════════
// IR validation — validateIR() structured error contract.
//
// Tests that validateIR returns structured WispError[] for each invariant
// violation. Each error must have { kind: "validation", nodeId?, message,
// location? }. Empty array = valid.
//
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

import { validateIR } from "../../dsl/ir.js";
import type { GraphIR, IRNode } from "../../types.js";

// ─── Helpers ──────────────────────────────────────────────────────

/** Creates a minimal valid GraphIR for use as a base in mutation tests. */
function makeEmptyIR(overrides?: Partial<GraphIR>): GraphIR {
  return {
    title: "test",
    slug: "test",
    options: {},
    nodes: [],
    edges: [],
    conditions: [],
    schemas: {},
    primitives: {},
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("validateIR — cycle detection", () => {
  it("detects a simple 2-node cycle (a → b → a)", () => {
    const ir = makeEmptyIR({
      nodes: [
        { id: "a", kind: "node", prompt: "A", dependsOn: ["b"] },
        { id: "b", kind: "node", prompt: "B", dependsOn: ["a"] },
      ],
      edges: [
        { from: "a", to: "b", kind: "dep" },
        { from: "b", to: "a", kind: "dep" },
      ],
    });
    const errors = validateIR(ir);
    // Expect at least one cycle error
    expect(errors.length).toBeGreaterThan(0);
    const cycleError = errors.find((e) => e.message && /cycle|circular/i.test(e.message));
    expect(cycleError).toBeDefined();
    // Must include the reconstructed path (node ids in order)
    expect(cycleError!.message).toMatch(/a.*b|b.*a/);
    expect(cycleError!.kind).toBe("validation");
  });

  it("detects a 3-node cycle (a → b → c → a)", () => {
    const ir = makeEmptyIR({
      nodes: [
        { id: "a", kind: "node", prompt: "A", dependsOn: ["c"] },
        { id: "b", kind: "node", prompt: "B", dependsOn: ["a"] },
        { id: "c", kind: "node", prompt: "C", dependsOn: ["b"] },
      ],
      edges: [
        { from: "a", to: "b", kind: "dep" },
        { from: "b", to: "c", kind: "dep" },
        { from: "c", to: "a", kind: "dep" },
      ],
    });
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    const cycleError = errors.find((e) => e.message && /cycle|circular/i.test(e.message));
    expect(cycleError).toBeDefined();
    expect(cycleError!.message).toMatch(/a.*b.*c|b.*c.*a|c.*a.*b/);
  });

  it("returns empty errors for a DAG with no cycles", () => {
    const ir = makeEmptyIR({
      nodes: [
        { id: "a", kind: "node", prompt: "A" },
        { id: "b", kind: "node", prompt: "B", dependsOn: ["a"] },
        { id: "c", kind: "node", prompt: "C", dependsOn: ["b"] },
      ],
      edges: [
        { from: "a", to: "b", kind: "dep" },
        { from: "b", to: "c", kind: "dep" },
      ],
    });
    const errors = validateIR(ir);
    expect(errors).toEqual([]);
  });

  it("detects a self-loop (node depends on itself)", () => {
    const ir = makeEmptyIR({
      nodes: [{ id: "a", kind: "node", prompt: "A", dependsOn: ["a"] }],
      edges: [{ from: "a", to: "a", kind: "dep" }],
    });
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    const cycleError = errors.find((e) => e.message && /cycle|circular|self/i.test(e.message));
    expect(cycleError).toBeDefined();
  });
});

describe("validateIR — duplicate node ids", () => {
  it("detects two nodes with the same id", () => {
    const ir = makeEmptyIR({
      nodes: [
        { id: "a", kind: "node", prompt: "A first" },
        { id: "a", kind: "node", prompt: "A second" },
      ],
    });
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    const dupError = errors.find((e) => e.message && /duplicate/i.test(e.message));
    expect(dupError).toBeDefined();
    expect(dupError!.kind).toBe("validation");
    expect(dupError!.nodeId).toBe("a");
  });
});

describe("validateIR — dangling references", () => {
  it("detects a dependsOn reference to a non-existent node", () => {
    const ir = makeEmptyIR({
      nodes: [{ id: "a", kind: "node", prompt: "A", dependsOn: ["phantom"] }],
      edges: [{ from: "phantom", to: "a", kind: "dep" }],
    });
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    const depError = errors.find(
      (e) => e.message && /dependsOn|phantom|not found/i.test(e.message),
    );
    expect(depError).toBeDefined();
    expect(depError!.kind).toBe("validation");
    expect(depError!.nodeId).toBe("a");
  });

  it("detects a fanOut 'from' reference to a non-existent node", () => {
    const ir = makeEmptyIR({
      nodes: [
        {
          id: "f",
          kind: "fanOut",
          from: "ghost",
          iterateFnRef: { __fn: true, src: "() => []", kind: "iterate" },
          eachFnRef: { __fn: true, src: "() => ({})", kind: "each" },
        },
      ],
      edges: [{ from: "ghost", to: "f", kind: "fanOut" }],
    });
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    const fromError = errors.find((e) => e.message && /from|ghost|not found/i.test(e.message));
    expect(fromError).toBeDefined();
    expect(fromError!.nodeId).toBe("f");
  });

  it("detects a cond 'on' reference to a non-existent node", () => {
    const ir = makeEmptyIR({
      nodes: [
        {
          id: "c",
          kind: "cond",
          on: "nobody",
          whenFnRef: { __fn: true, src: "() => true", kind: "cond" },
          then: "a",
        },
        { id: "a", kind: "node", prompt: "A" },
      ],
      edges: [{ from: "c", to: "a", kind: "cond:branch" }],
    });
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    const onError = errors.find((e) => e.message && /on|nobody|not found/i.test(e.message));
    expect(onError).toBeDefined();
    expect(onError!.nodeId).toBe("c");
  });
});

describe("validateIR — malformed outputSchema", () => {
  it("flags an outputSchema that is not a valid JSON Schema object", () => {
    const ir = makeEmptyIR({
      nodes: [{ id: "a", kind: "node", prompt: "A", outputSchema: 42 } as unknown as IRNode],
    });
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    const schemaError = errors.find((e) => e.message && /schema|outputSchema/i.test(e.message));
    expect(schemaError).toBeDefined();
    expect(schemaError!.nodeId).toBe("a");
  });

  it("accepts a valid outputSchema (Type.Object or plain object)", () => {
    const ir = makeEmptyIR({
      nodes: [
        {
          id: "a",
          kind: "node",
          prompt: "A",
          outputSchema: { type: "object", properties: { title: { type: "string" } } },
        },
      ],
    });
    const errors = validateIR(ir);
    const schemaError = errors.find((e) => e.message && /schema|outputSchema/i.test(e.message));
    expect(schemaError).toBeUndefined();
  });
});

describe("validateIR — concurrency-pool sanity", () => {
  it("flags a concurrency limit less than 1", () => {
    const ir = makeEmptyIR({ options: { maxConcurrency: 0 } });
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    const poolError = errors.find((e) => e.message && /concurrency|pool|limit/i.test(e.message));
    expect(poolError).toBeDefined();
  });

  it("accepts valid concurrency limits", () => {
    const ir = makeEmptyIR({ options: { maxConcurrency: 5 } });
    const errors = validateIR(ir);
    const poolError = errors.find((e) => e.message && /concurrency|pool|limit/i.test(e.message));
    expect(poolError).toBeUndefined();
  });
});

describe("validateIR — mutual exclusivity", () => {
  it("flags a node with both prompt and promptFnRef set", () => {
    const ir = makeEmptyIR({
      nodes: [
        {
          id: "a",
          kind: "node",
          prompt: "Static prompt",
          promptFnRef: { __fn: true, src: "() => 'dynamic'", kind: "prompt" },
        },
      ],
    });
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    const mutualError = errors.find(
      (e) => e.message && /mutual|exclusive|both.*prompt|prompt.*both/i.test(e.message),
    );
    expect(mutualError).toBeDefined();
    expect(mutualError!.nodeId).toBe("a");
  });

  it("allows a node with only promptFnRef (no static prompt)", () => {
    const ir = makeEmptyIR({
      nodes: [
        {
          id: "a",
          kind: "node",
          promptFnRef: { __fn: true, src: "() => 'dynamic'", kind: "prompt" },
        },
      ],
    });
    const errors = validateIR(ir);
    const mutualError = errors.find((e) => e.message && /mutual|exclusive/i.test(e.message));
    expect(mutualError).toBeUndefined();
  });
});

describe("validateIR — path traversal", () => {
  it("flags a node whose cwd escapes the project root", () => {
    const ir = makeEmptyIR({
      nodes: [{ id: "a", kind: "node", prompt: "A", cwd: "/etc/malicious" }],
    });
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    const traversalError = errors.find(
      (e) => e.message && /cwd|path|traversal|escape|outside/i.test(e.message),
    );
    expect(traversalError).toBeDefined();
    expect(traversalError!.nodeId).toBe("a");
  });

  it("allows a cwd that is within the project root", () => {
    const ir = makeEmptyIR({
      nodes: [
        {
          id: "a",
          kind: "node",
          prompt: "A",
          cwd: "/home/user/project/subdir",
        },
      ],
    });
    const errors = validateIR(ir);
    const traversalError = errors.find(
      (e) => e.message && /cwd|path|traversal|escape|outside/i.test(e.message),
    );
    expect(traversalError).toBeUndefined();
  });
});

describe("validateIR — edge reference consistency", () => {
  it("flags an edge whose 'from' node does not exist", () => {
    const ir = makeEmptyIR({
      nodes: [{ id: "b", kind: "node", prompt: "B" }],
      edges: [{ from: "ghost", to: "b", kind: "dep" }],
    });
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    const edgeError = errors.find((e) => e.message && /edge|from|ghost|not found/i.test(e.message));
    expect(edgeError).toBeDefined();
  });

  it("flags an edge whose 'to' node does not exist", () => {
    const ir = makeEmptyIR({
      nodes: [{ id: "a", kind: "node", prompt: "A" }],
      edges: [{ from: "a", to: "phantom", kind: "dep" }],
    });
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    const edgeError = errors.find((e) => e.message && /edge|to|phantom|not found/i.test(e.message));
    expect(edgeError).toBeDefined();
  });
});

describe("validateIR — clean IR returns empty array", () => {
  it("returns [] for a well-formed IR with one node", () => {
    const ir = makeEmptyIR({
      nodes: [{ id: "a", kind: "node", prompt: "Do something", profileRef: "default" }],
    });
    const errors = validateIR(ir);
    expect(errors).toEqual([]);
  });

  it("returns [] for a diamond DAG (a → {b, c} → d)", () => {
    const ir = makeEmptyIR({
      nodes: [
        { id: "a", kind: "node", prompt: "Start" },
        { id: "b", kind: "node", prompt: "Branch 1", dependsOn: ["a"] },
        { id: "c", kind: "node", prompt: "Branch 2", dependsOn: ["a"] },
        { id: "d", kind: "node", prompt: "Merge", dependsOn: ["b", "c"] },
      ],
      edges: [
        { from: "a", to: "b", kind: "dep" },
        { from: "a", to: "c", kind: "dep" },
        { from: "b", to: "d", kind: "dep" },
        { from: "c", to: "d", kind: "dep" },
      ],
    });
    const errors = validateIR(ir);
    expect(errors).toEqual([]);
  });

  it("returns [] for a valid IR with fanOut, cond, loop, and reduce", () => {
    const ir = makeEmptyIR({
      nodes: [
        { id: "producer", kind: "node", prompt: "Produce items" },
        {
          id: "f",
          kind: "fanOut",
          from: "producer",
          iterateFnRef: { __fn: true, src: "() => []", kind: "iterate" },
          eachFnRef: { __fn: true, src: "() => ({})", kind: "each" },
          dependsOn: ["producer"],
        },
        { id: "review", kind: "node", prompt: "Review", dependsOn: ["f"] },
        {
          id: "c",
          kind: "cond",
          on: "review",
          whenFnRef: { __fn: true, src: "() => true", kind: "cond" },
          then: "done",
        },
        { id: "done", kind: "node", prompt: "Done", dependsOn: ["c"] },
        {
          id: "l",
          kind: "loop",
          body: "review",
          untilFnRef: { __fn: true, src: "() => true", kind: "until" },
          maxIterations: 3,
        },
        {
          id: "r",
          kind: "reduce",
          from: ["done"],
          mergeFnRef: { __fn: true, src: "() => ({})", kind: "merge" },
        },
      ],
      edges: [
        { from: "producer", to: "f", kind: "dep" },
        { from: "f", to: "review", kind: "dep" },
        { from: "review", to: "c", kind: "dep" },
        { from: "c", to: "done", kind: "cond:branch" },
        { from: "done", to: "r", kind: "dep" },
      ],
    });
    const errors = validateIR(ir);
    expect(errors).toEqual([]);
  });
});

describe("validateIR — error shape contract", () => {
  it("each error has kind 'validation', a message, and optional nodeId/location", () => {
    const ir = makeEmptyIR({
      nodes: [{ id: "a", kind: "node", prompt: "A", dependsOn: ["phantom"] }],
      edges: [{ from: "phantom", to: "a", kind: "dep" }],
    });
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    for (const err of errors) {
      expect(err.kind).toBe("validation");
      expect(typeof err.message).toBe("string");
      expect(err.message.length).toBeGreaterThan(0);
      if (err.nodeId !== undefined) {
        expect(typeof err.nodeId).toBe("string");
      }
      if (err.location !== undefined) {
        expect(typeof err.location).toBe("string");
      }
    }
  });
});
