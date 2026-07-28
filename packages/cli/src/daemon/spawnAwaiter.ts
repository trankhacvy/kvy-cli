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
 * A spawn that never reports back within `timeoutMs` (default 15s) rejects
 * rather than hanging the RPC forever.
 *
 * A3/A4 (docs/known-issues.md — "generic 15s timeout masks the real failure
 * reason"): the flat timeout used to be the ONLY way this ever rejected, so
 * a child that crashed in the first 200ms (e.g. a 429 session-quota
 * rejection from `POST /v1/sessions`) still made the caller wait out the
 * full 15s and then got the same generic "did not report back" message any
 * hung-but-still-running process would produce. Two independent signals now
 * shortcut that:
 *
 *   1. `waitFor`'s optional `watchExit` (`processLauncher.ts`'s
 *      `ProcessExitWatcher` — a real Node `"exit"` event for a detached
 *      spawn, a liveness poll for a tmux pane process) rejects immediately,
 *      with a message that says the process died rather than merely timed
 *      out, the moment the child is observed to have exited before ever
 *      reporting.
 *   2. `reject(pid, error)` — the control server's new `/session-start-failed`
 *      webhook (chosen approach (a) from the spec: a best-effort, never-
 *      throwing self-report from the child itself, mirroring
 *      `notify.ts`'s existing pattern) — lets the child hand back its OWN
 *      observed error (e.g. the real 429 quota message) before it exits, so
 *      the daemon doesn't have to guess. When both signals are wired for the
 *      same failure, whichever arrives first wins (`reject` racing the exit
 *      watcher): a `/session-start-failed` webhook typically arrives first
 *      (fired before the child's own process.exit()), giving the more
 *      specific message; if that best-effort report is lost for any reason,
 *      the exit-watcher fallback still fires promptly with a less specific
 *      but still honest "process exited before reporting" message instead
 *      of silently falling through to the 15s timeout.
 */
import type { ProcessExitWatcher, SessionEncryptionData } from "./types.js";

export interface SessionStartedEvent {
  sessionId: string;
  metadata?: unknown;
  encryption?: SessionEncryptionData;
  pid: number;
}

export interface WaitForOptions {
  /**
   * Notifies `waitFor` the instant the spawned process is observed to have
   * exited, so a fast, known failure (crash, bad exec, quota rejection) can
   * reject well before `timeoutMs` instead of always waiting out the full
   * timer (A3). Optional — a caller with no way to observe the child's exit
   * (shouldn't happen in practice; `processLauncher.ts` always supplies one)
   * simply falls back to the existing flat-timeout behavior.
   */
  watchExit?: ProcessExitWatcher;
}

export interface SpawnAwaiter {
  /**
   * Resolves once `pid` self-reports via `/session-started`. Rejects in one
   * of three ways: `reject(pid, error)` was called with the child's own
   * observed failure (A4, fastest + most specific); `watchExit` reported the
   * process exiting before either resolve/reject happened (A3, fast but
   * generic); or the full `timeoutMs` elapsed with the process apparently
   * still running (the original, unchanged "hung/slow" case).
   */
  waitFor(pid: number, options?: WaitForOptions): Promise<SessionStartedEvent>;
  /** Feeds a `/session-started` webhook event in. Returns whether a waiter for `event.pid` existed. */
  resolve(event: SessionStartedEvent): boolean;
  /**
   * Feeds a `/session-start-failed` webhook event in (A4) — the child's own
   * best-effort report of why `bootstrapSession()` (or any other
   * pre-report step) failed. Returns whether a waiter for `pid` existed.
   */
  reject(pid: number, error: string): boolean;
}

interface PendingWaiter {
  resolve: (event: SessionStartedEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  unwatchExit?: () => void;
}

export const DEFAULT_SPAWN_AWAITER_TIMEOUT_MS = 15_000;

export function createSpawnAwaiter(opts: { timeoutMs?: number } = {}): SpawnAwaiter {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SPAWN_AWAITER_TIMEOUT_MS;
  const pending = new Map<number, PendingWaiter>();

  return {
    waitFor(pid: number, options: WaitForOptions = {}): Promise<SessionStartedEvent> {
      return new Promise((resolvePromise, rejectPromise) => {
        const settle = (fn: () => void): void => {
          pending.delete(pid);
          waiter.unwatchExit?.();
          fn();
        };

        const timer = setTimeout(() => {
          settle(() =>
            rejectPromise(
              new Error(
                `spawned process (pid ${pid}) did not report back via /session-started within ${timeoutMs}ms`,
              ),
            ),
          );
        }, timeoutMs);
        timer.unref?.();

        const waiter: PendingWaiter = {
          resolve: (event) => {
            clearTimeout(timer);
            settle(() => resolvePromise(event));
          },
          reject: (error) => {
            clearTimeout(timer);
            settle(() => rejectPromise(error));
          },
          timer,
        };
        pending.set(pid, waiter);

        if (options.watchExit) {
          waiter.unwatchExit = options.watchExit((info) => {
            // A3: the process is gone and never resolved/rejected this
            // waiter itself — that's a fast, honest "died before reporting"
            // rather than the generic timeout message. If `reject(pid, ...)`
            // (A4's more specific child self-report) already settled this
            // waiter, `pending.get(pid)` below no longer finds it and this
            // is a no-op — the specific message always wins the race.
            if (pending.get(pid) !== waiter) return;
            clearTimeout(timer);
            const detail =
              info.code !== null || info.signal !== null
                ? ` (exit code ${info.code ?? "unknown"}${info.signal ? `, signal ${info.signal}` : ""})`
                : "";
            settle(() =>
              rejectPromise(
                new Error(
                  `spawned process (pid ${pid}) exited before it reported starting${detail}`,
                ),
              ),
            );
          });
        }
      });
    },

    resolve(event: SessionStartedEvent): boolean {
      const waiter = pending.get(event.pid);
      if (!waiter) return false;
      waiter.resolve(event);
      return true;
    },

    reject(pid: number, error: string): boolean {
      const waiter = pending.get(pid);
      if (!waiter) return false;
      waiter.reject(new Error(`spawned process (pid ${pid}) reported a startup failure: ${error}`));
      return true;
    },
  };
}
