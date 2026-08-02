import type { ProcessExitWatcher, SessionEncryptionData } from "./types.js";

export interface SessionStartedEvent {
  sessionId: string;
  metadata?: unknown;
  encryption?: SessionEncryptionData;
  pid: number;
}

export interface WaitForOptions {
  /**
   * Notifies `waitFor` the instant the spawned process exits, so a fast,
   * known failure can reject well before `timeoutMs`. Optional — callers
   * without an exit observer fall back to the flat-timeout behavior.
   */
  watchExit?: ProcessExitWatcher;
}

export interface SpawnAwaiter {
  /**
   * Resolves once `pid` self-reports via `/session-started`. Rejects in one
   * of three ways: `reject(pid, error)` was called with the child's own
   * observed failure (fastest + most specific); `watchExit` reported the
   * process exiting before either resolve/reject happened (fast but generic);
   * or the full `timeoutMs` elapsed with the process apparently still running.
   */
  waitFor(pid: number, options?: WaitForOptions): Promise<SessionStartedEvent>;
  /** Feeds a `/session-started` webhook event in. Returns whether a waiter for `event.pid` existed. */
  resolve(event: SessionStartedEvent): boolean;
  /**
   * Feeds a `/session-start-failed` webhook event in — the child's own
   * best-effort report of why it failed. Returns whether a waiter for `pid` existed.
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
            // Process exited before reporting — fast rejection instead of
            // waiting out the timeout. If `reject(pid, ...)` already settled
            // this waiter, it's been removed from `pending` and this is a no-op
            // — the more specific child self-report always wins the race.
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
