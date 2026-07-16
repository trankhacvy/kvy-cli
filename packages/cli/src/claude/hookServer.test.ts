import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attentionKindFromNotificationMessage,
  startHookServer,
  writeHookSettingsFile,
} from "./hookServer.js";

function baseUrl(port: number, path_: string): string {
  return `http://127.0.0.1:${port}${path_}`;
}

async function post(port: number, path_: string, body?: unknown): Promise<Response> {
  return fetch(baseUrl(port, path_), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

describe("startHookServer", () => {
  it("binds to 127.0.0.1 on an OS-assigned ephemeral port", async () => {
    const server = await startHookServer({ onSessionId: () => {} });
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(Number.isInteger(server.port)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("POST /hook/session-start extracts session_id and invokes onSessionId", async () => {
    const onSessionId = vi.fn();
    const server = await startHookServer({ onSessionId });
    try {
      const res = await post(server.port, "/hook/session-start", {
        session_id: "aada10c6-9299-4c45-abc4-91db9c0f935d",
        transcript_path: "/home/user/.claude/projects/foo/aada10c6.jsonl",
        cwd: "/home/user/project",
        hook_event_name: "SessionStart",
        source: "startup",
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ status: "ok" });
      expect(onSessionId).toHaveBeenCalledExactlyOnceWith("aada10c6-9299-4c45-abc4-91db9c0f935d");
    } finally {
      await server.stop();
    }
  });

  it("tolerates unknown extra fields via passthrough", async () => {
    const onSessionId = vi.fn();
    const server = await startHookServer({ onSessionId });
    try {
      const res = await post(server.port, "/hook/session-start", {
        session_id: "sess_123",
        some_future_field: { nested: true },
      });
      expect(res.status).toBe(200);
      expect(onSessionId).toHaveBeenCalledExactlyOnceWith("sess_123");
    } finally {
      await server.stop();
    }
  });

  it("400s a body missing the required session_id", async () => {
    const onSessionId = vi.fn();
    const server = await startHookServer({ onSessionId });
    try {
      const res = await post(server.port, "/hook/session-start", { cwd: "/tmp" });
      expect(res.status).toBe(400);
      expect(onSessionId).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("returns 404 for an unregistered route", async () => {
    const server = await startHookServer({ onSessionId: () => {} });
    try {
      const res = await post(server.port, "/not-a-real-route");
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("stop() closes the listener so further requests fail", async () => {
    const server = await startHookServer({ onSessionId: () => {} });
    await server.stop();
    await expect(post(server.port, "/hook/session-start", { session_id: "x" })).rejects.toThrow();
  });

  it("two concurrently started servers each get their own distinct ephemeral port", async () => {
    const [a, b] = await Promise.all([
      startHookServer({ onSessionId: () => {} }),
      startHookServer({ onSessionId: () => {} }),
    ]);
    try {
      expect(a.port).not.toBe(b.port);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  it("POST /hook/notification with a permission message invokes onAttention('perm')", async () => {
    const onAttention = vi.fn();
    const server = await startHookServer({ onSessionId: () => {}, onAttention });
    try {
      const res = await post(server.port, "/hook/notification", {
        session_id: "sess_123",
        message: "Claude needs your permission to use Bash",
      });
      expect(res.status).toBe(200);
      expect(onAttention).toHaveBeenCalledExactlyOnceWith("perm");
    } finally {
      await server.stop();
    }
  });

  it("POST /hook/notification with an idle-wait message invokes onAttention('question')", async () => {
    const onAttention = vi.fn();
    const server = await startHookServer({ onSessionId: () => {}, onAttention });
    try {
      const res = await post(server.port, "/hook/notification", {
        session_id: "sess_123",
        message: "Claude is waiting for your input",
      });
      expect(res.status).toBe(200);
      expect(onAttention).toHaveBeenCalledExactlyOnceWith("question");
    } finally {
      await server.stop();
    }
  });

  it("POST /hook/notification with no message falls back to onAttention('question')", async () => {
    const onAttention = vi.fn();
    const server = await startHookServer({ onSessionId: () => {}, onAttention });
    try {
      const res = await post(server.port, "/hook/notification", { session_id: "sess_123" });
      expect(res.status).toBe(200);
      expect(onAttention).toHaveBeenCalledExactlyOnceWith("question");
    } finally {
      await server.stop();
    }
  });

  it("POST /hook/notification with an explicit null message falls back to onAttention('question')", async () => {
    const onAttention = vi.fn();
    const server = await startHookServer({ onSessionId: () => {}, onAttention });
    try {
      const res = await post(server.port, "/hook/notification", {
        session_id: "sess_123",
        message: null,
      });
      expect(res.status).toBe(200);
      expect(onAttention).toHaveBeenCalledExactlyOnceWith("question");
    } finally {
      await server.stop();
    }
  });

  it("POST /hook/notification is a no-op when onAttention isn't supplied", async () => {
    const server = await startHookServer({ onSessionId: () => {} });
    try {
      const res = await post(server.port, "/hook/notification", { message: "anything" });
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it("POST /hook/stop invokes onAttention('done')", async () => {
    const onAttention = vi.fn();
    const server = await startHookServer({ onSessionId: () => {}, onAttention });
    try {
      const res = await post(server.port, "/hook/stop", {
        session_id: "sess_123",
        stop_hook_active: false,
      });
      expect(res.status).toBe(200);
      expect(onAttention).toHaveBeenCalledExactlyOnceWith("done");
    } finally {
      await server.stop();
    }
  });

  it("POST /hook/stop tolerates an empty body", async () => {
    const onAttention = vi.fn();
    const server = await startHookServer({ onSessionId: () => {}, onAttention });
    try {
      const res = await post(server.port, "/hook/stop");
      expect(res.status).toBe(200);
      expect(onAttention).toHaveBeenCalledExactlyOnceWith("done");
    } finally {
      await server.stop();
    }
  });
});

describe("attentionKindFromNotificationMessage", () => {
  it("returns 'perm' for a permission-prompt message, case-insensitively", () => {
    expect(attentionKindFromNotificationMessage("Claude needs your permission to use Bash")).toBe(
      "perm",
    );
    expect(attentionKindFromNotificationMessage("PERMISSION required")).toBe("perm");
  });

  it("returns 'question' for a non-permission message", () => {
    expect(attentionKindFromNotificationMessage("Claude is waiting for your input")).toBe(
      "question",
    );
  });

  it("returns 'question' when the message is undefined", () => {
    expect(attentionKindFromNotificationMessage(undefined)).toBe("question");
  });

  it("returns 'question' when the message is explicitly null", () => {
    expect(attentionKindFromNotificationMessage(null)).toBe("question");
  });
});

describe("writeHookSettingsFile", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes a settings file whose SessionStart hook command embeds the given port", () => {
    dir = mkdtempSync(path.join(tmpdir(), "falcon-hook-test-"));
    const { path: settingsPath, cleanup } = writeHookSettingsFile(dir, 54321);
    try {
      expect(existsSync(settingsPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const hook = parsed.hooks.SessionStart[0].hooks[0];
      expect(hook.type).toBe("command");
      expect(hook.command).toContain("54321");
      expect(hook.command).toMatch(/^node /);
      expect(hook.command).toMatch(/\/hook\/session-start$/);

      // The forwarder script referenced by the command must itself exist.
      const forwarderPath = hook.command.match(/^node "(.+\.cjs)" \d+ \S+$/)?.[1];
      expect(forwarderPath).toBeDefined();
      expect(existsSync(forwarderPath as string)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("also writes Notification and Stop hooks pointing at their own endpoints", () => {
    dir = mkdtempSync(path.join(tmpdir(), "falcon-hook-test-"));
    const { path: settingsPath, cleanup } = writeHookSettingsFile(dir, 54321);
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const notificationCommand: string = parsed.hooks.Notification[0].hooks[0].command;
      const stopCommand: string = parsed.hooks.Stop[0].hooks[0].command;

      expect(notificationCommand).toMatch(/\/hook\/notification$/);
      expect(notificationCommand).toContain("54321");
      expect(stopCommand).toMatch(/\/hook\/stop$/);
      expect(stopCommand).toContain("54321");

      // All three hooks share the same forwarder script.
      const forwarderOf = (command: string) => command.match(/^node "(.+\.cjs)" \d+ \S+$/)?.[1];
      expect(forwarderOf(notificationCommand)).toBe(forwarderOf(stopCommand));
    } finally {
      cleanup();
    }
  });

  it("cleanup() removes both the settings file and the forwarder script", () => {
    dir = mkdtempSync(path.join(tmpdir(), "falcon-hook-test-"));
    const { path: settingsPath, cleanup } = writeHookSettingsFile(dir, 1234);
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const forwarderPath = parsed.hooks.SessionStart[0].hooks[0].command.match(
      /^node "(.+\.cjs)" \d+ \S+$/,
    )?.[1] as string;

    cleanup();

    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(forwarderPath)).toBe(false);
  });

  it("each call produces a distinct, non-colliding settings + forwarder pair", () => {
    dir = mkdtempSync(path.join(tmpdir(), "falcon-hook-test-"));
    const a = writeHookSettingsFile(dir, 1000);
    const b = writeHookSettingsFile(dir, 1001);
    try {
      expect(a.path).not.toBe(b.path);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it("end-to-end: the generated forwarder script actually delivers stdin JSON to the hook server", async () => {
    const onSessionId = vi.fn();
    const server = await startHookServer({ onSessionId });
    dir = mkdtempSync(path.join(tmpdir(), "falcon-hook-test-"));
    const { path: settingsPath, cleanup } = writeHookSettingsFile(dir, server.port);
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const command: string = parsed.hooks.SessionStart[0].hooks[0].command;
      const match = command.match(/^node "(.+\.cjs)" (\d+) (\S+)$/);
      const forwarderPath = match?.[1] as string;
      const hookPath = match?.[3] as string;

      const child = spawn(process.execPath, [forwarderPath, String(server.port), hookPath], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.stdin.end(JSON.stringify({ session_id: "sess_from_forwarder" }));

      await new Promise<void>((resolve, reject) => {
        child.on("exit", () => resolve());
        child.on("error", reject);
      });

      // Give the forwarder's fire-and-forget HTTP request a beat to land.
      await vi.waitFor(() => {
        expect(onSessionId).toHaveBeenCalledExactlyOnceWith("sess_from_forwarder");
      });
    } finally {
      cleanup();
      await server.stop();
    }
  });

  it("end-to-end: the Stop hook's forwarder command reaches onAttention('done')", async () => {
    const onAttention = vi.fn();
    const server = await startHookServer({ onSessionId: () => {}, onAttention });
    dir = mkdtempSync(path.join(tmpdir(), "falcon-hook-test-"));
    const { path: settingsPath, cleanup } = writeHookSettingsFile(dir, server.port);
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const command: string = parsed.hooks.Stop[0].hooks[0].command;
      const match = command.match(/^node "(.+\.cjs)" (\d+) (\S+)$/);
      const forwarderPath = match?.[1] as string;
      const hookPath = match?.[3] as string;

      const child = spawn(process.execPath, [forwarderPath, String(server.port), hookPath], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.stdin.end(JSON.stringify({ session_id: "sess_from_forwarder" }));

      await new Promise<void>((resolve, reject) => {
        child.on("exit", () => resolve());
        child.on("error", reject);
      });

      await vi.waitFor(() => {
        expect(onAttention).toHaveBeenCalledExactlyOnceWith("done");
      });
    } finally {
      cleanup();
      await server.stop();
    }
  });
});
