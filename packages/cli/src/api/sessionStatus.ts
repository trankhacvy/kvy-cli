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
 * exists on `main` yet — `falcon auth login` is still a stub), matching the
 * "treated as a given" pattern `claudeLocal.ts`/`hookServer.ts` already use
 * for their own not-yet-landed dependencies.
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

const DEFAULT_TIMEOUT_MS = 3000;
// The server never persists this text (see sessionStatus.ts's comment) —
// still cap it defensively so a runaway stack trace can't blow past the
// server's own body-size limit or bloat its logs.
const MAX_ERROR_LENGTH = 2000;

/**
 * Best-effort report that a session's local process crashed. Swallows every
 * failure mode into a typed result instead of throwing — callers (a
 * signal/uncaught-exception handler racing process shutdown) must be able
 * to fire this and move on unconditionally.
 */
export async function reportSessionFailed(
  deps: ReportSessionFailedDeps,
  params: { sessionId: string; error: Error },
): Promise<ReportSessionFailedResult> {
  const {
    backendUrl,
    accessToken,
    fetchImpl = fetch,
    logger,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = deps;
  const { sessionId } = params;
  const errorMessage = params.error.message.slice(0, MAX_ERROR_LENGTH);

  try {
    const res = await fetchImpl(`${backendUrl}/v1/sessions/${sessionId}/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ status: "failed", error: errorMessage }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      logger?.warn("[session-status] server rejected crash report", {
        sessionId,
        status: res.status,
      });
      return { type: "http-error", status: res.status };
    }

    logger?.debug("[session-status] reported session failed", { sessionId });
    return { type: "ok" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn("[session-status] failed to reach backend for crash report", {
      sessionId,
      error: message,
    });
    return { type: "network-error", error: message };
  }
}
