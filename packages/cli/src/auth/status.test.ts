import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRandomBytes } from "@kvy/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCredentials } from "./credentials.js";
import { plaintextFallbackKeyMaterial } from "./keyMaterial.js";
import { runAuthStatus } from "./status.js";

let homeDir: string;

function joinedOutput(stdout: { mock: { calls: unknown[][] } }): string {
  return stdout.mock.calls.map((call) => call[0]).join("");
}

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "kvy-status-test-"));
  process.env.KVY_HOME_DIR = homeDir;
});

afterEach(() => {
  delete process.env.KVY_HOME_DIR;
  rmSync(homeDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runAuthStatus", () => {
  it("reports not logged in when there are no stored credentials", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = runAuthStatus();

    expect(code).toBe(0);
    expect(joinedOutput(stdout)).toContain("Not logged in.");
    expect(joinedOutput(stdout)).toContain("kvy auth login");
  });

  it("reports logged in, the credentials path, derived account key, key material mode, and a present refresh token", () => {
    const masterSecret = getRandomBytes(32);
    writeCredentials(
      { refreshToken: "r1", keyMaterial: plaintextFallbackKeyMaterial(masterSecret) },
      homeDir,
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = runAuthStatus();

    expect(code).toBe(0);
    const output = joinedOutput(stdout);
    expect(output).toContain("Logged in.");
    expect(output).toContain("Credentials file:");
    expect(output).toContain("Key material: unwrapped (plaintext-fallback)");
    expect(output).toContain("Account key:");
    expect(output).toContain("Refresh token: present");
  });

  it("skips the derived account key when the secret isn't 32 raw bytes", () => {
    writeCredentials(
      {
        refreshToken: "r1",
        keyMaterial: plaintextFallbackKeyMaterial(new Uint8Array([1, 2, 3])),
      },
      homeDir,
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    runAuthStatus();

    expect(joinedOutput(stdout)).not.toContain("Account key:");
  });

  it("skips the derived account key (without prompting) for PIN-protected key material", () => {
    writeCredentials(
      {
        refreshToken: "r1",
        keyMaterial: {
          mode: "pin",
          wrapped: { v: 1, kdf: "argon2id", salt: "c2FsdA==", nonce: "bm9uY2U=", ct: "Y3Q=" },
        },
      },
      homeDir,
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = runAuthStatus();

    expect(code).toBe(0);
    const output = joinedOutput(stdout);
    expect(output).toContain("Key material: PIN-protected");
    expect(output).not.toContain("Account key:");
  });
});
