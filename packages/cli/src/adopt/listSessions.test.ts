import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProjectPath } from "../claude/scanner.js";
import type { ProcessEntry } from "../daemon/processScan.js";
import { listAdoptableSessions } from "./listSessions.js";

function userLine(text: string, timestamp = "2026-01-01T00:00:00.000Z"): string {
  return `${JSON.stringify({ type: "user", uuid: "u1", timestamp, message: { role: "user", content: text } })}\n`;
}

describe("listAdoptableSessions", () => {
  let baseDir: string;
  let claudeConfigDir: string;
  let workspacePath: string;
  let projectDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    baseDir = join(tmpdir(), `list-sessions-test-${unique}`);
    claudeConfigDir = join(baseDir, "claude-home");
    workspacePath = join(baseDir, "project");
    env = { CLAUDE_CONFIG_DIR: claudeConfigDir };
    projectDir = getProjectPath(workspacePath, env);
    await mkdir(projectDir, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(baseDir)) await rm(baseDir, { recursive: true, force: true });
  });

  it("returns an empty list when the project dir doesn't exist yet", async () => {
    const sessions = await listAdoptableSessions({
      workingDirectory: join(baseDir, "unregistered"),
      env,
    });
    expect(sessions).toEqual([]);
  });

  it("lists transcripts most-recently-active first, with running:false by default", async () => {
    await writeFile(
      join(projectDir, "sess-old.jsonl"),
      userLine("older message", "2026-01-01T00:00:00.000Z"),
    );
    await writeFile(
      join(projectDir, "sess-new.jsonl"),
      userLine("newer message", "2026-01-02T00:00:00.000Z"),
    );

    const sessions = await listAdoptableSessions({ workingDirectory: workspacePath, env });

    expect(sessions.map((s) => s.providerSessionId)).toEqual(["sess-new", "sess-old"]);
    expect(sessions.every((s) => s.running === false)).toBe(true);
  });

  it("marks the session a live plain-claude process owns as running", async () => {
    await writeFile(join(projectDir, "sess-a.jsonl"), userLine("hello"));

    const sessions = await listAdoptableSessions({
      workingDirectory: workspacePath,
      env,
      liveness: {
        listProcesses: async () => [{ pid: 7, ppid: 1, command: "claude" } as ProcessEntry],
        resolveProcessCwd: async () => workspacePath,
      },
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.running).toBe(true);
  });

  it("skips an empty/unwritten transcript file", async () => {
    await writeFile(join(projectDir, "sess-empty.jsonl"), "");
    await writeFile(join(projectDir, "sess-real.jsonl"), userLine("hi"));

    const sessions = await listAdoptableSessions({ workingDirectory: workspacePath, env });
    expect(sessions.map((s) => s.providerSessionId)).toEqual(["sess-real"]);
  });
});
