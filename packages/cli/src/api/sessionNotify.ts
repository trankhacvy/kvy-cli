
import type { Logger } from "../logger.js";

/** The three lifecycle kinds `POST /v1/sessions/:id/notify` accepts (mirrors the server's `NotifyBodySchema`). */
export type SessionAttentionKind = "perm" | "question" | "done";

export interface ReportSessionAttentionDeps {
  backendUrl: string;
  accessToken: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Request timeout in ms — a slow/unreachable backend must not hang the caller. */
  timeoutMs?: number;
}

export type ReportSessionAttentionResult =
  | { type: "ok" }
  | { type: "http-error"; status: number }
  | { type: "network-error"; error: string };

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Best-effort report of a lifecycle attention signal (a permission request or
 * AskUserQuestion becoming pending, or a turn completing) so the server can
 * dispatch a presence-suppressed push notification. Swallows every failure
 * mode into a typed result instead of throwing — callers fire this
 * fire-and-forget alongside the real envelope/turn pipeline.
 */
export async function reportSessionAttention(
  deps: ReportSessionAttentionDeps,
  params: { sessionId: string; kind: SessionAttentionKind },
): Promise<ReportSessionAttentionResult> {
  const {
    backendUrl,
    accessToken,
    fetchImpl = fetch,
    logger,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = deps;
  const { sessionId, kind } = params;

  try {
    const res = await fetchImpl(`${backendUrl}/v1/sessions/${sessionId}/notify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ kind }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      logger?.warn("[session-notify] server rejected attention report", {
        sessionId,
        kind,
        httpStatus: res.status,
      });
      return { type: "http-error", status: res.status };
    }

    logger?.debug("[session-notify] reported session attention", { sessionId, kind });
    return { type: "ok" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn("[session-notify] failed to reach backend for attention report", {
      sessionId,
      kind,
      error: message,
    });
    return { type: "network-error", error: message };
  }
}
