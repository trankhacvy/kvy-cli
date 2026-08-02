
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

export type ReportableSessionStatus = "failed" | "ended";

const DEFAULT_TIMEOUT_MS = 3000;
// Cap defensively so a runaway stack trace can't blow past the server's body-size limit.
const MAX_ERROR_LENGTH = 2000;

/**
 * Best-effort report of a session's terminal status. Swallows every failure
 * mode into a typed result instead of throwing — callers racing process
 * shutdown (signal handlers, uncaught-exception handlers) must be able to
 * fire this and move on unconditionally.
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

/** Thin wrapper around `reportSessionStatus` that always sets `status: "failed"`. */
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
