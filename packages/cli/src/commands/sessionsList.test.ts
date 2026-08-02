import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectPath } from "../claude/scanner.js";
import type { SessionsListCommandDeps } from "./sessionsList.js";
import { runSessionsListCommand } from "./sessionsList.js";

function userLine(text: string, timestamp = "2026-01-01T00:00:00.000Z"): string {
  return `${JSON.stringify({ type: "user", uuid: "u1", timestamp, message: { role: "user", content: text } })}\n`;
}

describe("runSessionsListCommand", () => {
  let baseDir: string;
  let claudeConfigDir: string;
  let workspacePath: string;
  let projectDir: string;
  let env: NodeJS.ProcessEnv;
  let written: string[];

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    baseDir = join(tmpdir(), `sessions-list-cmd-test-${unique}`);
    claudeConfigDir = join(baseDir, "claude-home");
    workspacePath = join(baseDir, "project");
    env = { CLAUDE_CONFIG_DIR: claudeConfigDir };
    projectDir = getProjectPath(workspacePath, env);
    await mkdir(projectDir, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    written = [];
  });

  afterEach(async () => {
    if (existsSync(baseDir)) await rm(baseDir, { recursive: true, force: true });
  });

  function baseDeps(overrides: Partial<SessionsListCommandDeps> = {}): SessionsListCommandDeps {
    return {
      workingDirectory: workspacePath,
      env,
      readCredentials: () => null,
      write: (text: string) => {
        written.push(text);
      },
      ...overrides,
    };
  }

  it("lists local sessions, most-recently-active first", async () => {
    await writeFile(
      join(projectDir, "sess-old.jsonl"),
      userLine("old", "2026-01-01T00:00:00.000Z"),
    );
    await writeFile(
      join(projectDir, "sess-new.jsonl"),
      userLine("new", "2026-01-02T00:00:00.000Z"),
    );

    const code = await runSessionsListCommand(baseDeps());

    expect(code).toBe(0);
    const output = written.join("");
    expect(output).toContain("Local sessions");
    expect(output.indexOf("sess-new")).toBeLessThan(output.indexOf("sess-old"));
  });

  it("reports '(none for this directory)' when there are no local sessions", async () => {
    const code = await runSessionsListCommand(baseDeps());
    expect(code).toBe(0);
    expect(written.join("")).toContain("(none for this directory)");
  });

  it("skips the remote fetch and reports 'not logged in' when there are no credentials", async () => {
    const fetchImpl = vi.fn();
    const code = await runSessionsListCommand(baseDeps({ fetchImpl }));

    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(written.join("")).toContain("not logged in");
  });

  // an access token means the command's own `fetchImpl` first sees a `/v1/auth/refresh`
  // call (via `resolveAccessToken`) before the actual `/v1/sessions` request.
  function fakeRefresh(accessToken: string) {
    return async () =>
      new Response(JSON.stringify({ accessToken, refreshToken: "rotated-refresh" }), {
        status: 200,
      });
  }

  it("fetches and formats remote sessions with a bearer token when logged in", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.toString().endsWith("/v1/auth/refresh")) return fakeRefresh("test-access-token")();
      expect(url).toBe("http://backend.example/v1/sessions?limit=50");
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer test-access-token",
      );
      return new Response(
        JSON.stringify({
          sessions: [
            {
              id: "row_1",
              tag: "machine-a:/proj",
              provider: "claude-code",
              status: "active",
              updatedAt: 1_700_000_000_000,
            },
          ],
          nextCursor: null,
        }),
        { status: 200 },
      );
    });

    const code = await runSessionsListCommand(
      baseDeps({
        backendUrl: "http://backend.example",
        readCredentials: () => ({
          refreshToken: "test-refresh-token",
          keyMaterial: { mode: "plaintext-fallback", bundle: "x" },
        }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );

    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const output = written.join("");
    expect(output).toContain("row_1");
    expect(output).toContain("machine-a:/proj");
    expect(output).toContain("[claude-code/active]");
  });

  it("reports a network/HTTP failure inline rather than failing the whole command", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.toString().endsWith("/v1/auth/refresh")) return fakeRefresh("test-access-token")();
      return new Response(null, { status: 500 });
    });

    const code = await runSessionsListCommand(
      baseDeps({
        readCredentials: () => ({
          refreshToken: "test-refresh-token",
          keyMaterial: { mode: "plaintext-fallback", bundle: "x" },
        }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );

    expect(code).toBe(0);
    expect(written.join("")).toContain("could not reach the Kvy server");
  });
});
