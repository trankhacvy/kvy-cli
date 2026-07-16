import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isClaudeCodeAuthenticated } from "./claudeAuth.js";

// `checkMacKeychain: () => false` isolates these cases from the host
// machine's real Keychain state (see the option's doc comment) — the
// dedicated "macOS Keychain" describe block below exercises that path
// directly instead.
const noKeychain = () => false;

describe("isClaudeCodeAuthenticated", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "falcon-claude-auth-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("is authenticated when ANTHROPIC_API_KEY is set", () => {
    expect(
      isClaudeCodeAuthenticated({
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
        homeDir,
        checkMacKeychain: noKeychain,
      }),
    ).toBe(true);
  });

  it("is authenticated when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    expect(
      isClaudeCodeAuthenticated({
        env: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        homeDir,
        checkMacKeychain: noKeychain,
      }),
    ).toBe(true);
  });

  it("ignores a blank ANTHROPIC_API_KEY", () => {
    expect(
      isClaudeCodeAuthenticated({
        env: { ANTHROPIC_API_KEY: "   " },
        homeDir,
        checkMacKeychain: noKeychain,
      }),
    ).toBe(false);
  });

  it("is not authenticated when nothing is set and no credentials file exists", () => {
    expect(isClaudeCodeAuthenticated({ env: {}, homeDir, checkMacKeychain: noKeychain })).toBe(
      false,
    );
  });

  it("is authenticated when ~/.claude/.credentials.json has an access token", () => {
    const claudeDir = path.join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      path.join(claudeDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "at-123", refreshToken: "rt-456" } }),
    );
    expect(isClaudeCodeAuthenticated({ env: {}, homeDir, checkMacKeychain: noKeychain })).toBe(
      true,
    );
  });

  it("is not authenticated when the credentials file has no access token", () => {
    const claudeDir = path.join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(path.join(claudeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }));
    expect(isClaudeCodeAuthenticated({ env: {}, homeDir, checkMacKeychain: noKeychain })).toBe(
      false,
    );
  });

  it("treats a malformed credentials file as absent rather than throwing", () => {
    const claudeDir = path.join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(path.join(claudeDir, ".credentials.json"), "{ not valid json");
    expect(() =>
      isClaudeCodeAuthenticated({ env: {}, homeDir, checkMacKeychain: noKeychain }),
    ).not.toThrow();
    expect(isClaudeCodeAuthenticated({ env: {}, homeDir, checkMacKeychain: noKeychain })).toBe(
      false,
    );
  });
});

describe("isClaudeCodeAuthenticated — macOS Keychain fallback", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "falcon-claude-auth-keychain-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("is authenticated when the Keychain check reports credentials and nothing else does", () => {
    expect(isClaudeCodeAuthenticated({ env: {}, homeDir, checkMacKeychain: () => true })).toBe(
      true,
    );
  });

  it("only consults the Keychain after env vars and the credentials file both miss", () => {
    let keychainCalled = false;
    isClaudeCodeAuthenticated({
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      homeDir,
      checkMacKeychain: () => {
        keychainCalled = true;
        return true;
      },
    });
    expect(keychainCalled).toBe(false);
  });
});
