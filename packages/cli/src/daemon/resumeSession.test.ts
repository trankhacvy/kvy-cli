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
    expect(registry.trackSpawned).toHaveBeenCalledExactlyOnceWith(555);
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
    const registry = fakeRegistry({ stopSession: vi.fn(() => true) });

    await resumeSession("sess_1", {
      registry,
      awaiter: fakeAwaiter(),
      resolveDirectory: () => "/tmp/proj",
      launchProcess: vi.fn(async () => ({ method: "detached" as const, pid: 1 })),
      falconEntrypoint: () => ["/usr/bin/node", "/opt/falcon/dist/index.mjs"],
    });

    expect(registry.stopSession).toHaveBeenCalledExactlyOnceWith("sess_1");
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
