import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessEntry } from "../daemon/processScan.js";
import { findOwningClaudeProcess, isPlainClaudeCommand, type LivenessDeps } from "./liveness.js";

describe("isPlainClaudeCommand", () => {
  it("recognizes a bare `claude` invocation", () => {
    expect(isPlainClaudeCommand("claude")).toBe(true);
    expect(isPlainClaudeCommand("/usr/local/bin/claude --resume abc")).toBe(true);
  });

  it("rejects a Kvy-launched session", () => {
    expect(isPlainClaudeCommand("kvy claude --starting-mode remote --started-by daemon")).toBe(
      false,
    );
  });

  it("rejects an unrelated command", () => {
    expect(isPlainClaudeCommand("node server.js")).toBe(false);
    expect(isPlainClaudeCommand("")).toBe(false);
  });
});

describe("findOwningClaudeProcess", () => {
  let baseDir: string;
  let workspacePath: string;
  let projectDir: string;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    baseDir = join(tmpdir(), `liveness-test-${unique}`);
    workspacePath = join(baseDir, "project");
    projectDir = join(baseDir, "transcripts");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(baseDir)) await rm(baseDir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<LivenessDeps> = {}): LivenessDeps {
    return {
      listProcesses: async () => [] as ProcessEntry[],
      resolveProcessCwd: async () => null,
      ...overrides,
    };
  }

  it("returns null when no live plain-claude process matches the workspace", async () => {
    const result = await findOwningClaudeProcess(workspacePath, projectDir, deps());
    expect(result).toBeNull();
  });

  it("ignores a Kvy-managed process even if its cwd matches", async () => {
    await writeFile(join(projectDir, "sess-a.jsonl"), "{}");
    const result = await findOwningClaudeProcess(
      workspacePath,
      projectDir,
      deps({
        listProcesses: async () => [
          { pid: 1, ppid: 0, command: "kvy claude --starting-mode remote --started-by daemon" },
        ],
        resolveProcessCwd: async () => workspacePath,
      }),
    );
    expect(result).toBeNull();
  });

  it("pairs a live plain-claude process with the most-recently-modified transcript", async () => {
    await writeFile(join(projectDir, "sess-old.jsonl"), "{}");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(join(projectDir, "sess-new.jsonl"), "{}");

    const result = await findOwningClaudeProcess(
      workspacePath,
      projectDir,
      deps({
        listProcesses: async () => [{ pid: 42, ppid: 1, command: "claude" }],
        resolveProcessCwd: async (pid) => (pid === 42 ? workspacePath : null),
      }),
    );

    expect(result).toEqual({ pid: 42, providerSessionId: "sess-new" });
  });

  it("returns null when a live process's cwd doesn't match the workspace", async () => {
    await writeFile(join(projectDir, "sess-a.jsonl"), "{}");
    const result = await findOwningClaudeProcess(
      workspacePath,
      projectDir,
      deps({
        listProcesses: async () => [{ pid: 42, ppid: 1, command: "claude" }],
        resolveProcessCwd: async () => "/somewhere/else",
      }),
    );
    expect(result).toBeNull();
  });

  it("returns null when the project dir can't be read", async () => {
    const result = await findOwningClaudeProcess(
      workspacePath,
      join(baseDir, "does-not-exist"),
      deps({
        listProcesses: async () => [{ pid: 42, ppid: 1, command: "claude" }],
        resolveProcessCwd: async () => workspacePath,
      }),
    );
    expect(result).toBeNull();
  });
});
