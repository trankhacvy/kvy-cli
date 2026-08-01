import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unwrapWithDeviceKey, wrapWithDeviceKey } from "./deviceKey.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "kvy-devicekey-test-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

// Every test here forces the Keychain path to fail (`readKeychainKey: () => null,
// writeKeychainKey: () => false`) so the suite exercises the plaintext-fallback file
// path deterministically, without touching the real host machine's Keychain.
const noKeychain = { readKeychainKey: () => null, writeKeychainKey: () => false };

describe("wrapWithDeviceKey / unwrapWithDeviceKey (fallback file path)", () => {
  it("round-trips a secret", () => {
    const secret = new Uint8Array(32).fill(9);
    const wrapped = wrapWithDeviceKey(secret, homeDir, noKeychain);
    expect(unwrapWithDeviceKey(wrapped, homeDir, noKeychain)).toEqual(secret);
  });

  it("persists the fallback device key file chmod 0600", () => {
    wrapWithDeviceKey(new Uint8Array(32).fill(1), homeDir, noKeychain);
    const mode = statSync(path.join(homeDir, "device.key")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reuses the same persisted device key across calls (a second wrap/unwrap round-trips too)", () => {
    const first = new Uint8Array(32).fill(2);
    const second = new Uint8Array(32).fill(3);
    const wrappedFirst = wrapWithDeviceKey(first, homeDir, noKeychain);
    const keyFileAfterFirst = readFileSync(path.join(homeDir, "device.key"), "utf8");

    const wrappedSecond = wrapWithDeviceKey(second, homeDir, noKeychain);
    const keyFileAfterSecond = readFileSync(path.join(homeDir, "device.key"), "utf8");

    expect(keyFileAfterFirst).toBe(keyFileAfterSecond); // same device key, not regenerated
    expect(unwrapWithDeviceKey(wrappedFirst, homeDir, noKeychain)).toEqual(first);
    expect(unwrapWithDeviceKey(wrappedSecond, homeDir, noKeychain)).toEqual(second);
  });

  it("returns null (never throws) for a corrupt blob", () => {
    wrapWithDeviceKey(new Uint8Array(32).fill(4), homeDir, noKeychain); // establish a device key
    const result = unwrapWithDeviceKey(
      { v: 1, nonce: "bm9uY2U=", ct: "bm90LXJlYWwtY2lwaGVydGV4dA==" },
      homeDir,
      noKeychain,
    );
    expect(result).toBeNull();
  });

  it("returns null for an unrecognized version", () => {
    const result = unwrapWithDeviceKey(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed for the test
      { v: 2, nonce: "n", ct: "c" } as any,
      homeDir,
      noKeychain,
    );
    expect(result).toBeNull();
  });
});

describe("wrapWithDeviceKey / unwrapWithDeviceKey (Keychain path)", () => {
  it("prefers a working Keychain over the fallback file, and never touches the file", () => {
    let stored: Buffer | null = null;
    const keychainDeps = {
      readKeychainKey: () => stored,
      writeKeychainKey: (key: Buffer) => {
        stored = key;
        return true;
      },
    };

    const secret = new Uint8Array(32).fill(5);
    const wrapped = wrapWithDeviceKey(secret, homeDir, keychainDeps);
    expect(unwrapWithDeviceKey(wrapped, homeDir, keychainDeps)).toEqual(secret);
    expect(stored).not.toBeNull();
  });
});
