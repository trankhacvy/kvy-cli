import { describe, expect, it, vi } from "vitest";
import { startControlServer } from "./controlServer.js";
import type { ControlServerDeps } from "./controlServer.js";
import type { SessionEncryptionData, SpawnSessionResult, TrackedSession } from "./types.js";

function baseUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

async function post(port: number, path: string, body?: unknown): Promise<Response> {
  return fetch(baseUrl(port, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function buildDeps(overrides: Partial<ControlServerDeps> = {}): ControlServerDeps {
  return {
    getSessions: () => [],
    stopSession: () => false,
    spawnSession: async () => ({ type: "error", errorMessage: "not configured" }) as SpawnSessionResult,
    requestShutdown: () => {},
    onSessionStarted: () => {},
    ...overrides,
  };
}

describe("startControlServer", () => {
  it("binds to 127.0.0.1 on an OS-assigned ephemeral port", async () => {
    const server = await startControlServer(buildDeps());
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(Number.isInteger(server.port)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("POST /session-started decodes encryption fields and forwards them verbatim", async () => {
    const onSessionStarted = vi.fn();
    const server = await startControlServer(buildDeps({ onSessionStarted }));
    try {
      const encryption: SessionEncryptionData = {
        encryptionKey: "base64-key-material",
        seq: 3,
        metadataVersion: 1,
        agentStateVersion: 2,
      };
      const res = await post(server.port, "/session-started", {
        sessionId: "sess_123",
        metadata: { title: "hello" },
        encryption,
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ status: "ok" });
      expect(onSessionStarted).toHaveBeenCalledExactlyOnceWith("sess_123", { title: "hello" }, encryption);
    } finally {
      await server.stop();
    }
  });

  it("POST /session-started tolerates a session reporting with no encryption material", async () => {
    const onSessionStarted = vi.fn();
    const server = await startControlServer(buildDeps({ onSessionStarted }));
    try {
      const res = await post(server.port, "/session-started", { sessionId: "sess_456" });
      expect(res.status).toBe(200);
      expect(onSessionStarted).toHaveBeenCalledExactlyOnceWith("sess_456", undefined, undefined);
    } finally {
      await server.stop();
    }
  });

  it("POST /session-started 400s a body missing the required sessionId", async () => {
    const server = await startControlServer(buildDeps());
    try {
      const res = await post(server.port, "/session-started", { metadata: {} });
      expect(res.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("POST /list returns only sessions that have self-reported a sessionId", async () => {
    const sessions: TrackedSession[] = [
      { startedBy: "daemon", sessionId: "sess_a", pid: 111 },
      { startedBy: "terminal", pid: 222 }, // not yet self-reported — must be filtered out
    ];
    const server = await startControlServer(buildDeps({ getSessions: () => sessions }));
    try {
      const res = await post(server.port, "/list");
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        sessions: [{ startedBy: "daemon", sessionId: "sess_a", pid: 111 }],
      });
    } finally {
      await server.stop();
    }
  });

  it("POST /stop-session forwards sessionId and echoes the injected result", async () => {
    const stopSession = vi.fn().mockReturnValue(true);
    const server = await startControlServer(buildDeps({ stopSession }));
    try {
      const res = await post(server.port, "/stop-session", { sessionId: "sess_a" });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true });
      expect(stopSession).toHaveBeenCalledExactlyOnceWith("sess_a");
    } finally {
      await server.stop();
    }
  });

  it("POST /spawn-session returns 200 on success", async () => {
    const spawnSession = vi.fn().mockResolvedValue({ type: "success", sessionId: "sess_new" } satisfies SpawnSessionResult);
    const server = await startControlServer(buildDeps({ spawnSession }));
    try {
      const res = await post(server.port, "/spawn-session", { directory: "/tmp/work" });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true, sessionId: "sess_new" });
      expect(spawnSession).toHaveBeenCalledExactlyOnceWith({
        directory: "/tmp/work",
        sessionId: undefined,
        provider: undefined,
        permissionMode: undefined,
        model: undefined,
        environmentVariables: undefined,
      });
    } finally {
      await server.stop();
    }
  });

  it("POST /spawn-session returns 409 + directory when directory-creation approval is required", async () => {
    const spawnSession = vi.fn().mockResolvedValue({
      type: "requestToApproveDirectoryCreation",
      directory: "/tmp/new-dir",
    } satisfies SpawnSessionResult);
    const server = await startControlServer(buildDeps({ spawnSession }));
    try {
      const res = await post(server.port, "/spawn-session", { directory: "/tmp/new-dir" });
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        success: false,
        requiresUserApproval: true,
        actionRequired: "CREATE_DIRECTORY",
        directory: "/tmp/new-dir",
      });
    } finally {
      await server.stop();
    }
  });

  it("POST /spawn-session returns 500 + error message on failure", async () => {
    const spawnSession = vi.fn().mockResolvedValue({
      type: "error",
      errorMessage: "boom",
    } satisfies SpawnSessionResult);
    const server = await startControlServer(buildDeps({ spawnSession }));
    try {
      const res = await post(server.port, "/spawn-session", { directory: "/tmp/work" });
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ success: false, error: "boom" });
    } finally {
      await server.stop();
    }
  });

  it("POST /spawn-session rejects an invalid permissionMode before reaching spawnSession", async () => {
    const spawnSession = vi.fn();
    const server = await startControlServer(buildDeps({ spawnSession }));
    try {
      const res = await post(server.port, "/spawn-session", {
        directory: "/tmp/work",
        permissionMode: "not-a-real-mode",
      });
      expect(res.status).toBe(400);
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("POST /stop returns immediately and calls requestShutdown shortly after", async () => {
    const requestShutdown = vi.fn();
    const server = await startControlServer(buildDeps({ requestShutdown }));
    try {
      const res = await post(server.port, "/stop");
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ status: "stopping" });
      // The handler responds before requesting shutdown (setTimeout(..., 50) inside
      // controlServer.ts) so the HTTP response isn't racing the caller's own teardown.
      expect(requestShutdown).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 100));
      expect(requestShutdown).toHaveBeenCalledOnce();
    } finally {
      await server.stop();
    }
  });

  it("stop() closes the listener so further requests fail", async () => {
    const server = await startControlServer(buildDeps());
    await server.stop();
    await expect(post(server.port, "/list")).rejects.toThrow();
  });
});
