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
  /** Static headers merged into every request (e.g. `{ Authorization: "Bearer ..." }`). */
  headers?: Record<string, string>;
  /** Override for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export function createHttpClient(options: CreateHttpClientOptions): OutboxHttpClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.serverUrl.replace(/\/+$/, "");

  return {
    async postMessages(sessionId, body) {
      const res = await fetchImpl(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...options.headers,
        },
        body: JSON.stringify(body),
      });
      return { ok: res.ok, status: res.status };
    },
  };
}
