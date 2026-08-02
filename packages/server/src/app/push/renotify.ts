import type { LifecycleKind } from "./types.js";

/**
 * Re-notify schedule for an unanswered permission-request push (design
 * `perm` — the design doc treats an agent question as "a perm-request with
 * answer" states; `done`/`failed` are terminal and never scheduled.
 *
 * `RENOTIFY_DELAYS_MS.length` follow-ups plus the initial attempt itself
 * gives the "max 3" total notifications for one unanswered request.
 */
const RENOTIFY_DELAYS_MS = [5 * 60_000, 10 * 60_000];

const RENOTIFIABLE_KINDS: ReadonlySet<LifecycleKind> = new Set(["perm", "question"]);

/**
 * Tracks, per session, the follow-up timers for one outstanding
 * perm-request/question dispatch. There is deliberately no separate
 * "answered" signal here: the server holds no plaintext permission state
 * the exact same way the initial dispatch is — via the caller's presence
 * check (`PresencePort.hasActiveVisibleClient`) run again at fire time.
 *
 * Any new dispatch for the same session (any kind) supersedes and cancels
 * a still-pending schedule before deciding whether to arm a fresh one —
 * a later lifecycle event (a new perm-request, or a terminal `done`/
 * `failed`) always means the old schedule is stale.
 */
export interface RenotifyScheduler {
  /**
   * Call once per `dispatch()` invocation, after the initial attempt has
   * already run. `retry` re-runs that same attempt (presence check +
   * channel fan-out) and must not itself reschedule — this function owns
   * the fixed +5/+10 min schedule.
   */
  onDispatch(params: { sessionId: string; kind: LifecycleKind; retry: () => Promise<void> }): void;
  /** Cancels every pending timer for every session — for graceful shutdown/tests. */
  cancelAll(): void;
}

export function createRenotifyScheduler(): RenotifyScheduler {
  const timersBySession = new Map<string, NodeJS.Timeout[]>();

  function cancel(sessionId: string): void {
    const existing = timersBySession.get(sessionId);
    if (!existing) return;
    for (const timer of existing) clearTimeout(timer);
    timersBySession.delete(sessionId);
  }

  return {
    onDispatch({ sessionId, kind, retry }) {
      cancel(sessionId); // supersede whatever was scheduled for this session before

      if (!RENOTIFIABLE_KINDS.has(kind)) return;

      const scheduled = RENOTIFY_DELAYS_MS.map((delay, i) => {
        const isLast = i === RENOTIFY_DELAYS_MS.length - 1;
        const timer = setTimeout(() => {
          void retry().catch((err) => {
            console.error({ module: "push" }, `re-notify attempt failed: ${err}`);
          });
          // The schedule for this session has run to completion. Drop the
          // bookkeeping entry so it doesn't linger in `timersBySession`
          // forever — a session whose perm-request is eventually answered
          // (or never re-dispatched) would otherwise never be cleaned up.
          // The identity check guards against a fresh schedule that
          // superseded this one via a later `onDispatch` for the same
          // session (that call already replaced the map entry).
          if (isLast && timersBySession.get(sessionId) === scheduled) {
            timersBySession.delete(sessionId);
          }
        }, delay);
        // Never let a pending re-notify keep the process alive on its own.
        timer.unref();
        return timer;
      });
      timersBySession.set(sessionId, scheduled);
    },
    cancelAll() {
      for (const sessionId of [...timersBySession.keys()]) cancel(sessionId);
    },
  };
}
