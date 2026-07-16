/**
 * Session registry — the daemon's `pid → TrackedSession` bookkeeping
 * (design §8: "Session registry: pid → TrackedSession; spawn↔self-report
 * matched by pid with 15 s awaiter; finished sessions persisted to
 * `sessions.json` including wrapped DEK + seq + versions so resume survives
 * daemon restarts"; plan.md §16 "3.2 Durability"). Adapted from Happy's
 * inline `pidToTrackedSession`/`sessionIdToFinishedSession` maps in
 * `daemon/run.ts` (https://github.com/slopus/happy, MIT), pulled out into
 * its own injectable module here rather than left inline, so `commands.ts`
 * and this module's own tests don't have to stand up a whole
 * `runDaemonStartSync` to exercise it.
 *
 * Three responsibilities, matching `controlServer.ts`'s injected callback
 * shapes exactly (no adapter needed — same "structural fit" seam already
 * used elsewhere in this codebase):
 *
 *  - `getSessions()` / `stopSession()` — the live, pid-tracked half, fed
 *    straight into `ControlServerDeps`.
 *  - `onSessionStarted()` — the `/session-started` webhook handler: updates
 *    the live map and, whenever the report carries encryption material,
 *    persists it to `sessions.json` (`sessionsStore.ts`) so it survives a
 *    daemon crash.
 *  - `findResumable()` / `restore()` — the durable half: what `resumeSession`
 *    (`resumeSession.ts`) looks a session up by id against, seeded from disk
 *    once at boot and kept current as live sessions die (`pruneDeadSessions`).
 */
import type { Logger } from "../logger.js";
import {
  type PersistedSession,
  persistSession,
  readPersistedSessions,
} from "./sessionsStore.js";
import type { SessionEncryptionData, TrackedSession } from "./types.js";

export interface SessionRegistryDeps {
  homeDir: string;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Sends `signal` to `pid`; swallows ESRCH (already gone). Injectable for tests. */
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  logger?: Logger;
}

export interface SessionRegistry {
  /** Loads not-yet-expired `sessions.json` entries into the resumable set. Call once at daemon boot, before serving any RPC. Returns how many were restored. */
  restore(): Promise<number>;
  /** Registers a pid this daemon just spawned, ahead of its `/session-started` webhook arriving — lets `onSessionStarted` recognize it as the same session rather than a fresh terminal-started one. */
  trackSpawned(pid: number): void;
  /** The `/session-started` webhook handler (`ControlServerDeps.onSessionStarted`'s exact shape). */
  onSessionStarted(
    sessionId: string,
    metadata: unknown,
    encryption?: SessionEncryptionData,
    pid?: number,
  ): void;
  /** `ControlServerDeps.getSessions` — every currently live, pid-tracked session. */
  getSessions(): TrackedSession[];
  /** `ControlServerDeps.stopSession` — SIGTERM by sessionId; `true` iff a live match was found and signalled. */
  stopSession(sessionId: string): boolean;
  /**
   * The pid currently tracked live for `sessionId`, or `null` if none.
   * `resumeSession.ts` uses this ahead of (and to poll after) `stopSession`
   * to confirm the old process has actually exited before relaunching —
   * `stopSession` only sends SIGTERM and doesn't remove the pid from the
   * live map until the next `pruneDeadSessions` sweep, so the pid stays
   * resolvable for polling in the meantime.
   */
  getLivePid(sessionId: string): number | null;
  /** A session resumable right now — live-tracked (if it still carries encryption data) or from the durable set — or `null` if this daemon has no record of it at all. */
  findResumable(sessionId: string): PersistedSession | null;
  /**
   * Sweeps the live map for pids that are no longer alive (design §8:
   * "prunes dead session pids via `kill(pid,0)`"). Anything with encryption
   * material graduates into the resumable set first — a crashed session
   * must still be resumable, not just forgotten.
   */
  pruneDeadSessions(isAlive: (pid: number) => boolean): void;
  /** `true` while at least one pid-tracked session is still live — the self-update heartbeat's "restart when idle" gate (`selfUpdate.ts`). */
  hasLiveSessions(): boolean;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export function createSessionRegistry(deps: SessionRegistryDeps): SessionRegistry {
  const { homeDir } = deps;
  const now = deps.now ?? Date.now;
  const killPid = deps.killPid ?? defaultKillPid;
  const logger = deps.logger ?? noopLogger;

  const pidToSession = new Map<number, TrackedSession>();
  const resumable = new Map<string, PersistedSession>();

  function toPersisted(session: TrackedSession): PersistedSession | null {
    if (!session.sessionId || !session.encryption) return null;
    return {
      sessionId: session.sessionId,
      provider: session.provider,
      encryption: session.encryption,
      metadata: session.metadata,
      savedAt: now(),
    };
  }

  return {
    async restore() {
      const persisted = await readPersistedSessions(homeDir, now);
      for (const [id, session] of Object.entries(persisted)) {
        resumable.set(id, session);
      }
      logger.info("[session-registry] restored persisted sessions", { count: resumable.size });
      return resumable.size;
    },

    trackSpawned(pid) {
      pidToSession.set(pid, { startedBy: "daemon", pid });
    },

    onSessionStarted(sessionId, metadata, encryption, pid) {
      const existing = pid !== undefined ? pidToSession.get(pid) : undefined;

      const tracked: TrackedSession = existing
        ? { ...existing, sessionId, metadata, encryption }
        : { startedBy: "terminal", sessionId, metadata, encryption, pid: pid ?? 0 };

      if (pid !== undefined) pidToSession.set(pid, tracked);

      // A (re)started session's pid supersedes whatever the durable set
      // remembers for this sessionId — otherwise a stale `sessions.json`
      // entry could shadow the live one in `findResumable` forever.
      resumable.delete(sessionId);

      if (encryption) {
        const persisted = toPersisted(tracked);
        if (persisted) {
          persistSession(homeDir, persisted).catch((error: unknown) => {
            logger.warn("[session-registry] failed to persist session", {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }

      logger.debug("[session-registry] session started", { sessionId, pid });
    },

    getSessions() {
      return [...pidToSession.values()];
    },

    stopSession(sessionId) {
      for (const [pid, session] of pidToSession) {
        if (session.sessionId !== sessionId) continue;
        killPid(pid, "SIGTERM");
        return true;
      }
      return false;
    },

    getLivePid(sessionId) {
      for (const [pid, session] of pidToSession) {
        if (session.sessionId === sessionId) return pid;
      }
      return null;
    },

    findResumable(sessionId) {
      const live = [...pidToSession.values()].find((s) => s.sessionId === sessionId);
      if (live?.encryption) {
        return {
          sessionId,
          provider: live.provider,
          encryption: live.encryption,
          metadata: live.metadata,
          savedAt: now(),
        };
      }
      return resumable.get(sessionId) ?? null;
    },

    pruneDeadSessions(isAlive) {
      for (const [pid, session] of pidToSession) {
        if (isAlive(pid)) continue;
        pidToSession.delete(pid);
        const persisted = toPersisted(session);
        if (persisted) {
          resumable.set(persisted.sessionId, persisted);
          logger.debug("[session-registry] pruned dead session, kept resumable", {
            pid,
            sessionId: persisted.sessionId,
          });
        } else {
          logger.debug("[session-registry] pruned dead session (no resume data)", { pid });
        }
      }
    },

    hasLiveSessions() {
      return pidToSession.size > 0;
    },
  };
}
