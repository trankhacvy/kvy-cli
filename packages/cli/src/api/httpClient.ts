/**
 * HTTP transport for the outbox: `POST /v1/sessions/:id/messages
 * {localId, content}` (design §4.3). All the outbox cares about is the 2xx /
 * non-2xx split — the response body (`{seq}` on first write, replay on a
 * duplicate `localId`) isn't consumed here; message ordering is derived from
 * the `update` stream, not the POST response.
 */
import type { EncryptedBox } from "@falcon/wire";

export interface OutboxPostResult {
  ok: boolean;
  status: number;
}

export interface OutboxHttpClient {
  postMessages(
    sessionId: string,
    body: { localId: string; content: EncryptedBox },
  ): Promise<OutboxPostResult>;
}

export interface CreateHttpClientOptions {
  /** Falcon server origin, e.g. `https://api.falcon.dev` (no trailing slash required). */
  serverUrl: string;
  /**
   * Static headers merged into every request (e.g. `{ Authorization: "Bearer ..." }`).
   * Prefer `getAuthToken` for the `authorization` header on any long-lived client — a
   * static value here is captured once and never refreshed for the client's lifetime
   * (docs/known-issues-cliweb-sync-test.md issue #1: this is exactly how the Outbox's
   * access token used to go stale after ~15min and retry a dead 401 forever).
   */
  headers?: Record<string, string>;
  /**
   * Resolves the current bearer token immediately before every request — including every
   * blind retry `Outbox.sendUntil2xx()` performs — instead of a token captured once at
   * construction. Typically `TokenProvider.getAccessToken`. Takes precedence over any
   * `authorization` key in `headers`. A `null`/empty return sends the request with no
   * `authorization` header (e.g. a dead refresh token — nothing more this layer can do).
   */
  getAuthToken?: () => string | null | Promise<string | null>;
  /**
   * Invoked (and awaited) once whenever a request comes back `401`, before the caller's
   * own retry loop tries again — typically `TokenProvider.forceRefresh()`, so the next
   * `getAuthToken()` call returns a rotated token instead of the same stale one. Errors
   * are swallowed: a failed forced refresh just means the next attempt falls back to
   * whatever `getAuthToken` otherwise returns.
   */
  onUnauthorized?: () => unknown | Promise<unknown>;
  /** Override for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export function createHttpClient(options: CreateHttpClientOptions): OutboxHttpClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.serverUrl.replace(/\/+$/, "");

  return {
    async postMessages(sessionId, body) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...options.headers,
      };
      if (options.getAuthToken) {
        const token = await options.getAuthToken();
        if (token) headers.authorization = `Bearer ${token}`;
        else delete headers.authorization;
      }

      const res = await fetchImpl(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (res.status === 401 && options.onUnauthorized) {
        try {
          await options.onUnauthorized();
        } catch {
          // Best-effort: the caller's own retry loop will simply try again with
          // whatever `getAuthToken()` returns next time.
        }
      }

      return { ok: res.ok, status: res.status };
    },
  };
}
