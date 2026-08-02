/**
 * machine: "Exit paths: Ctrl-C/SIGTERM ⇒ session stays `active` (resumable).
 * ... Crash ⇒ status `failed` + error surfaced").
 *
 * This module owns exactly one judgment call — given how a local-mode
 * session process ended, was that a normal/resumable exit (do nothing; the
 * session row already defaults to, and stays, `active`) or an unexpected
 * not spawn or await the child process itself — see `claudeLocal.ts` for
 * that — callers wrap their own `claudeLocal(...)` call with a
 * `SessionExitTracker`:
 *
 * ```
 * const tracker = createSessionExitTracker({ reportSessionFailed, logger });
 * const stop = tracker.start();
 * let sessionId: string | null = null;
 * try {
 *   const resolved = await claudeLocal(
 *     { abort, onSessionFound: (id) => { sessionId = id; tracker.setSessionId(id); }, ... },
 *     deps,
 *   );
 *   await tracker.handleOutcome(sessionId ?? resolved, { ok: true });
 * } catch (error) {
 *   await tracker.handleOutcome(sessionId, { ok: false, error });
 * } finally {
 *   stop();
 * }
 * ```
 *
 * Wiring `onSessionFound` to `tracker.setSessionId` (not just a local
 * variable) matters: an `uncaughtException`/`unhandledRejection` can fire
 * while `claudeLocal(...)` is still in flight — the entire lifetime of a
 * session — well before `handleOutcome` ever runs. Without `setSessionId`,
 * this module's own crash-reporting for that case would have no session id
 * to attach the report to and would silently skip it.
 *
 * ## Why signal tracking, not signal forwarding
 * A real terminal delivers SIGINT/SIGTERM/SIGHUP to the whole foreground
 * process group — both this wrapper process AND the inherited-stdio child
 * (the actual Claude Code TUI) receive it directly from the OS, independent
 * of anything this module does. Claude Code's own TUI owns deciding what a
 * provider keybinding untouched) — this module must not additionally force
 * the child down on the first signal, which would fight that native
 * behavior. Its only two jobs are:
 *   1. Register a listener so Node doesn't apply its own default action
 *      (immediate process termination) to this wrapper process on the
 *      first SIGINT — it needs to stay alive long enough to see how the
 *      child's own exit resolves and report accordingly.
 *   2. Remember that a signal happened, so that whatever exit/rejection
 *      shape `claudeLocal(...)`'s promise settles with afterward (it may
 *      look identical to a crash — e.g. "Process terminated with signal:
 *      SIGINT") gets classified as a resumable signal-exit, not a crash.
 *
 * `uncaughtException`/`unhandledRejection` are a separate case — a bug in
 * Kvy's own wrapper code, not the child. Those *are* always a crash:
 * best-effort report it with whatever session id is known, then exit.
 */

import type { ReportSessionFailedDeps, ReportSessionFailedResult } from "../api/sessionStatus.js";
import { reportSessionFailed as defaultReportSessionFailed } from "../api/sessionStatus.js";
import type { Logger } from "../logger.js";

const TRACKED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export type SessionExitReason =
  | { kind: "clean-exit" } // child exited on its own, no signal observed — resumable
  | { kind: "signal-exit"; signal: NodeJS.Signals } // Ctrl-C/SIGTERM/terminal-close — resumable, not reported
  | { kind: "crash"; error: Error }; // unexpected child exit/signal, or a wrapper-process bug

export type SessionOutcome = { ok: true } | { ok: false; error: unknown };

export interface SessionExitTrackerDeps {
  /** Best-effort crash reporter; defaults to the real backend client. Injectable for tests. */
  reportSessionFailed?: (
    deps: ReportSessionFailedDeps,
    params: { sessionId: string; error: Error },
  ) => Promise<ReportSessionFailedResult>;
  /** Forwarded to `reportSessionFailed` when an actual report is sent. */
  reportDeps: ReportSessionFailedDeps;
  logger?: Logger;
  /** Overridable for tests; defaults to the real `process`. */
  process?: NodeJS.Process;
  /** Called on an uncaught exception/rejection, after the best-effort report fires. Defaults to `process.exit(1)`. */
  exitOnUncaught?: (code: number) => void;
}

export interface SessionExitTracker {
  /**
   * Registers signal + uncaught-exception/rejection handlers on the wrapper
   * process. Returns a cleanup function that removes them — callers must
   * call it once the session process's own lifecycle is done (successful
   * exit or already-reported crash) so a later, unrelated signal in the
   * same CLI invocation isn't misattributed to this session.
   */
  start(): () => void;
  /** True once a tracked signal has fired since the last `start()`. */
  sawSignal(): boolean;
  /**
   * Records the session id as soon as it's known (e.g. from
   * `claudeLocal(...)`'s `onSessionFound` callback), independent of
   * `handleOutcome`. Lets an `uncaughtException`/`unhandledRejection` that
   * fires mid-session — before the child has settled at all — still attach
   * the right session id to its best-effort crash report.
   */
  setSessionId(sessionId: string | null): void;
  /**
   * Classifies how the session process ended and, for a genuine crash,
   * best-effort reports it. Never throws — reporting failures are logged
   * describes).
   */
  handleOutcome(sessionId: string | null, outcome: SessionOutcome): Promise<SessionExitReason>;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

/** Extracts the signal a rejected `claudeLocal(...)` promise's error was about, if any. */
function signalFromError(error: Error): NodeJS.Signals | null {
  const match = /^Process terminated with signal: (\w+)$/.exec(error.message);
  const signal = match?.[1];
  return signal && (TRACKED_SIGNALS as string[]).includes(signal)
    ? (signal as NodeJS.Signals)
    : null;
}

export function createSessionExitTracker(deps: SessionExitTrackerDeps): SessionExitTracker {
  const proc = deps.process ?? process;
  const logger = deps.logger;
  const report = deps.reportSessionFailed ?? defaultReportSessionFailed;
  const exitOnUncaught = deps.exitOnUncaught ?? ((code: number) => proc.exit(code));

  let lastSignal: NodeJS.Signals | null = null;
  let currentSessionId: string | null = null;

  async function reportCrash(sessionId: string | null, error: Error): Promise<void> {
    logger?.error("[session-exit] session crashed", { sessionId, error: error.message });
    if (!sessionId) {
      logger?.debug("[session-exit] no session id known yet — skipping crash report");
      return;
    }
    const result = await report(deps.reportDeps, { sessionId, error });
    if (result.type !== "ok") {
      logger?.warn("[session-exit] best-effort crash report did not succeed", {
        sessionId,
        result,
      });
    }
  }

  return {
    start() {
      lastSignal = null;

      const onSignal = (signal: NodeJS.Signals) => {
        if (lastSignal === null) {
          logger?.debug("[session-exit] received signal — session stays active/resumable", {
            signal,
          });
        }
        lastSignal = signal;
      };

      const onUncaught = (error: unknown) => {
        const err = toError(error);
        logger?.error("[session-exit] uncaught error in session process", {
          error: err.message,
        });
        reportCrash(currentSessionId, err).finally(() => exitOnUncaught(1));
      };

      // Node invokes a `process.on(<signal>, listener)` listener with no
      // arguments (unlike a generic EventEmitter re-dispatch) — bind the
      // signal name via closure per-signal instead of reading it from the
      // callback args, and keep the bound listeners around so `off()` can
      // remove the exact same function references later.
      const signalListeners = TRACKED_SIGNALS.map(
        (signal) => [signal, () => onSignal(signal)] as const,
      );
      for (const [signal, listener] of signalListeners) proc.on(signal, listener);
      proc.on("uncaughtException", onUncaught);
      proc.on("unhandledRejection", onUncaught);

      return () => {
        for (const [signal, listener] of signalListeners) proc.off(signal, listener);
        proc.off("uncaughtException", onUncaught);
        proc.off("unhandledRejection", onUncaught);
      };
    },

    sawSignal() {
      return lastSignal !== null;
    },

    setSessionId(sessionId) {
      currentSessionId = sessionId;
    },

    async handleOutcome(sessionId, outcome) {
      currentSessionId = sessionId;

      if (outcome.ok) {
        return { kind: "clean-exit" };
      }

      const error = toError(outcome.error);

      if (lastSignal !== null) {
        logger?.debug(
          "[session-exit] child exited after a tracked signal — resumable, not reporting",
          { signal: lastSignal, error: error.message },
        );
        return { kind: "signal-exit", signal: lastSignal };
      }

      // The child's own exit can still surface as "terminated with signal:
      // SIGINT" even when this wrapper process's own listener didn't fire
      // first (e.g. child settles its promise before this process's signal
      // handler runs, an ordering Node doesn't guarantee) — recognize that
      // shape too rather than only trusting our own listener's timing.
      const inferredSignal = signalFromError(error);
      if (inferredSignal) {
        logger?.debug("[session-exit] child exit attributes to a resumable signal", {
          signal: inferredSignal,
        });
        return { kind: "signal-exit", signal: inferredSignal };
      }

      await reportCrash(sessionId, error);
      return { kind: "crash", error };
    },
  };
}
