import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionRegistry } from "./sessionRegistry.js";
import { persistSession, readPersistedSessions } from "./sessionsStore.js";
import { scanForLiveSessionInDirectory } from "./spawnEngine.js";

const ENCRYPTION = {
  encryptionKey: "wrapped-dek",
  seq: 1,
  metadataVersion: 1,
  agentStateVersion: 1,
};

describe("sessionRegistry", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-session-registry-"));
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

  it("trackSpawned records a spawned pid's directory, queryable via getSessions before any webhook arrives", () => {
    const registry = createSessionRegistry({ homeDir });
    registry.trackSpawned(4242, "/Users/vy/projects/kvy");

    const [tracked] = registry.getSessions();
    expect(tracked).toMatchObject({
      startedBy: "daemon",
      pid: 4242,
      directory: "/Users/vy/projects/kvy",
    });
    // No sessionId yet — the webhook hasn't landed — matching
    // `spawnEngine.ts`'s dedup scan intentionally not matching a
    // pre-webhook entry.
    expect(tracked?.sessionId).toBeUndefined();
  });

  it("a spawned pid's directory survives onSessionStarted's merge once the webhook lands", () => {
    const registry = createSessionRegistry({ homeDir });
    registry.trackSpawned(4242, "/Users/vy/projects/kvy");

    registry.onSessionStarted("sess_1", { title: "x" }, ENCRYPTION, 4242);

    const [tracked] = registry.getSessions();
    expect(tracked).toMatchObject({
      startedBy: "daemon",
      sessionId: "sess_1",
      directory: "/Users/vy/projects/kvy",
    });
  });

  it("a session's spawn directory survives a daemon restart end-to-end, so spawn-dedup matches it again", async () => {
    const realDirectory = "/Users/vy/projects/kvy";

    // --- daemon instance #1: a daemon-spawned session, tracked with its
    //     directory, whose /session-started webhook lands and persists it ---
    const first = createSessionRegistry({ homeDir });
    first.trackSpawned(4242, realDirectory);
    first.onSessionStarted("sess_1", { title: "x" }, ENCRYPTION, 4242);

    // onSessionStarted's persistSession() fires-and-forgets — poll until it lands on
    // disk (with the directory) before we simulate the restart, rather than a fixed
    // delay: a real fs write can take longer than a flat margin under contention.
    const onDisk = await vi.waitFor(async () => {
      const persisted = await readPersistedSessions(homeDir);
      expect(persisted.sess_1?.directory).toBe(realDirectory);
      return persisted;
    });
    expect(onDisk.sess_1?.directory).toBe(realDirectory);

    // --- daemon restart: a BRAND-NEW registry, no shared in-memory state,
    //     restoring purely from sessions.json ---
    const second = createSessionRegistry({ homeDir });
    expect(await second.restore()).toBe(1);

    // (1) the restored resumable record carries the directory...
    const resumable = second.findResumable("sess_1");
    expect(resumable?.directory).toBe(realDirectory);

    // (2) ...and once re-tracked the way an actual `resumeSession` relaunch
    //     does (trackSpawned with the resolved directory, then the relaunched
    //     process's /session-started webhook landing), spawn-directory-dedup
    //     matches the session in that directory again — the whole point of
    //     persisting `directory`. Before this fix the restored session came
    //     back with `directory: undefined` and could never match.
    second.trackSpawned(5555, resumable?.directory);
    second.onSessionStarted("sess_1", { title: "x" }, ENCRYPTION, 5555);
    expect(scanForLiveSessionInDirectory(second.getSessions(), realDirectory)).toBe("sess_1");

    // Let the second registry's own fire-and-forget persist land before teardown.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("persists to sessions.json whenever the webhook carries encryption material", async () => {
    const registry = createSessionRegistry({ homeDir });
    registry.onSessionStarted("sess_1", { title: "x" }, ENCRYPTION, 4242);

    // persistSession() fires-and-forgets (best-effort) — poll until it lands
    // instead of assuming a fixed delay is always enough (flaky under CPU
    // contention, e.g. `turbo` running every package's tests in parallel).
    await vi.waitFor(async () => {
      const persisted = await readPersistedSessions(homeDir);
      expect(persisted.sess_1).toMatchObject({ sessionId: "sess_1", encryption: ENCRYPTION });
    });
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

  it("toPersisted/findResumable carry the live pid through, so a restart can re-adopt it (readoptSessions.ts)", async () => {
    const registry = createSessionRegistry({ homeDir });
    registry.onSessionStarted("sess_1", { title: "x" }, ENCRYPTION, 4242);

    expect(registry.findResumable("sess_1")).toMatchObject({ sessionId: "sess_1", pid: 4242 });

    await vi.waitFor(async () => {
      const persisted = await readPersistedSessions(homeDir);
      expect(persisted.sess_1).toMatchObject({ sessionId: "sess_1", pid: 4242 });
    });
  });

  it("readoptLiveSessions re-adds a still-live orphaned session into the live map after a restart, without dropping the durable resumable record", async () => {
    const realDirectory = "/Users/vy/projects/kvy";

    // --- daemon instance #1: spawns a session, its webhook lands, it persists
    //     with a pid — then the daemon "restarts" without the process dying ---
    const first = createSessionRegistry({ homeDir });
    first.trackSpawned(51245, realDirectory);
    first.onSessionStarted("sess_1", { title: "x" }, ENCRYPTION, 51245);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // --- daemon restart: brand-new registry, restore() only seeds `resumable` ---
    const second = createSessionRegistry({ homeDir });
    expect(await second.restore()).toBe(1);
    expect(second.getSessions()).toEqual([]); // live map starts empty — the bug this fixes

    const readopted = await second.readoptLiveSessions({
      listProcesses: async () => [
        {
          pid: 51245,
          ppid: 1,
          command: "kvy claude --starting-mode remote --started-by daemon",
        },
      ],
      resolveCwd: async () => realDirectory,
      realpath: async (p) => p,
    });

    expect(readopted).toBe(1);
    expect(scanForLiveSessionInDirectory(second.getSessions(), realDirectory)).toBe("sess_1");
    // The re-adopted session is fully live-tracked, not just scannable —
    // getLivePid/stopSession must also see it (design's acceptance checklist).
    expect(second.getLivePid("sess_1")).toBe(51245);
    expect(second.stopSession("sess_1")).toBe(true);
    // The durable resumable record is left in place as a harmless backstop.
    expect(second.findResumable("sess_1")).not.toBeNull();
    expect(second.findResumable("sess_1")?.directory).toBe(realDirectory);
  });

  it("readoptLiveSessions re-adopts nothing when the persisted pid is no longer alive", async () => {
    await persistSession(homeDir, {
      sessionId: "sess_1",
      encryption: ENCRYPTION,
      savedAt: Date.now(),
      directory: "/Users/vy/projects/kvy",
      pid: 99999,
    });
    const registry = createSessionRegistry({ homeDir });
    await registry.restore();

    const readopted = await registry.readoptLiveSessions({
      listProcesses: async () => [],
      resolveCwd: async () => null,
    });

    expect(readopted).toBe(0);
    expect(registry.getSessions()).toEqual([]);
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

  describe("isProviderSessionManaged", () => {
    it("is false for a provider session id this registry has never heard of", () => {
      const registry = createSessionRegistry({ homeDir });
      expect(registry.isProviderSessionManaged("provider-abc")).toBe(false);
    });

    it("is true once a live tracked session's metadata carries that providerSessionId (the re-notify once Claude Code reports it)", () => {
      const registry = createSessionRegistry({ homeDir });
      registry.onSessionStarted(
        "sess_1",
        { title: "x", path: "/tmp/w", providerSessionId: "provider-abc" },
        ENCRYPTION,
        4242,
      );

      expect(registry.isProviderSessionManaged("provider-abc")).toBe(true);
      expect(registry.isProviderSessionManaged("provider-other")).toBe(false);
    });

    it("is false while metadata has not yet been updated with the provider session id (the window before the SessionStart hook fires)", () => {
      const registry = createSessionRegistry({ homeDir });
      registry.onSessionStarted("sess_1", { title: "x", path: "/tmp/w" }, ENCRYPTION, 4242);

      expect(registry.isProviderSessionManaged("provider-abc")).toBe(false);
    });

    it("stays true after the session ends — a durably persisted (resumable) record still counts as managed", () => {
      const registry = createSessionRegistry({ homeDir });
      registry.onSessionStarted(
        "sess_1",
        { title: "x", path: "/tmp/w", providerSessionId: "provider-abc" },
        ENCRYPTION,
        4242,
      );

      registry.pruneDeadSessions(() => false);

      expect(registry.hasLiveSessions()).toBe(false);
      expect(registry.isProviderSessionManaged("provider-abc")).toBe(true);
    });

    it("survives a daemon restart via restore() from sessions.json", async () => {
      const first = createSessionRegistry({ homeDir });
      first.onSessionStarted(
        "sess_1",
        { title: "x", path: "/tmp/w", providerSessionId: "provider-abc" },
        ENCRYPTION,
        4242,
      );

      // persistSession() fires-and-forgets (best-effort) - poll until it lands
      // instead of assuming a fixed delay is always enough (flaky under CPU
      // contention, e.g. `turbo` running every package's tests in parallel).
      await vi.waitFor(async () => {
        const persisted = await readPersistedSessions(homeDir);
        expect(persisted.sess_1).toMatchObject({ sessionId: "sess_1" });
      });

      const second = createSessionRegistry({ homeDir });
      await second.restore();

      expect(second.isProviderSessionManaged("provider-abc")).toBe(true);
    });
  });
});
