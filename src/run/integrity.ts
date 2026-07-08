/**
 * Integrity protection for the persisted graph IR.
 *
 * `artifacts/graph.json` is a distinct trust boundary: it is written by the
 * engine during a run and read back on resume, and its `FnDescriptor.src`
 * strings are rehydrated via `new Function` (i.e. executed on the host). To
 * stop a compromised run directory from smuggling arbitrary code through a
 * tampered graph, {@link writeGraph} signs the graph bytes with an HMAC key
 * that lives OUTSIDE the run directory (the agent config dir), and
 * `prepareResume` verifies that signature before trusting the IR.
 *
 * This is defense-in-depth, not isolation: it does not sandbox rehydrated code
 * (the `new Function` context is escapable), but it binds a resumed IR to a key
 * the run directory itself cannot forge. The threat model still assumes the
 * orchestrating agent authored the DSL; this guard closes the on-disk resume
 * input path against a compromised run-state file.
 *
 * @module
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "../constants.js";

/**
 * Resolve the signing-key file path. Defaults to `<agentDir>/wisp.key` (outside
 * any run directory). `WISP_SIGNING_KEY_FILE` overrides it (used by tests and
 * operators to pin a key independent of the agent dir).
 */
export function signingKeyFile(): string {
  const override = process.env.WISP_SIGNING_KEY_FILE;
  if (override && override.length > 0) return override;
  return join(getAgentDir(), "wisp.key");
}

/** HMAC-SHA256 hex digest of `bytes` under `key` (pure). */
export function computeSignature(bytes: string | Buffer, key: Buffer): string {
  return createHmac("sha256", key).update(bytes).digest("hex");
}

/**
 * Verify a hex `signature` over `bytes` under `key` in constant time (pure).
 * Returns `false` for a malformed/short signature rather than throwing.
 */
export function verifySignature(bytes: string | Buffer, signature: string, key: Buffer): boolean {
  const expected = computeSignature(bytes, key);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Read and base64-decode the key at `keyPath`, or `undefined` if absent/empty. */
function readKey(keyPath: string): Buffer | undefined {
  try {
    const text = readFileSync(keyPath, "utf-8").trim();
    if (text.length === 0) return undefined;
    return Buffer.from(text, "base64");
  } catch {
    return undefined;
  }
}

/**
 * Load the persisted signing key, creating a fresh 32-byte key on first use.
 *
 * The key is stored base64-encoded with mode `0o600` at {@link signingKeyFile}.
 * Creation is exclusive (`flag: "wx"`): if another process created the key
 * between our read and write, we read and return theirs instead, so the first
 * key to exist wins and previously-signed runs keep verifying.
 */
export function getOrCreateSigningKey(): Buffer {
  const keyPath = signingKeyFile();
  const existing = readKey(keyPath);
  if (existing !== undefined) return existing;

  const key = randomBytes(32);
  mkdirSync(dirname(keyPath), { recursive: true });
  try {
    writeFileSync(keyPath, key.toString("base64"), { mode: 0o600, flag: "wx" });
    return key;
  } catch {
    // Another process won the create race; use its key.
    const raced = readKey(keyPath);
    if (raced !== undefined) return raced;
    throw new Error(`prepareResume: failed to create signing key at "${keyPath}".`);
  }
}

/** Sign `bytes` with the environment signing key (creating it on first use). */
export function signBytes(bytes: string | Buffer): string {
  return computeSignature(bytes, getOrCreateSigningKey());
}

/** Verify `signature` over `bytes` with the environment signing key. */
export function verifyBytes(bytes: string | Buffer, signature: string): boolean {
  return verifySignature(bytes, signature, getOrCreateSigningKey());
}

/** Whether a signing key already exists at {@link signingKeyFile} (no create). */
export function hasSigningKey(): boolean {
  return existsSync(signingKeyFile());
}
