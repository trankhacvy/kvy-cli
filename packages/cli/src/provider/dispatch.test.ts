import { describe, expect, it, vi } from "vitest";

const runStartClaudeCommandMock = vi.fn(async (..._args: unknown[]) => 0);
vi.mock("../commands/start.js", () => ({
  runStartClaudeCommand: (...args: unknown[]) => runStartClaudeCommandMock(...args),
}));

const runStartCodexCommandMock = vi.fn(async (..._args: unknown[]) => 0);
vi.mock("../commands/startCodex.js", () => ({
  runStartCodexCommand: (...args: unknown[]) => runStartCodexCommandMock(...args),
}));

const { runStart } = await import("./dispatch.js");

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("runStart", () => {
  it("routes claude-code to runStartClaudeCommand with a mapped claudeArgs field", async () => {
    const logger = fakeLogger();
    await runStart("claude-code", {
      homeDir: "/home",
      workingDirectory: "/work",
      providerArgs: ["--model", "sonnet"],
      logger,
      launcherPath: "/launcher.cjs",
    });

    expect(runStartClaudeCommandMock).toHaveBeenCalledWith({
      homeDir: "/home",
      workingDirectory: "/work",
      claudeArgs: ["--model", "sonnet"],
      launcherPath: "/launcher.cjs",
      logger,
    });
    expect(runStartCodexCommandMock).not.toHaveBeenCalled();
  });

  it("throws if claude-code is dispatched without a launcherPath", async () => {
    const logger = fakeLogger();
    await expect(
      runStart("claude-code", {
        homeDir: "/home",
        workingDirectory: "/work",
        providerArgs: [],
        logger,
      }),
    ).rejects.toThrow("launcherPath");
  });

  it("routes codex to runStartCodexCommand with a mapped codexArgs field", async () => {
    const logger = fakeLogger();
    await runStart("codex", {
      homeDir: "/home",
      workingDirectory: "/work",
      providerArgs: ["--model", "gpt-5.1-codex"],
      logger,
    });

    expect(runStartCodexCommandMock).toHaveBeenCalledWith({
      homeDir: "/home",
      workingDirectory: "/work",
      codexArgs: ["--model", "gpt-5.1-codex"],
      logger,
    });
  });
});
