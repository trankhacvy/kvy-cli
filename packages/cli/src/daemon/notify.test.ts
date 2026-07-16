import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyDaemonSessionStartedDeps } from "./notify.js";
import { notifyDaemonSessionStarted } from "./notify.js";
import { writeDaemonState } from "./state.js";
import type { SessionEncryptionData } from "./types.js";

describe("notifyDaemonSessionStarted", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-notify-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  function buildDeps(
    overrides: Partial<NotifyDaemonSessionStartedDeps> = {},
  ): NotifyDaemonSessionStartedDeps {
    return {
      homeDir,
      fetchImpl: vi.fn(),
      isProcessAlive: () => true,
      ...overrides,
    };
  }

  it("returns 'no-daemon' when daemon.state.json does not exist", async () => {
    const fetchImpl = vi.fn();
    const result = await notifyDaemonSessionStarted(buildDeps({ fetchImpl }), {
      sessionId: "sess_1",
    });

    expect(result).toEqual({ type: "no-daemon" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 'no-daemon' when the state file's pid is stale", async () => {
    await writeDaemonState(homeDir, { pid: 999, port: 4567, version: "0.1.0", startedAt: 0 });
    const fetchImpl = vi.fn();
    const isProcessAlive = vi.fn().mockReturnValue(false);

    const result = await notifyDaemonSessionStarted(buildDeps({ fetchImpl, isProcessAlive }), {
      sessionId: "sess_1",
    });

    expect(result).toEqual({ type: "no-daemon" });
    expect(isProcessAlive).toHaveBeenCalledWith(999);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs to the daemon's control port and returns 'ok' on success", async () => {
    await writeDaemonState(homeDir, { pid: 111, port: 4567, version: "0.1.0", startedAt: 0 });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
      }),
    );

    const encryption: SessionEncryptionData = {
      encryptionKey: "b64-key",
      seq: 1,
      metadataVersion: 1,
      agentStateVersion: 1,
    };

    const result = await notifyDaemonSessionStarted(buildDeps({ fetchImpl }), {
      sessionId: "sess_1",
      metadata: { title: "hi" },
      encryption,
    });

    expect(result).toEqual({ type: "ok" });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:4567/session-started",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          pid: process.pid,
          sessionId: "sess_1",
          metadata: { title: "hi" },
          encryption,
        }),
      }),
    );
  });

  it("defaults pid to process.pid but lets an explicit pid override it", async () => {
    await writeDaemonState(homeDir, { pid: 111, port: 4567, version: "0.1.0", startedAt: 0 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

    await notifyDaemonSessionStarted(buildDeps({ fetchImpl }), { sessionId: "sess_1", pid: 555 });

    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:4567/session-started",
      expect.objectContaining({
        body: JSON.stringify({ pid: 555, sessionId: "sess_1" }),
      }),
    );
  });

  it("returns 'unreachable' when the daemon responds with a non-2xx status", async () => {
    await writeDaemonState(homeDir, { pid: 111, port: 4567, version: "0.1.0", startedAt: 0 });
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));

    const result = await notifyDaemonSessionStarted(buildDeps({ fetchImpl }), {
      sessionId: "sess_1",
    });

    expect(result.type).toBe("unreachable");
    expect((result as { error: string }).error).toContain("500");
  });

  it("returns 'unreachable' and swallows the error when fetch throws (connection refused)", async () => {
    await writeDaemonState(homeDir, { pid: 111, port: 4567, version: "0.1.0", startedAt: 0 });
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await notifyDaemonSessionStarted(buildDeps({ fetchImpl }), {
      sessionId: "sess_1",
    });

    expect(result).toEqual({ type: "unreachable", error: "ECONNREFUSED" });
  });
});
