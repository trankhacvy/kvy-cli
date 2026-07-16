import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeCliLocation } from "./claudeCliLocator.js";
import {
  CLAUDE_NOT_AUTHENTICATED_MESSAGE,
  CLAUDE_NOT_INSTALLED_MESSAGE,
  claudeCodeProvider,
  detectClaudeCode,
} from "./claudeProviderAdapter.js";

// `locate`/`resolveVersion` are injected throughout so these tests are
// hermetic — they must pass identically whether or not the machine running
// them happens to have a real Claude Code install (see the doc comment on
// `DetectClaudeCodeOptions.locate`).
const noKeychain = () => false;
const fakeLocation: ClaudeCliLocation = { path: "/fake/claude/cli.js", source: "npm" };

describe("detectClaudeCode", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "falcon-provider-detect-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("reports not installed, with an actionable install command, when the CLI can't be located", async () => {
    const result = await detectClaudeCode({
      locate: () => null,
      homeDir,
      checkMacKeychain: noKeychain,
    });
    expect(result).toEqual({
      installed: false,
      authenticated: false,
      error: CLAUDE_NOT_INSTALLED_MESSAGE,
    });
  });

  it("reports installed-but-not-authenticated, with the exact fix command, when no credentials are found", async () => {
    const result = await detectClaudeCode({
      locate: () => fakeLocation,
      resolveVersion: () => "2.1.99",
      env: {},
      homeDir,
      checkMacKeychain: noKeychain,
    });
    expect(result).toEqual({
      installed: true,
      authenticated: false,
      version: "2.1.99",
      error: CLAUDE_NOT_AUTHENTICATED_MESSAGE,
    });
  });

  it("reports installed + authenticated + version with no error when both checks pass", async () => {
    const result = await detectClaudeCode({
      locate: () => fakeLocation,
      resolveVersion: () => "2.1.99",
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      homeDir,
      checkMacKeychain: noKeychain,
    });
    expect(result).toEqual({ installed: true, authenticated: true, version: "2.1.99" });
  });

  it("omits `version` when it can't be resolved, without throwing", async () => {
    const result = await detectClaudeCode({
      locate: () => fakeLocation,
      resolveVersion: () => null,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      homeDir,
      checkMacKeychain: noKeychain,
    });
    expect(result).toEqual({ installed: true, authenticated: true });
  });

  it("defaults to the real locator/version-resolver/env when no overrides are given", async () => {
    // Exercises the production default path end-to-end (no injected
    // collaborators) — only asserts it settles with a well-shaped result,
    // since the real answer depends on the host machine's actual install.
    await expect(detectClaudeCode()).resolves.toMatchObject({
      installed: expect.any(Boolean),
      authenticated: expect.any(Boolean),
    });
  });
});

describe("claudeCodeProvider", () => {
  it("exposes the claude-code id and a detect() function", () => {
    expect(claudeCodeProvider.id).toBe("claude-code");
    expect(typeof claudeCodeProvider.detect).toBe("function");
  });
});
