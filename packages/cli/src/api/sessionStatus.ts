/**
 * CLI-side client for `POST /v1/sessions/:id/status` (the server route
 * added alongside this module — `packages/server/src/app/routes/
 * sessionStatus.ts`; PRD FR-3.7, design §7.5). Best-effort, same
 * philosophy/shape as `daemon/notify.ts`'s `notifyDaemonSessionStarted`:
 * never throws, every outcome (success, HTTP error, network error) is a
 * typed result the caller logs and moves past. A crash report must never
 * itself crash the CLI or block process exit for long — `timeoutMs` bounds
 * the request.
 *
 * `backendUrl`/`accessToken` are caller-supplied rather than resolved here:
 * this module doesn't own config resolution or auth-token storage (neither
 * exists on `main` yet — `kvy auth login` is still a stub), matching the
 * "treated as a given" pattern `claudeLocal.ts`/`hookServer.ts` already use
 * for their own not-yet-landed dependencies.
 *
 * `reportSessionStatus` (plan.md §16 "1. lifecycle-status" / plan-v2.md
 * W1.4+B15) generalizes this beyond the crash-only `failed` status: the
 * PTY-injection path (`commands/start.ts`) also reports `ended` at its
 * normal-exit and signal-handler exits, so the web can show a session as
 * over instead of inferring nothing (design §7.5's mode state machine).
 * `reportSessionFailed` stays as a thin `failed`-only wrapper so its
 * existing callers/tests are untouched.
 */

import type { Logger } from "../logger.js";

export interface ReportSessionFailedDeps {
  backendUrl: string;
  accessToken: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Request timeout in ms — a slow/unreachable backend must not hang process exit. */
  timeoutMs?: number;
}

export type ReportSessionFailedResult =
  | { type: "ok" }
  | { type: "http-error"; status: number }
  | { type: "network-error"; error: string };

/** Every status this route can ever report — additive (design §5.3: the
 * wire's `SessionStatusSchema` gained `"ended"` alongside this). */
export type ReportableSessionStatus = "failed" | "ended";

const DEFAULT_TIMEOUT_MS = 3000;
// The server never persists this text (see sessionStatus.ts's comment) —
// still cap it defensively so a runaway stack trace can't blow past the
// server's own body-size limit or bloat its logs.
const MAX_ERROR_LENGTH = 2000;

/**
 * Best-effort report of a session's terminal status (`failed` — a crash —
 * or `ended` — a normal/signal exit, W1.4). Swallows every failure mode
 * into a typed result instead of throwing — callers (a signal/uncaught-
 * exception handler, or `start.ts`'s own exit path, racing process
 * shutdown) must be able to fire this and move on unconditionally.
 */
export async function reportSessionStatus(
  deps: ReportSessionFailedDeps,
  params: { sessionId: string; status: ReportableSessionStatus; error?: Error },
): Promise<ReportSessionFailedResult> {
  const {
    backendUrl,
    accessToken,
    fetchImpl = fetch,
    logger,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = deps;
  const { sessionId, status } = params;
  const errorMessage = params.error?.message.slice(0, MAX_ERROR_LENGTH);

  try {
    const res = await fetchImpl(`${backendUrl}/v1/sessions/${sessionId}/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ status, ...(errorMessage ? { error: errorMessage } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      logger?.warn("[session-status] server rejected status report", {
        sessionId,
        status,
        httpStatus: res.status,
      });
      return { type: "http-error", status: res.status };
    }

    logger?.debug("[session-status] reported session status", { sessionId, status });
    return { type: "ok" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn("[session-status] failed to reach backend for status report", {
      sessionId,
      status,
      error: message,
    });
    return { type: "network-error", error: message };
  }
}

/**
 * Thin `failed`-only wrapper kept for `sessionExit.ts`'s (and its own
 * tests') existing call shape — a crash report never carries any other
 * status.
 */
export async function reportSessionFailed(
  deps: ReportSessionFailedDeps,
  params: { sessionId: string; error: Error },
): Promise<ReportSessionFailedResult> {
  return reportSessionStatus(deps, {
    sessionId: params.sessionId,
    status: "failed",
    error: params.error,
  });
}
