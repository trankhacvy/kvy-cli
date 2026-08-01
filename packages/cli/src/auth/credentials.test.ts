import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCredentials,
  credentialsPath,
  type KvyCredentials,
  readCredentials,
  writeCredentials,
} from "./credentials.js";

let homeDir: string;

const plaintext: KvyCredentials = {
  refreshToken: "t",
  keyMaterial: { mode: "plaintext-fallback", bundle: "s" },
};

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "kvy-credentials-test-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("readCredentials", () => {
  it("returns null when no credentials file exists", () => {
    expect(readCredentials(homeDir)).toBeNull();
  });

  it("returns null for a malformed credentials file", () => {
    writeCredentials(plaintext, homeDir);
    // Overwrite with garbage after a valid write ensures the directory already exists.
    const file = credentialsPath(homeDir);
    writeFileSync(file, "not json");
    expect(readCredentials(homeDir)).toBeNull();
  });

  it("returns null for a legacy (pre-§6.1) flat masterSecretOrContentBundle shape", () => {
    const file = credentialsPath(homeDir);
    writeFileSync(file, JSON.stringify({ refreshToken: "t", masterSecretOrContentBundle: "s" }));
    expect(readCredentials(homeDir)).toBeNull();
  });
});

describe("writeCredentials / readCredentials round-trip", () => {
  it("persists and reads back plaintext-fallback key material", () => {
    writeCredentials(
      {
        refreshToken: "abc.def.ghi",
        keyMaterial: { mode: "plaintext-fallback", bundle: "c2VjcmV0" },
      },
      homeDir,
    );
    expect(readCredentials(homeDir)).toEqual({
      refreshToken: "abc.def.ghi",
      keyMaterial: { mode: "plaintext-fallback", bundle: "c2VjcmV0" },
    });
  });

  it("persists and reads back device-wrapped key material", () => {
    const credentials: KvyCredentials = {
      refreshToken: "r",
      keyMaterial: { mode: "device", wrapped: { v: 1, nonce: "bm9uY2U=", ct: "Y3Q=" } },
    };
    writeCredentials(credentials, homeDir);
    expect(readCredentials(homeDir)).toEqual(credentials);
  });

  it("persists and reads back PIN-wrapped key material", () => {
    const credentials: KvyCredentials = {
      refreshToken: "r",
      keyMaterial: {
        mode: "pin",
        wrapped: { v: 1, kdf: "argon2id", salt: "c2FsdA==", nonce: "bm9uY2U=", ct: "Y3Q=" },
      },
    };
    writeCredentials(credentials, homeDir);
    expect(readCredentials(homeDir)).toEqual(credentials);
  });

  it("creates the home directory if missing", () => {
    const nested = path.join(homeDir, "nested", "kvy-home");
    writeCredentials(plaintext, nested);
    expect(existsSync(credentialsPath(nested))).toBe(true);
  });

  it("writes the file chmod 0600", () => {
    writeCredentials(plaintext, homeDir);
    const mode = statSync(credentialsPath(homeDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("re-chmods to 0600 even if the file previously had looser permissions", () => {
    writeCredentials(plaintext, homeDir);
    chmodSync(credentialsPath(homeDir), 0o644);
    writeCredentials(plaintext, homeDir);
    const mode = statSync(credentialsPath(homeDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("clearCredentials", () => {
  it("removes an existing credentials file", () => {
    writeCredentials(plaintext, homeDir);
    clearCredentials(homeDir);
    expect(existsSync(credentialsPath(homeDir))).toBe(false);
  });

  it("is a no-op when there is nothing to clear", () => {
    expect(() => clearCredentials(homeDir)).not.toThrow();
  });
});
