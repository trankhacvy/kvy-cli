/**
 * The response body is never consumed — message ordering is derived from the
 * server's update stream, not the POST response.
 */
import type { EncryptedBox } from "@kvy/wire";

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
  /** Kvy server origin, e.g. `https://api.kvy.dev` (no trailing slash required). */
  serverUrl: string;
  /**
   * Static headers merged into every request. Prefer `getAuthToken` for the
   * `authorization` header on any long-lived client — a static value is captured
   * once and never refreshed, so a stale token retries a dead 401 forever.
   */
  headers?: Record<string, string>;
  /**
   * Resolves the current bearer token immediately before every request — including every
   * blind retry — so the token is never captured once at construction. Takes precedence
   * over any `authorization` key in `headers`. A `null`/empty return sends the request
   * with no `authorization` header.
   */
  getAuthToken?: () => string | null | Promise<string | null>;
  /**
   * Invoked (and awaited) once whenever a request comes back `401`, before the next
   * retry attempt. Errors are swallowed: a failed call here just means the next attempt
   * falls back to whatever `getAuthToken` returns.
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
