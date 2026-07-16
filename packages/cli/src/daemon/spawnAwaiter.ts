/**
 * Spawn↔webhook matching by pid (plan.md §16 "3.1 Remote spawn": "spawn↔
 * webhook matching by PID with a 15s awaiter").
 *
 * The daemon can't know a spawned session's `sessionId` at spawn time — the
 * spawned `falcon <provider>` process mints/resumes its own session and only
 * reports the id back once it's ready, via the control server's
 * `/session-started` webhook (`controlServer.ts`). This module bridges that
 * gap: `spawnEngine.ts` calls `waitFor(pid)` right after launching the child
 * and blocks on it; whoever owns the control server's `onSessionStarted`
 * callback calls `resolve({ ..., pid })` once the webhook arrives, using the
 * pid the session reports as the correlation key (design's spawn RPC has no
 * other way to tie the two together before the sessionId exists).
 *
 * A spawn that never reports back within `timeoutMs` (default 15s — the
 * process crashed before starting, hung on startup, or matched the wrong pid
 * some other way) rejects rather than hanging the RPC forever.
 */
import type { SessionEncryptionData } from "./types.js";

export interface SessionStartedEvent {
  sessionId: string;
  metadata?: unknown;
  encryption?: SessionEncryptionData;
  pid: number;
}

export interface SpawnAwaiter {
  /** Resolves once pid self-reports via `/session-started`, or rejects after the configured timeout. */
  waitFor(pid: number): Promise<SessionStartedEvent>;
  /** Feeds a `/session-started` webhook event in. Returns whether a waiter for `event.pid` existed. */
  resolve(event: SessionStartedEvent): boolean;
}

interface PendingWaiter {
  resolve: (event: SessionStartedEvent) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const DEFAULT_SPAWN_AWAITER_TIMEOUT_MS = 15_000;

export function createSpawnAwaiter(opts: { timeoutMs?: number } = {}): SpawnAwaiter {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SPAWN_AWAITER_TIMEOUT_MS;
  const pending = new Map<number, PendingWaiter>();

  return {
    waitFor(pid: number): Promise<SessionStartedEvent> {
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(pid);
          rejectPromise(
            new Error(
              `spawned process (pid ${pid}) did not report back via /session-started within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();

        pending.set(pid, {
          resolve: (event) => {
            clearTimeout(timer);
            resolvePromise(event);
          },
          timer,
        });
      });
    },

    resolve(event: SessionStartedEvent): boolean {
      const waiter = pending.get(event.pid);
      if (!waiter) return false;
      pending.delete(event.pid);
      waiter.resolve(event);
      return true;
    },
  };
}
