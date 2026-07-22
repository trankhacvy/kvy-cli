import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearGithubToken,
  githubTokenPath,
  readGithubToken,
  writeGithubToken,
} from "./githubAuth.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-github-auth-test-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("readGithubToken", () => {
  it("returns null when no github.key file exists", () => {
    expect(readGithubToken(homeDir)).toBeNull();
  });

  it("returns null for a corrupt github.key file", () => {
    writeGithubToken({ token: "gho_abc", createdAt: 1, method: "pat" }, homeDir);
    writeFileSync(githubTokenPath(homeDir), "not json");
    expect(readGithubToken(homeDir)).toBeNull();
  });

  it("returns null when the file is valid JSON but fails schema validation", () => {
    writeFileSync(githubTokenPath(homeDir), JSON.stringify({ token: "", createdAt: 1 }));
    expect(readGithubToken(homeDir)).toBeNull();
  });
});

describe("writeGithubToken / readGithubToken round-trip", () => {
  it("persists and reads back a PAT token", () => {
    writeGithubToken({ token: "gho_abc123", createdAt: 1000, method: "pat" }, homeDir);
    expect(readGithubToken(homeDir)).toEqual({
      token: "gho_abc123",
      createdAt: 1000,
      method: "pat",
    });
  });

  it("persists and reads back a device-flow token with a scope", () => {
    writeGithubToken(
      { token: "gho_device", createdAt: 2000, scope: "repo", method: "device-flow" },
      homeDir,
    );
    expect(readGithubToken(homeDir)).toEqual({
      token: "gho_device",
      createdAt: 2000,
      scope: "repo",
      method: "device-flow",
    });
  });

  it("creates the home directory if missing", () => {
    const nested = path.join(homeDir, "nested", "falcon-home");
    writeGithubToken({ token: "t", createdAt: 1, method: "pat" }, nested);
    expect(existsSync(githubTokenPath(nested))).toBe(true);
  });

  it("writes the file chmod 0600", () => {
    writeGithubToken({ token: "t", createdAt: 1, method: "pat" }, homeDir);
    const mode = statSync(githubTokenPath(homeDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("re-chmods to 0600 even if the file previously had looser permissions", () => {
    writeGithubToken({ token: "t", createdAt: 1, method: "pat" }, homeDir);
    chmodSync(githubTokenPath(homeDir), 0o644);
    writeGithubToken({ token: "t2", createdAt: 2, method: "pat" }, homeDir);
    const mode = statSync(githubTokenPath(homeDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("clearGithubToken", () => {
  it("removes an existing github.key file", () => {
    writeGithubToken({ token: "t", createdAt: 1, method: "pat" }, homeDir);
    clearGithubToken(homeDir);
    expect(existsSync(githubTokenPath(homeDir))).toBe(false);
  });

  it("is a no-op when there is nothing to clear", () => {
    expect(() => clearGithubToken(homeDir)).not.toThrow();
  });
});
