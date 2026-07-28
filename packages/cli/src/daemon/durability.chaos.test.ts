/**
 * Chaos test suite for daemon durability (plan.md §16 "3.2 Durability":
 * "Chaos test suite: kill daemon mid-turn, kill session process, sleep/wake,
 * server restart — all recover per failure matrix"; falcon-system-design.md
 * §11's Failure Modes & Recovery Matrix).
 *
 * This is a package-local integration suite (`packages/cli/src/daemon/`),
 * not a standalone `e2e/` package — the design's `e2e/` tree (§2's repo
 * layout) is reserved for the full scripted-agent conformance harness, which
 * doesn't exist yet either; nothing in this codebase stands that up yet, so
 * inventing the workspace/build wiring for it here would be scope creep for
 * a durability task. Instead this exercises the real, wired-together
 * modules (`sessionRegistry.ts`, `sessionsStore.ts`, `resumeSession.ts`)
 * against fully injected process/spawn fakes — no real subprocesses, no
 * real `ps` calls, no real network — the same "deterministic, fully
 * injected deps" style every other test file in this package already uses.
 *
 * Each scenario below is one row of the design's failure matrix, scoped to
 * exactly what this task's durability primitives are responsible for
 * recovering (the session-registry/`sessions.json` half — not the control
 * server's HTTP transport, which `commands.test.ts`/`controlServer.test.ts`
 * already cover, and not the CLI-side outbox/reconnect logic, which is a
 * separate module).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeSession } from "./resumeSession.js";
import { createSessionRegistry } from "./sessionRegistry.js";
import { type PersistedSession, readPersistedSessions } from "./sessionsStore.js";
import type { SpawnAwaiter } from "./spawnAwaiter.js";

const ENCRYPTION = {
  encryptionKey: "wrapped-dek-v1",
  seq: 7,
  metadataVersion: 2,
  agentStateVersion: 1,
};

function fakeAwaiter(sessionId: string): SpawnAwaiter {
  return {
    waitFor: vi.fn(async (pid: number) => ({ sessionId, pid })),
    resolve: vi.fn(() => true),
    reject: vi.fn(() => true),
  };
}

/**
 * `onSessionStarted`'s `persistSession()` call is intentionally
 * fire-and-forget (the webhook handler responds before the disk write
 * lands — see `sessionRegistry.ts`). A fixed `setTimeout` guess at how long
 * that write takes is inherently racy: it passed reliably in isolation but
 * flaked under `turbo`'s parallel test execution (real CPU contention
 * pushing the write past a 20ms guess), producing `restoredCount === 0` and
 * "not tracked" failures below. Poll the actual on-disk state instead of
 * guessing a delay.
 */
async function waitForPersisted(
  homeDir: string,
  predicate: (persisted: Record<string, PersistedSession>) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const persisted = await readPersistedSessions(homeDir);
    if (predicate(persisted)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for sessions.json to reflect the expected state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("chaos: daemon durability recovery (failure matrix, design §11)", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-chaos-durability-"));
  });

  afterEach(async () => {
    // Same fire-and-forget-write-vs-cleanup race `sessionRegistry.test.ts`
    // guards against — retry instead of flaking on a transient `ENOTEMPTY`.
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("kill daemon mid-turn: a brand new daemon process rebuilds the session from sessions.json alone", async () => {
    // --- "Before": the original daemon process, mid-turn ---
    const daemon1 = createSessionRegistry({ homeDir });
    daemon1.onSessionStarted("sess_1", { path: "/tmp/proj" }, ENCRYPTION, 4242);
    // Wait for the fire-and-forget persistSession() call inside
    // onSessionStarted to actually land on disk before the "crash".
    await waitForPersisted(homeDir, (p) => p.sess_1 !== undefined);

    // --- The daemon process is killed outright: no graceful shutdown, no
    // clearDaemonState, no chance for daemon1 to do anything else. A
    // brand-new process (daemon2) starts up against the same homeDir. ---
    const daemon2 = createSessionRegistry({ homeDir });
    const restoredCount = await daemon2.restore();

    expect(restoredCount).toBe(1);
    expect(daemon2.findResumable("sess_1")).toMatchObject({
      sessionId: "sess_1",
      encryption: ENCRYPTION,
    });
    // Recovery is purely a function of what's on disk — the crashed
    // process's own in-memory state (daemon1) never gets consulted, and
    // never needs to be, for daemon2 to know this session is resumable.
  });

  it("kill session process: a dead pid with encryption material graduates to resumable, not lost", () => {
    const registry = createSessionRegistry({ homeDir });
    registry.onSessionStarted("sess_1", { path: "/tmp/proj" }, ENCRYPTION, 4242);
    expect(registry.hasLiveSessions()).toBe(true);

    // The session process itself is killed (SIGKILL, OOM, whatever) — the
    // daemon's own heartbeat is what notices, via a plain kill(pid,0) probe.
    registry.pruneDeadSessions((pid) => pid !== 4242);

    expect(registry.hasLiveSessions()).toBe(false);
    expect(registry.getSessions()).toEqual([]);
    expect(registry.findResumable("sess_1")).toMatchObject({ sessionId: "sess_1" });
  });

  it("sleep/wake: repeated heartbeat ticks across a suspend never spuriously drop a still-alive session", () => {
    const registry = createSessionRegistry({ homeDir });
    registry.onSessionStarted("sess_1", { path: "/tmp/proj" }, ENCRYPTION, 4242);

    // The laptop sleeps; the heartbeat interval still fires a handful of
    // times once it wakes (setInterval doesn't neatly pause) — the pid is
    // still alive throughout (the process was merely suspended, not killed).
    for (let tick = 0; tick < 5; tick++) {
      registry.pruneDeadSessions(() => true);
    }

    expect(registry.hasLiveSessions()).toBe(true);
    expect(registry.getSessions()).toEqual([
      expect.objectContaining({ sessionId: "sess_1", pid: 4242 }),
    ]);
  });

  it("server restart: local resume works purely off sessions.json — no network dependency at all", async () => {
    const registry = createSessionRegistry({ homeDir });
    registry.onSessionStarted("sess_1", { path: "/tmp/proj" }, ENCRYPTION, 4242);
    await waitForPersisted(homeDir, (p) => p.sess_1 !== undefined);
    registry.pruneDeadSessions(() => false); // the process died along with (or independent of) the server outage

    // A fresh daemon boots — this never touches a server URL, a fetch impl,
    // or any credential; it's restore() (disk) + resumeSession() (spawn a
    // local process) end to end.
    const freshDaemon = createSessionRegistry({ homeDir });
    await freshDaemon.restore();

    const launchProcess = vi.fn(async () => ({
      method: "detached" as const,
      pid: 7777,
      watchExit: () => () => {},
    }));
    const result = await resumeSession("sess_1", {
      registry: freshDaemon,
      awaiter: fakeAwaiter("sess_1"),
      resolveDirectory: (session) =>
        typeof session.metadata === "object" &&
        session.metadata !== null &&
        "path" in session.metadata
          ? String((session.metadata as { path: unknown }).path)
          : null,
      launchProcess,
      falconEntrypoint: () => ["/usr/bin/node", "/opt/falcon/dist/index.mjs"],
      baseEnv: {},
    });

    expect(result).toEqual({ sessionId: "sess_1" });
    expect(launchProcess).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cwd: "/tmp/proj",
        env: expect.objectContaining({
          FALCON_RECONNECT_SESSION_ID: "sess_1",
          FALCON_RECONNECT_ENCRYPTION_KEY: ENCRYPTION.encryptionKey,
          FALCON_RECONNECT_SEQ: String(ENCRYPTION.seq),
        }),
      }),
      undefined,
    );
    // The relaunched pid is now the one this daemon instance tracks live.
    expect(freshDaemon.getSessions()).toEqual([
      expect.objectContaining({ pid: 7777, startedBy: "daemon" }),
    ]);
  });

  it("end-to-end: crash -> restart -> resume leaves exactly one durable record, not a duplicate", async () => {
    const original = createSessionRegistry({ homeDir });
    original.onSessionStarted("sess_1", { path: "/tmp/proj" }, ENCRYPTION, 100);
    await waitForPersisted(homeDir, (p) => p.sess_1 !== undefined);

    const restarted = createSessionRegistry({ homeDir });
    await restarted.restore();

    await resumeSession("sess_1", {
      registry: restarted,
      awaiter: fakeAwaiter("sess_1"),
      resolveDirectory: () => "/tmp/proj",
      launchProcess: vi.fn(async () => ({
        method: "detached" as const,
        pid: 200,
        watchExit: () => () => {},
      })),
      falconEntrypoint: () => ["/usr/bin/node", "/opt/falcon/dist/index.mjs"],
    });

    // The resumed process reports back exactly like any other session start.
    restarted.onSessionStarted("sess_1", { path: "/tmp/proj" }, { ...ENCRYPTION, seq: 8 }, 200);
    await waitForPersisted(homeDir, (p) => p.sess_1?.encryption.seq === 8);

    const persisted = await readPersistedSessions(homeDir);
    expect(Object.keys(persisted)).toEqual(["sess_1"]);
    expect(persisted.sess_1?.encryption.seq).toBe(8);
  });
});
