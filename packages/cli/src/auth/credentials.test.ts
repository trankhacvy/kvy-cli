import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCredentials,
  credentialsPath,
  readCredentials,
  writeCredentials,
} from "./credentials.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-credentials-test-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("readCredentials", () => {
  it("returns null when no credentials file exists", () => {
    expect(readCredentials(homeDir)).toBeNull();
  });

  it("returns null for a malformed credentials file", () => {
    writeCredentials({ refreshToken: "t", masterSecretOrContentBundle: "s" }, homeDir);
    // Overwrite with garbage after a valid write ensures the directory already exists.
    const file = credentialsPath(homeDir);
    writeFileSync(file, "not json");
    expect(readCredentials(homeDir)).toBeNull();
  });
});

describe("writeCredentials / readCredentials round-trip", () => {
  it("persists and reads back the same credentials", () => {
    writeCredentials(
      { refreshToken: "abc.def.ghi", masterSecretOrContentBundle: "c2VjcmV0" },
      homeDir,
    );
    expect(readCredentials(homeDir)).toEqual({
      refreshToken: "abc.def.ghi",
      masterSecretOrContentBundle: "c2VjcmV0",
    });
  });

  it("creates the home directory if missing", () => {
    const nested = path.join(homeDir, "nested", "falcon-home");
    writeCredentials({ refreshToken: "t", masterSecretOrContentBundle: "s" }, nested);
    expect(existsSync(credentialsPath(nested))).toBe(true);
  });

  it("writes the file chmod 0600", () => {
    writeCredentials({ refreshToken: "t", masterSecretOrContentBundle: "s" }, homeDir);
    const mode = statSync(credentialsPath(homeDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("re-chmods to 0600 even if the file previously had looser permissions", () => {
    writeCredentials({ refreshToken: "t", masterSecretOrContentBundle: "s" }, homeDir);
    chmodSync(credentialsPath(homeDir), 0o644);
    writeCredentials({ refreshToken: "t2", masterSecretOrContentBundle: "s2" }, homeDir);
    const mode = statSync(credentialsPath(homeDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("clearCredentials", () => {
  it("removes an existing credentials file", () => {
    writeCredentials({ refreshToken: "t", masterSecretOrContentBundle: "s" }, homeDir);
    clearCredentials(homeDir);
    expect(existsSync(credentialsPath(homeDir))).toBe(false);
  });

  it("is a no-op when there is nothing to clear", () => {
    expect(() => clearCredentials(homeDir)).not.toThrow();
  });
});
