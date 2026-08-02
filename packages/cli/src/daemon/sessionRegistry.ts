/**
 * The daemon's `pid → TrackedSession` bookkeeping.
 *
 * Three responsibilities:
 * - `getSessions()` / `stopSession()` — live, pid-tracked half.
 * - `onSessionStarted()` — webhook handler: updates the live map and persists
 *   encryption material to `sessions.json` so resume survives daemon restarts.
 * - `findResumable()` / `restore()` — durable half seeded from disk at boot.
 */
import type { Logger } from "../logger.js";
import { findLiveOrphanedSessions, type ReadoptProbeDeps } from "./readoptSessions.js";
import { type PersistedSession, persistSession, readPersistedSessions } from "./sessionsStore.js";
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
  /**
   * After restore(), re-adopts any resumable session whose process is still
   * alive (verified, not recycled) into the live pid map, so spawn-directory-
   * dedup, stopSession, and findResumable see it without waiting for an
   * explicit resumeSession RPC. Returns how many were re-adopted. Call once at
   * boot, right after restore().
   */
  readoptLiveSessions(probe: ReadoptProbeDeps): Promise<number>;
  /**
   * Registers a pid this daemon just spawned, ahead of its `/session-started`
   * webhook — lets `onSessionStarted` recognize it as the same session rather
   * than a fresh terminal-started one. `directory` is omitted for `resumeSession`
   * relaunches, which re-track an existing session rather than establishing a new
   * directory fact.
   */
  trackSpawned(pid: number, directory?: string): void;
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
   * "prunes dead session pids via `kill(pid,0)`"). Anything with encryption
   * material graduates into the resumable set first — a crashed session
   * must still be resumable, not just forgotten.
   */
  pruneDeadSessions(isAlive: (pid: number) => boolean): void;
  /** `true` while at least one pid-tracked session is still live — the self-update heartbeat's "restart when idle" gate (`selfUpdate.ts`). */
  hasLiveSessions(): boolean;
  /**
   * True if `providerSessionId` (a Claude Code/Codex transcript's own id —
   * the JSONL filename) is already tracked, live or durably persisted, as
   * one of THIS daemon's own Kvy-managed sessions — `transcriptIndexer.ts`'s
   * session's own local transcript must never be independently re-surfaced
   * as "unmanaged" while (or after) Kvy is already managing it. Checks
   * both `pidToSession` (live) and `resumable` (ended-but-still-tracked, and
   * whatever `restore()` reloaded from `sessions.json`) so a session that
   * already exited is still recognized. `providerSessionId` only ever
   * reaches this registry via `onSessionStarted`'s `metadata` payload
   * (`commands/start.ts` re-notifies once the real provider session id is
   * known) — a terminal session's first self-report never carries one yet.
   */
  isProviderSessionManaged(providerSessionId: string): boolean;
}

/**
 * `TrackedSession`/`PersistedSession.metadata` is `unknown` by design (an
 * opaque local, plaintext payload — see `types.ts`'s own doc comment); this
 * pulls out the one field `isProviderSessionManaged` needs, tolerating any
 * shape (including the common case of no `providerSessionId` at all yet).
 */
function extractProviderSessionId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).providerSessionId;
  return typeof value === "string" && value.length > 0 ? value : null;
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
      // Carried through so spawn-directory-dedup survives a daemon restart
      // from disk and re-tracked by a `resumeSession` relaunch keeps the
      // directory `scanForLiveSessionInDirectory` matches against.
      directory: session.directory,
      // Persisted so a future daemon boot can re-adopt this session if its
      // process outlives the restart (`readoptSessions.ts`,
      // `readoptLiveSessions` below) — `TrackedSession.pid` is always set.
      pid: session.pid,
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

    async readoptLiveSessions(probe) {
      const candidates = await findLiveOrphanedSessions(Object.fromEntries(resumable), probe);
      for (const { session, pid } of candidates) {
        pidToSession.set(pid, {
          startedBy: "daemon",
          pid,
          sessionId: session.sessionId,
          provider: session.provider,
          metadata: session.metadata,
          encryption: session.encryption,
          directory: session.directory,
        });
        logger.info("[session-registry] re-adopted live orphaned session after restart", {
          sessionId: session.sessionId,
          pid,
          directory: session.directory,
        });
      }
      return candidates.length;
    },

    trackSpawned(pid, directory) {
      pidToSession.set(pid, { startedBy: "daemon", pid, directory });
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
          directory: live.directory,
          pid: live.pid,
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

    isProviderSessionManaged(providerSessionId) {
      for (const session of pidToSession.values()) {
        if (extractProviderSessionId(session.metadata) === providerSessionId) return true;
      }
      for (const session of resumable.values()) {
        if (extractProviderSessionId(session.metadata) === providerSessionId) return true;
      }
      return false;
    },
  };
}
