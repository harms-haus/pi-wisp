import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  computeSignature,
  getOrCreateSigningKey,
  signBytes,
  signingKeyFile,
  verifyBytes,
  verifySignature,
} from "../../run/integrity.js";

describe("graph integrity", () => {
  describe("computeSignature / verifySignature (pure, known key)", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef", "utf-8");

    it("verifies a signature it produced", () => {
      const sig = computeSignature("hello", key);
      expect(verifySignature("hello", sig, key)).toBe(true);
    });

    it("rejects tampered bytes", () => {
      const sig = computeSignature("hello", key);
      expect(verifySignature("hellp", sig, key)).toBe(false);
    });

    it("rejects a wrong signature", () => {
      expect(verifySignature("hello", "deadbeef".repeat(8), key)).toBe(false);
    });

    it("rejects a malformed (short) signature without throwing", () => {
      expect(verifySignature("hello", "short", key)).toBe(false);
    });

    it("produces different signatures for different keys", () => {
      const otherKey = Buffer.from("fedcba9876543210fedcba9876543210", "utf-8");
      expect(computeSignature("hello", key)).not.toBe(computeSignature("hello", otherKey));
    });
  });

  describe("getOrCreateSigningKey (file-backed)", () => {
    const prev = process.env.WISP_SIGNING_KEY_FILE;
    let keyFile: string;

    beforeEach(() => {
      keyFile = join(mkdtempSync(join(tmpdir(), "wisp-key-")), "wisp.key");
      process.env.WISP_SIGNING_KEY_FILE = keyFile;
    });
    afterEach(() => {
      process.env.WISP_SIGNING_KEY_FILE = prev;
      rmSync(keyFile, { recursive: true, force: true });
    });

    it("creates a 32-byte key on first use and persists it as base64", () => {
      expect(existsSync(keyFile)).toBe(false);
      const created = getOrCreateSigningKey();
      expect(created.length).toBe(32);
      expect(existsSync(keyFile)).toBe(true);
      const persisted = Buffer.from(readFileSync(keyFile, "utf-8").trim(), "base64");
      expect(persisted).toEqual(created);
    });

    it("is idempotent: reuses the existing key on subsequent calls", () => {
      const first = getOrCreateSigningKey();
      const second = getOrCreateSigningKey();
      expect(second).toEqual(first);
    });

    it("signBytes / verifyBytes round-trip via the file-backed key", () => {
      const sig = signBytes("graph-bytes");
      expect(verifyBytes("graph-bytes", sig)).toBe(true);
      expect(verifyBytes("tampered", sig)).toBe(false);
    });
  });

  describe("signingKeyFile", () => {
    const prev = process.env.WISP_SIGNING_KEY_FILE;

    afterEach(() => {
      process.env.WISP_SIGNING_KEY_FILE = prev;
    });

    it("honors the WISP_SIGNING_KEY_FILE override", () => {
      process.env.WISP_SIGNING_KEY_FILE = "/tmp/custom-wisp-key";
      expect(signingKeyFile()).toBe("/tmp/custom-wisp-key");
    });
  });
});
