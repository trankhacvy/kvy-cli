import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlServerHandle } from "./controlServer.js";
import { startControlServer } from "./controlServer.js";
import { notifyDaemonSessionStarted } from "./notify.js";
import { writeDaemonState } from "./state.js";
import type { SessionEncryptionData } from "./types.js";

/**
 * Verifies `notifyDaemonSessionStarted` against a real `startControlServer`
 * (already merged on `main`, controlServer.ts) — no mocked fetch, no mocked
 * HTTP layer. Only `readDaemonState`'s liveness check is pointed at this
 * process's own pid so it reads as "alive" without needing a second process.
 */
describe("notifyDaemonSessionStarted (integration against a real control server)", () => {
  let homeDir: string;
  let server: ControlServerHandle;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-notify-integration-"));
  });

  afterEach(async () => {
    await server?.stop();
    await rm(homeDir, { recursive: true, force: true });
  });

  it("round-trips the POST and delivers sessionId + encryption to onSessionStarted", async () => {
    const onSessionStarted = vi.fn();
    server = await startControlServer({
      getSessions: () => [],
      stopSession: () => false,
      spawnSession: async () => ({ type: "error", errorMessage: "not configured" }),
      requestShutdown: () => {},
      onSessionStarted,
    });

    await writeDaemonState(homeDir, {
      pid: process.pid,
      port: server.port,
      version: "0.1.0",
      startedAt: Date.now(),
    });

    const encryption: SessionEncryptionData = {
      encryptionKey: "wrapped-dek-base64",
      seq: 5,
      metadataVersion: 2,
      agentStateVersion: 1,
    };

    const result = await notifyDaemonSessionStarted(
      { homeDir, fetchImpl: fetch, isProcessAlive: () => true },
      { sessionId: "sess_real", metadata: { cwd: "/tmp/proj" }, encryption },
    );

    expect(result).toEqual({ type: "ok" });
    expect(onSessionStarted).toHaveBeenCalledExactlyOnceWith(
      "sess_real",
      { cwd: "/tmp/proj" },
      encryption,
    );
  });

  it("returns 'unreachable' once the control server has been stopped", async () => {
    server = await startControlServer({
      getSessions: () => [],
      stopSession: () => false,
      spawnSession: async () => ({ type: "error", errorMessage: "not configured" }),
      requestShutdown: () => {},
      onSessionStarted: () => {},
    });
    const port = server.port;
    await server.stop();

    await writeDaemonState(homeDir, {
      pid: process.pid,
      port,
      version: "0.1.0",
      startedAt: Date.now(),
    });

    const result = await notifyDaemonSessionStarted(
      { homeDir, fetchImpl: fetch, isProcessAlive: () => true, timeoutMs: 500 },
      { sessionId: "sess_gone" },
    );

    expect(result.type).toBe("unreachable");
  });
});
