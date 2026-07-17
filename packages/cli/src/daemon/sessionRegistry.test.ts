import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionRegistry } from "./sessionRegistry.js";
import { persistSession, readPersistedSessions } from "./sessionsStore.js";

const ENCRYPTION = {
  encryptionKey: "wrapped-dek",
  seq: 1,
  metadataVersion: 1,
  agentStateVersion: 1,
};

describe("sessionRegistry", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-session-registry-"));
  });

  afterEach(async () => {
    // Several tests above trigger `onSessionStarted`'s fire-and-forget
    // `persistSession()` write without awaiting it — by design, that write
    // races this cleanup. `maxRetries`/`retryDelay` (Node's own documented
    // knob for exactly this class of transient `ENOTEMPTY`/`EBUSY` during a
    // recursive `rm`, since a rename can still be landing inside `homeDir`)
    // absorbs that instead of flaking under CPU contention (e.g. `turbo`
    // running every package's tests in parallel).
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("restore() is a no-op count of 0 when sessions.json doesn't exist", async () => {
    const registry = createSessionRegistry({ homeDir });
    expect(await registry.restore()).toBe(0);
  });

  it("restore() loads a prior daemon's persisted sessions into the resumable set", async () => {
    await persistSession(homeDir, {
      sessionId: "sess_1",
      encryption: ENCRYPTION,
      savedAt: Date.now(),
    });

    const registry = createSessionRegistry({ homeDir });
    expect(await registry.restore()).toBe(1);
    expect(registry.findResumable("sess_1")).toMatchObject({ sessionId: "sess_1" });
    expect(registry.findResumable("sess_unknown")).toBeNull();
  });

  it("onSessionStarted tracks a pid-carrying webhook and surfaces it via getSessions", () => {
    const registry = createSessionRegistry({ homeDir });

    registry.onSessionStarted("sess_1", { title: "x" }, ENCRYPTION, 4242);

    expect(registry.getSessions()).toEqual([
      {
        startedBy: "terminal",
        sessionId: "sess_1",
        metadata: { title: "x" },
        encryption: ENCRYPTION,
        pid: 4242,
      },
    ]);
  });

  it("onSessionStarted merges into a pid the registry was told about via trackSpawned (daemon-spawned)", () => {
    const registry = createSessionRegistry({ homeDir });
    registry.trackSpawned(4242);

    registry.onSessionStarted("sess_1", { title: "x" }, ENCRYPTION, 4242);

    const [tracked] = registry.getSessions();
    expect(tracked?.startedBy).toBe("daemon");
    expect(tracked?.sessionId).toBe("sess_1");
  });

  it("persists to sessions.json whenever the webhook carries encryption material", async () => {
    const registry = createSessionRegistry({ homeDir });
    registry.onSessionStarted("sess_1", { title: "x" }, ENCRYPTION, 4242);

    // persistSession() fires-and-forgets (best-effort) — poll briefly instead
    // of assuming synchronous completion.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const persisted = await readPersistedSessions(homeDir);
    expect(persisted.sess_1).toMatchObject({ sessionId: "sess_1", encryption: ENCRYPTION });
  });

  it("does not persist when the webhook carries no encryption material", async () => {
    const registry = createSessionRegistry({ homeDir });
    registry.onSessionStarted("sess_1", { title: "x" }, undefined, 4242);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readPersistedSessions(homeDir)).toEqual({});
  });

  it("a fresh onSessionStarted for a sessionId clears any stale resumable record for it", async () => {
    await persistSession(homeDir, {
      sessionId: "sess_1",
      encryption: ENCRYPTION,
      savedAt: Date.now(),
    });
    const registry = createSessionRegistry({ homeDir });
    await registry.restore();
    expect(registry.findResumable("sess_1")).not.toBeNull();

    registry.onSessionStarted("sess_1", {}, ENCRYPTION, 9999);

    // Now live-tracked (via getSessions), not shadowed by the stale durable entry.
    expect(registry.getSessions()).toHaveLength(1);
    // Let the fire-and-forget persistSession() this triggers land before the
    // temp dir gets torn down in afterEach.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("stopSession sends SIGTERM to the live pid and returns true; false for an unknown sessionId", () => {
    const killPid = vi.fn();
    const registry = createSessionRegistry({ homeDir, killPid });
    registry.onSessionStarted("sess_1", {}, ENCRYPTION, 4242);

    expect(registry.stopSession("sess_1")).toBe(true);
    expect(killPid).toHaveBeenCalledExactlyOnceWith(4242, "SIGTERM");
    expect(registry.stopSession("sess_missing")).toBe(false);
  });

  it("findResumable prefers a still-live tracked session over a stale durable record", async () => {
    await persistSession(homeDir, {
      sessionId: "sess_1",
      encryption: { ...ENCRYPTION, seq: 1 },
      savedAt: Date.now(),
    });
    const registry = createSessionRegistry({ homeDir });
    await registry.restore();

    registry.onSessionStarted("sess_1", {}, { ...ENCRYPTION, seq: 99 }, 5555);

    expect(registry.findResumable("sess_1")?.encryption.seq).toBe(99);
    // Let the fire-and-forget persistSession() this triggers land before the
    // temp dir gets torn down in afterEach.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("pruneDeadSessions moves an encrypted session into the resumable set and drops the pid tracking", () => {
    const registry = createSessionRegistry({ homeDir });
    registry.onSessionStarted("sess_1", {}, ENCRYPTION, 4242);
    expect(registry.hasLiveSessions()).toBe(true);

    registry.pruneDeadSessions(() => false);

    expect(registry.hasLiveSessions()).toBe(false);
    expect(registry.getSessions()).toEqual([]);
    expect(registry.findResumable("sess_1")).toMatchObject({ sessionId: "sess_1" });
  });

  it("pruneDeadSessions drops a dead pid outright when it has no encryption material to keep", () => {
    const registry = createSessionRegistry({ homeDir });
    registry.trackSpawned(4242); // no /session-started webhook ever arrived

    registry.pruneDeadSessions(() => false);

    expect(registry.getSessions()).toEqual([]);
    expect(registry.findResumable("sess_1")).toBeNull();
  });

  it("pruneDeadSessions leaves still-alive pids untouched", () => {
    const registry = createSessionRegistry({ homeDir });
    registry.onSessionStarted("sess_1", {}, ENCRYPTION, 4242);

    registry.pruneDeadSessions(() => true);

    expect(registry.hasLiveSessions()).toBe(true);
    expect(registry.getSessions()).toHaveLength(1);
  });

  it("hasLiveSessions reflects the pid-tracked map only, not the resumable set", async () => {
    await persistSession(homeDir, {
      sessionId: "sess_1",
      encryption: ENCRYPTION,
      savedAt: Date.now(),
    });
    const registry = createSessionRegistry({ homeDir });
    await registry.restore();

    expect(registry.hasLiveSessions()).toBe(false);
  });
});
