import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeBase64, getRandomBytes } from "@falcon/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCredentials } from "./credentials.js";
import { runAuthStatus } from "./status.js";

let homeDir: string;

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  return `${b64url({ alg: "HS256" })}.${b64url(payload)}.fake-signature`;
}

function joinedOutput(stdout: { mock: { calls: unknown[][] } }): string {
  return stdout.mock.calls.map((call) => call[0]).join("");
}

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-status-test-"));
  process.env.FALCON_HOME_DIR = homeDir;
});

afterEach(() => {
  delete process.env.FALCON_HOME_DIR;
  rmSync(homeDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runAuthStatus", () => {
  it("reports not logged in when there are no stored credentials", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = runAuthStatus();

    expect(code).toBe(0);
    expect(joinedOutput(stdout)).toContain("Not logged in.");
    expect(joinedOutput(stdout)).toContain("falcon auth login");
  });

  it("reports logged in, the credentials path, derived account key, and unexpired token", () => {
    const masterSecret = getRandomBytes(32);
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const token = fakeJwt({ sub: "acct_123", exp: futureExp });
    writeCredentials({ token, masterSecretOrContentBundle: encodeBase64(masterSecret) }, homeDir);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = runAuthStatus();

    expect(code).toBe(0);
    const output = joinedOutput(stdout);
    expect(output).toContain("Logged in.");
    expect(output).toContain("Credentials file:");
    expect(output).toContain("Account key:");
    expect(output).toContain("expires");
    expect(output).not.toContain("expired");
  });

  it("labels a past-expiry token as expired", () => {
    const masterSecret = getRandomBytes(32);
    const pastExp = Math.floor(Date.now() / 1000) - 3600;
    const token = fakeJwt({ sub: "acct_123", exp: pastExp });
    writeCredentials({ token, masterSecretOrContentBundle: encodeBase64(masterSecret) }, homeDir);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    runAuthStatus();

    expect(joinedOutput(stdout)).toContain("Token (unverified): expired");
  });

  it("skips the derived account key when the secret isn't 32 raw bytes", () => {
    const token = fakeJwt({ sub: "acct_123", exp: Math.floor(Date.now() / 1000) + 3600 });
    writeCredentials(
      { token, masterSecretOrContentBundle: encodeBase64(new Uint8Array([1, 2, 3])) },
      homeDir,
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    runAuthStatus();

    expect(joinedOutput(stdout)).not.toContain("Account key:");
  });

  it("falls back to a generic 'present' message when the token can't be decoded", () => {
    const masterSecret = getRandomBytes(32);
    writeCredentials(
      { token: "not-a-jwt", masterSecretOrContentBundle: encodeBase64(masterSecret) },
      homeDir,
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    runAuthStatus();

    expect(joinedOutput(stdout)).toContain("Token: present (could not decode claims for display)");
  });
});
