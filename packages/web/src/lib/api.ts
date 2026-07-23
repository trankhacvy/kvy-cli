/**
 * Thin fetch wrappers for the auth-related endpoints these pages need
 * (`packages/server/src/app/routes/oauth.ts`, `routes/auth.ts`, `api/pair.ts`
 * — all already merged to main). No client-side schema validation library is
 * pulled in for this: the shapes are small and fixed, and a malformed
 * response surfaces as a thrown `ApiError` either way.
 */
import type {
  BlobRequestDownloadResult,
  BlobRequestUploadResult,
  EncryptedBox,
  PushSubscribeBody,
  SessionRow,
} from "@falcon/wire";
import type { MessagesPage, SyncSnapshot } from "@/sync";
import { API_URL } from "./config.js";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  token?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError("Could not reach the Falcon server. Check your connection.", 0);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return json as T;
}

function getJson<T>(path: string, token?: string): Promise<T> {
  return request<T>("GET", path, undefined, token);
}

function postJson<T>(path: string, body: unknown, token?: string): Promise<T> {
  return request<T>("POST", path, body, token);
}

function putJson<T>(path: string, body: unknown, token?: string): Promise<T> {
  return request<T>("PUT", path, body, token);
}

function sendJson<T>(
  method: "POST" | "DELETE",
  path: string,
  body: unknown,
  token?: string,
): Promise<T> {
  return request<T>(method, path, body, token);
}

/** `POST /v1/auth/register` — sign-up: binds a freshly-generated identity to an OAuth proof. */
export function register(body: {
  oauthProvider: "google" | "github" | "dev";
  oauthProof: string;
  signPubKey: string;
  contentPubKey: string;
}): Promise<{ success: true; token: string }> {
  return postJson("/v1/auth/register", body);
}

/** `POST /v1/auth` — sign-in: proves possession of an already-provisioned identity.
 * `accountStatus` ("found" vs "created") lets the recovery-restore flow
 * (`lib/restore-recovery-code.ts`) tell a genuine match apart from an
 * upsert that silently minted a brand-new, disconnected account — see
 * `packages/server/src/app/routes/auth.ts`'s module docblock ACCOUNT STATUS
 * note. The normal returning-device sign-in path (`complete-challenge-sign-in.ts`)
 * ignores this field; nothing about its behavior changes. */
export function signIn(body: {
  publicKey: string;
  contentPublicKey: string;
  challenge: string;
  signature: string;
}): Promise<{ success: true; token: string; accountStatus: "found" | "created" }> {
  return postJson("/v1/auth", body);
}

/** `POST /v1/auth/oauth/github/exchange` — trades a GitHub authorization code for an access token. */
export function exchangeGithubCode(body: {
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string }> {
  return postJson("/v1/auth/oauth/github/exchange", body);
}

/** `POST /v1/auth/pair/approve` — an already-authenticated device approves a pairing request. */
export function approvePairing(
  token: string,
  body: { ephPub: string; response: string },
): Promise<{ success: true }> {
  return postJson("/v1/auth/pair/approve", body, token);
}

/** `POST /v1/push/subscribe` — register (or update) a push subscription (design §6.2, FR-7.6). */
export function subscribePush(token: string, body: PushSubscribeBody): Promise<{ id: string }> {
  return postJson("/v1/push/subscribe", body, token);
}

/** `DELETE /v1/push/subscribe` — remove a push subscription by endpoint. */
export function unsubscribePush(token: string, endpoint: string): Promise<{ ok: true }> {
  return sendJson("DELETE", "/v1/push/subscribe", { endpoint }, token);
}

/** `POST /v1/push/telegram/link` — mint a Telegram `/start` pairing deep link (FR-8.3). */
export function linkTelegram(token: string): Promise<{ code: string; deepLink: string }> {
  return postJson("/v1/push/telegram/link", undefined, token);
}

/** `GET /v1/sessions` — list the caller's sessions (used here just to populate the
 * per-session mute picker in Settings; full history isn't paged in). */
export function listSessions(
  token: string,
): Promise<{ sessions: SessionRow[]; nextCursor: string | null }> {
  return getJson(`/v1/sessions?limit=100`, token);
}

/** `GET /v1/account/notifications-mute` — current "mute all" state (FR-8.3). */
export function getMutedAll(token: string): Promise<{ mutedAll: boolean }> {
  return getJson("/v1/account/notifications-mute", token);
}

/** `PUT /v1/account/notifications-mute` — toggle "mute all" (FR-8.3). */
export function setMutedAll(token: string, mutedAll: boolean): Promise<{ mutedAll: boolean }> {
  return putJson("/v1/account/notifications-mute", { mutedAll }, token);
}

/** `PUT /v1/sessions/:id/notifications-mute` — mute/unmute one session (FR-8.3). */
export function setSessionMuted(
  token: string,
  sessionId: string,
  muted: boolean,
): Promise<{ muted: boolean }> {
  return putJson(`/v1/sessions/${sessionId}/notifications-mute`, { muted }, token);
}

/** `GET /v1/sync?since=0` — full account snapshot (design §4.3/§6.2): every
 * session/machine/unmanaged-session row, each still carrying its opaque
 * `EncryptedBox` metadata + `dek` wrap. Always requests the full snapshot —
 * the route's own doc comment notes there's no incremental-resync support
 * yet ("not an incremental delta from `since`"), so there's no benefit to
 * threading a real cursor through here. */
export function getSync(token: string): Promise<SyncSnapshot> {
  return getJson("/v1/sync?since=0", token);
}

/** `GET /v1/sessions/:id/messages` — one page of a session's encrypted
 * message batches, newest first (`before` pages backward by `seq`). */
export function getSessionMessages(
  token: string,
  sessionId: string,
  before?: number,
): Promise<MessagesPage> {
  const qs = before !== undefined ? `?before=${before}` : "";
  return getJson(`/v1/sessions/${sessionId}/messages${qs}`, token);
}

/** `POST /v1/sessions/:id/archive` — flip a session to `status: "archived"`
 * (design §6.2, plan-v2.md W4.2 "Archive/delete: … wire buttons on Home rows
 * + session header"). Idempotent server-side; no CLI-side reaction (an
 * archived live session keeps running — W2.3's `stop` is the "end it" path). */
export function archiveSession(token: string, sessionId: string): Promise<{ status: "archived" }> {
  return postJson(`/v1/sessions/${sessionId}/archive`, undefined, token);
}

/** `POST /v1/sessions/:id/unarchive` — Restore, the inverse of Mark done
 * (docs/features/session-lifecycle-actions.md Phase 1). Idempotent
 * server-side; a non-archived row is left untouched and the response
 * reports the row's honest current status rather than fabricating
 * `"active"`. */
export function unarchiveSession(
  token: string,
  sessionId: string,
): Promise<{ status: SessionRow["status"] }> {
  return postJson(`/v1/sessions/${sessionId}/unarchive`, undefined, token);
}

export type PutSessionMetadataCasResult =
  | { ok: true; version: number }
  | { ok: false; current: { value: EncryptedBox | null; version: number } };

/** `PUT /v1/sessions/:id/metadata` (server `sessionCas.ts`) — the web's
 * first encrypted-metadata write path (docs/features/session-lifecycle-
 * actions.md Phase 3, Rename/Pin). Deliberately doesn't go through
 * `request()`/`putJson` above: those throw on any non-2xx and discard the
 * body, but a `409` here carries the CURRENT box the caller needs to
 * re-open and retry against — cloned from the CLI's own
 * `cli/src/api/sessionMetadata.ts` updater, which hits this same route the
 * same way for the same reason. */
export async function putSessionMetadataCas(
  token: string,
  sessionId: string,
  body: { expectedVersion: number; value: EncryptedBox },
): Promise<PutSessionMetadataCasResult> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/v1/sessions/${sessionId}/metadata`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Could not reach the Falcon server. Check your connection.", 0);
  }

  if (response.ok) {
    const parsed = (await response.json()) as { version: number };
    return { ok: true, version: parsed.version };
  }

  if (response.status === 409) {
    const parsed = (await response.json()) as {
      current: { value: EncryptedBox | null; version: number };
    };
    return { ok: false, current: parsed.current };
  }

  const bodyText = await response.text().catch(() => "");
  throw new ApiError(
    bodyText.length > 0
      ? `session metadata update failed with ${response.status}: ${bodyText}`
      : `session metadata update failed with ${response.status}`,
    response.status,
  );
}

/** `DELETE /v1/sessions/:id` — permanently deletes a session row (and, via
 * `schema.ts`'s `onDelete: "cascade"`, its messages). */
export function deleteSession(token: string, sessionId: string): Promise<Record<string, never>> {
  return sendJson("DELETE", `/v1/sessions/${sessionId}`, undefined, token);
}

/** `POST /v1/blobs/request-upload` — mint an upload target for an already-encrypted blob (design §6.2; plan.md §16 "4.3 Distribution & self-host"). `size`/`contentHash` describe the *encrypted* bytes — the server never sees plaintext. */
export function requestBlobUpload(
  token: string,
  body: { size: number; contentHash: string; sessionId?: string },
): Promise<BlobRequestUploadResult> {
  return postJson("/v1/blobs/request-upload", body, token);
}

/** `POST /v1/blobs/request-download` — mint a download target for a previously-uploaded blob owned by the caller. */
export function requestBlobDownload(
  token: string,
  blobId: string,
): Promise<BlobRequestDownloadResult> {
  return postJson("/v1/blobs/request-download", { blobId }, token);
}
