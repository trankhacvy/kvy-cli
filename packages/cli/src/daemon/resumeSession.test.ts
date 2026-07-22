import { describe, expect, it, vi } from "vitest";
import { ResumeSessionError, resumeSession } from "./resumeSession.js";
import type { PersistedSession } from "./sessionsStore.js";
import type { SpawnAwaiter } from "./spawnAwaiter.js";

const PERSISTED: PersistedSession = {
  sessionId: "sess_1",
  provider: "claude-code",
  metadata: { path: "/tmp/proj" },
  encryption: { encryptionKey: "wrapped-dek", seq: 3, metadataVersion: 2, agentStateVersion: 1 },
  savedAt: 1_700_000_000_000,
};

function fakeAwaiter(overrides: Partial<SpawnAwaiter> = {}): SpawnAwaiter {
  return {
    waitFor: vi.fn(async (pid: number) => ({ sessionId: "sess_1", pid })),
    resolve: vi.fn(() => true),
    ...overrides,
  };
}

function fakeRegistry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    findResumable: vi.fn(() => PERSISTED),
    stopSession: vi.fn(() => false),
    getLivePid: vi.fn(() => null),
    trackSpawned: vi.fn(),
    ...overrides,
  };
}

describe("resumeSession", () => {
  it("re-spawns with FALCON_RECONNECT_* env carrying the persisted encryption material", async () => {
    const launchProcess = vi.fn(async () => ({ method: "detached" as const, pid: 555 }));
    const registry = fakeRegistry();

    const result = await resumeSession("sess_1", {
      registry,
      awaiter: fakeAwaiter(),
      resolveDirectory: () => "/tmp/proj",
      launchProcess,
      falconEntrypoint: () => ["/usr/bin/node", "/opt/falcon/dist/index.mjs"],
      baseEnv: {},
    });

    expect(result).toEqual({ sessionId: "sess_1" });
    expect(launchProcess).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionLabel: "sess_1",
        command: "/usr/bin/node",
        args: [
          "/opt/falcon/dist/index.mjs",
          "claude",
          "--starting-mode",
          "remote",
          "--started-by",
          "daemon",
        ],
        cwd: "/tmp/proj",
        env: expect.objectContaining({
          FALCON_RECONNECT_SESSION_ID: "sess_1",
          FALCON_RECONNECT_ENCRYPTION_KEY: "wrapped-dek",
          FALCON_RECONNECT_SEQ: "3",
          FALCON_RECONNECT_METADATA_VERSION: "2",
          FALCON_RECONNECT_AGENT_STATE_VERSION: "1",
        }),
      }),
      undefined,
    );
    expect(registry.trackSpawned).toHaveBeenCalledExactlyOnceWith(555, "/tmp/proj");
  });

  it("re-tracks the relaunched pid WITH the resolved directory, so spawn-dedup survives across the resume (Flow 3 — spawn-directory-dedup)", async () => {
    const launchProcess = vi.fn(async () => ({ method: "detached" as const, pid: 777 }));
    const registry = fakeRegistry();

    await resumeSession("sess_1", {
      registry,
      awaiter: fakeAwaiter({ waitFor: vi.fn(async (pid: number) => ({ sessionId: "sess_1", pid })) }),
      // The resolved directory the relaunch runs in — this exact string must
      // be threaded into `trackSpawned` so `scanForLiveSessionInDirectory`
      // can match the resumed session again.
      resolveDirectory: () => "/Users/vy/projects/falcon",
      launchProcess,
      falconEntrypoint: () => ["/usr/bin/node", "/opt/falcon/dist/index.mjs"],
      baseEnv: {},
    });

    // Not just "called" — called with the directory as the second argument.
    expect(registry.trackSpawned).toHaveBeenCalledExactlyOnceWith(
      777,
      "/Users/vy/projects/falcon",
    );
  });

  it("uses the codex CLI name for a persisted codex session", async () => {
    const launchProcess = vi.fn(async () => ({ method: "detached" as const, pid: 555 }));

    await resumeSession("sess_1", {
      registry: fakeRegistry({
        findResumable: vi.fn(() => ({ ...PERSISTED, provider: "codex" as const })),
      }),
      awaiter: fakeAwaiter(),
      resolveDirectory: () => "/tmp/proj",
      launchProcess,
      falconEntrypoint: () => ["/usr/bin/node", "/opt/falcon/dist/index.mjs"],
    });

    expect(launchProcess).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.arrayContaining(["codex"]) }),
      undefined,
    );
  });

  it("stops any still-live process for the session before relaunching", async () => {
    const registry = fakeRegistry({ stopSession: vi.fn(() => true), getLivePid: vi.fn(() => 999) });

    await resumeSession("sess_1", {
      registry,
      awaiter: fakeAwaiter(),
      resolveDirectory: () => "/tmp/proj",
      launchProcess: vi.fn(async () => ({ method: "detached" as const, pid: 1 })),
      falconEntrypoint: () => ["/usr/bin/node", "/opt/falcon/dist/index.mjs"],
      isAlive: () => false,
    });

    expect(registry.stopSession).toHaveBeenCalledExactlyOnceWith("sess_1");
  });

  it("waits for the old process to be confirmed dead before launching the replacement", async () => {
    const registry = fakeRegistry({ stopSession: vi.fn(() => true), getLivePid: vi.fn(() => 999) });
    const sleep = vi.fn(async () => {});
    let now = 0;
    const callOrder: string[] = [];
    let calls = 0;
    const isAlive = vi.fn(() => {
      calls += 1;
      const alive = calls <= 2; // alive for the first two polls, dead from the third on
      callOrder.push(alive ? "alive" : "dead");
      return alive;
    });
    const launchProcess = vi.fn(async () => {
      callOrder.push("launch");
      return { method: "detached" as const, pid: 1 };
    });

    await resumeSession("sess_1", {
      registry,
      awaiter: fakeAwaiter(),
      resolveDirectory: () => "/tmp/proj",
      launchProcess,
      falconEntrypoint: () => ["/usr/bin/node", "/opt/falcon/dist/index.mjs"],
      isAlive,
      sleep,
      now: () => now++,
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(launchProcess).toHaveBeenCalledTimes(1);
    expect(callOrder.indexOf("launch")).toBeGreaterThan(callOrder.lastIndexOf("alive"));
  });

  it("escalates to SIGKILL if the old process ignores SIGTERM within the timeout", async () => {
    const registry = fakeRegistry({ stopSession: vi.fn(() => true), getLivePid: vi.fn(() => 999) });
    const killPid = vi.fn();
    let now = 0;
    // Always alive until killPid(SIGKILL) is called, then dead.
    let killed = false;
    const isAlive = vi.fn(() => !killed);
    killPid.mockImplementation((_pid: number, signal: string) => {
      if (signal === "SIGKILL") killed = true;
    });

    const result = await resumeSession("sess_1", {
      registry,
      awaiter: fakeAwaiter(),
      resolveDirectory: () => "/tmp/proj",
      launchProcess: vi.fn(async () => ({ method: "detached" as const, pid: 1 })),
      falconEntrypoint: () => ["/usr/bin/node", "/opt/falcon/dist/index.mjs"],
      isAlive,
      killPid,
      sleep: vi.fn(async () => {}),
      now: () => now++,
      stopTimeoutMs: 3,
    });

    expect(result).toEqual({ sessionId: "sess_1" });
    expect(killPid).toHaveBeenCalledWith(999, "SIGKILL");
  });

  it("throws ResumeSessionError and never launches a replacement if the old process survives SIGKILL", async () => {
    const registry = fakeRegistry({ stopSession: vi.fn(() => true), getLivePid: vi.fn(() => 999) });
    const launchProcess = vi.fn(async () => ({ method: "detached" as const, pid: 1 }));
    let now = 0;

    await expect(
      resumeSession("sess_1", {
        registry,
        awaiter: fakeAwaiter(),
        resolveDirectory: () => "/tmp/proj",
        launchProcess,
        falconEntrypoint: () => ["/usr/bin/node", "/opt/falcon/dist/index.mjs"],
        isAlive: () => true, // never dies, even after SIGKILL
        killPid: vi.fn(),
        sleep: vi.fn(async () => {}),
        now: () => now++,
        stopTimeoutMs: 3,
      }),
    ).rejects.toThrow(/would not exit even after SIGKILL/);

    expect(launchProcess).not.toHaveBeenCalled();
  });

  it("throws ResumeSessionError when the daemon has no record of the session at all", async () => {
    await expect(
      resumeSession("sess_unknown", {
        registry: fakeRegistry({ findResumable: vi.fn(() => null) }),
        awaiter: fakeAwaiter(),
        resolveDirectory: () => "/tmp/proj",
      }),
    ).rejects.toThrow(ResumeSessionError);
  });

  it("throws ResumeSessionError when resolveDirectory can't resolve a directory", async () => {
    await expect(
      resumeSession("sess_1", {
        registry: fakeRegistry(),
        awaiter: fakeAwaiter(),
        resolveDirectory: () => null,
      }),
    ).rejects.toThrow(/could not resolve a working directory/);
  });

  it("throws ResumeSessionError when the launch itself fails", async () => {
    await expect(
      resumeSession("sess_1", {
        registry: fakeRegistry(),
        awaiter: fakeAwaiter(),
        resolveDirectory: () => "/tmp/proj",
        launchProcess: vi.fn(async () => {
          throw new Error("ENOENT");
        }),
        falconEntrypoint: () => ["/usr/bin/node", "/opt/falcon/dist/index.mjs"],
      }),
    ).rejects.toThrow(/failed to launch provider process for resume/);
  });

  it("throws ResumeSessionError when the relaunched process never reports back", async () => {
    await expect(
      resumeSession("sess_1", {
        registry: fakeRegistry(),
        awaiter: fakeAwaiter({
          waitFor: vi.fn(async () => {
            throw new Error("timed out");
          }),
        }),
        resolveDirectory: () => "/tmp/proj",
        launchProcess: vi.fn(async () => ({ method: "detached" as const, pid: 1 })),
        falconEntrypoint: () => ["/usr/bin/node", "/opt/falcon/dist/index.mjs"],
      }),
    ).rejects.toThrow(/resume launched \(pid 1, detached\) but/);
  });
});
