/**
 * CLI-side client for `POST /v1/sessions/:id/notify` (the server route
 * `packages/server/src/app/routes/sessionNotify.ts` — already fully wired,
 * server-side is out of scope here). `docs/user-flows.md`'s fix-plan task 4:
 * the CLI never calls this route today, so a live permission request,
 * AskUserQuestion, or turn completion never triggers a push notification —
 * this module is the missing caller.
 *
 * Same best-effort philosophy/shape as `sessionStatus.ts`'s
 * `reportSessionStatus`: never throws, every outcome (success, HTTP error,
 * network error) is a typed result the caller logs and moves past. This is a
 * side-signal alongside the real permission/turn pipeline — a slow or
 * unreachable backend must never block or fail the thing that triggered it,
 * hence the same bounded `timeoutMs`.
 *
 * `backendUrl`/`accessToken` are caller-supplied, matching `sessionStatus.ts`'s
 * own doc comment on why this module doesn't own config/token resolution.
 */

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
