import type {
  BlobRequestDownloadResult,
  BlobRequestUploadResult,
  EncryptedBox,
  PushSubscribeBody,
  SessionRow,
  WorkspaceRow,
} from "@kvy/wire";
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
    throw new ApiError("Could not reach the Kvy server. Check your connection.", 0);
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

/** `POST /v1/auth/register` — OAuth sign-in/sign-up: finds-or-creates the account's
 * login identity for this provider. Key material is bound separately via `keysChallenge`/`keysBind`. */
export function register(body: {
  oauthProvider: "google" | "github";
  oauthProof: string;
}): Promise<{ success: true; token: string; refreshToken: string }> {
  return postJson("/v1/auth/register", body);
}

/** `POST /v1/auth/oauth/github/exchange` — trades a GitHub authorization code for an access token. */
export function exchangeGithubCode(body: {
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string }> {
  return postJson("/v1/auth/oauth/github/exchange", body);
}

/** `POST /v1/auth/password/register` — email+password sign-up. */
export function passwordRegister(body: {
  email: string;
  password: string;
}): Promise<{ success: true; token: string; refreshToken: string }> {
  return postJson("/v1/auth/password/register", body);
}

/** `POST /v1/auth/password/login` — email+password sign-in. */
export function passwordLogin(body: {
  email: string;
  password: string;
}): Promise<{ success: true; token: string; refreshToken: string }> {
  return postJson("/v1/auth/password/login", body);
}

// Security review finding F1: `POST /v1/auth/refresh` is no longer called from here — the
// refresh token never touches the main thread at all anymore, so the HTTP call itself
// moved into `crypto/worker-handler.ts`'s `refreshSession` case (a real `fetch` made from
// inside the crypto worker, against the token it alone holds, PIN-recovered). This file's
// old `refreshSession()` wrapper (POST /v1/auth/refresh from the main thread) is gone —
// nothing here is authorized to hold the raw refresh token to call it with.

/** `POST /v1/auth/keys/challenge` — mint a server nonce for `keys/bind`. */
export function keysChallenge(token: string): Promise<{ nonce: string }> {
  return postJson("/v1/auth/keys/challenge", undefined, token);
}

/** A step-up proof for `POST /v1/auth/keys/bind`'s explicit-rotation path -
 * re-proves account ownership right before a rotation fences out every other session. */
export type StepUpProof =
  | { kind: "password"; password: string }
  | { kind: "oauth"; provider: "google" | "github"; oauthProof: string };

/** `POST /v1/auth/keys/bind` — bind (first-bind) or, with `rotate: true` + a `stepUpProof`, explicitly rotate this device's key material. */
export function keysBind(
  token: string,
  body: {
    signPubKey: string;
    contentPubKey: string;
    nonce: string;
    signature: string;
    rotate?: boolean;
    stepUpProof?: StepUpProof;
  },
): Promise<{ success: true; keyEpoch: number }> {
  return postJson("/v1/auth/keys/bind", body, token);
}

/** `GET /v1/auth/sessions` — this account's active device sessions. `email` is
 * the account's best-effort captured email for display only, `null` if none is on file. */
export function listDeviceSessions(token: string): Promise<{
  email: string | null;
  identityKind: "password" | "google" | "github" | null;
  accountCreatedAt: string | null;
  sessions: Array<{
    id: string;
    clientKind: string;
    label: string | null;
    machineId: string | null;
    createdAt: string;
    lastRefreshedAt: string | null;
    expiresAt: string;
    isCurrent: boolean;
  }>;
}> {
  return getJson("/v1/auth/sessions", token);
}

/** `POST /v1/auth/sessions/:id/revoke`. */
export function revokeSession(token: string, sessionId: string): Promise<{ success: true }> {
  return postJson(`/v1/auth/sessions/${sessionId}/revoke`, undefined, token);
}

/** `POST /v1/auth/sessions/revoke-others` — log out every other device. */
export function revokeOtherSessions(token: string): Promise<{ success: true; revoked: number }> {
  return postJson("/v1/auth/sessions/revoke-others", undefined, token);
}

/** `POST /v1/auth/pair/mint` — mints the new device's session server-side and hands
 * its refresh token to this browser so the crypto worker can seal it before anything
 * derived from it ever touches Postgres in plaintext. Must be called before `approvePairing`. */
export function mintPairSession(token: string, ephPub: string): Promise<{ refreshToken: string }> {
  return postJson("/v1/auth/pair/mint", { ephPub }, token);
}

/** `POST /v1/auth/pair/approve` — an already-authenticated device approves a pairing
 * request, storing the sealed `[version|masterSecret|refreshToken]` box
 * (`bridge.sealForPeer`, using the refresh token `mintPairSession` above just minted). */
export function approvePairing(
  token: string,
  body: { ephPub: string; response: string },
): Promise<{ success: true }> {
  return postJson("/v1/auth/pair/approve", body, token);
}

export interface PairRequestDetails {
  status: "not_found" | "pending" | "authorized" | "expired";
  label?: string | null;
  cwd?: string | null;
  requestedAt?: string | null;
}

/** `GET /v1/auth/pair/status` — what the approver's confirm card renders. `label`/`cwd`
 * are supplied by the requesting device and are display-only. */
export function fetchPairDetails(ephPub: string): Promise<PairRequestDetails> {
  return getJson(`/v1/auth/pair/status?ephPub=${encodeURIComponent(ephPub)}`);
}

/** `POST /v1/keys/request` — ask this account's other devices for a copy of the keys. */
export function createKeyRequest(
  token: string,
  body: { ephPub: string; label?: string },
): Promise<{ success: true }> {
  return postJson("/v1/keys/request", body, token);
}

export interface PendingKeyRequest {
  ephPub: string;
  label: string | null;
  createdAt: string;
  requesterClientKind: string | null;
  requesterCreatedAt: string | null;
}

/** `GET /v1/keys/requests` — pending requests for this account, with server-attested
 * facts about the asking device. */
export function listKeyRequests(token: string): Promise<{ requests: PendingKeyRequest[] }> {
  return getJson("/v1/keys/requests", token);
}

/** `POST /v1/keys/request/approve` — a holder device stores the sealed `[0x02|masterSecret]` box. */
export function approveKeyRequest(
  token: string,
  body: { ephPub: string; response: string },
): Promise<{ success: true }> {
  return postJson("/v1/keys/request/approve", body, token);
}

export type ClaimKeyRequestResult =
  | { state: "pending" }
  | { state: "expired" }
  | { state: "ready"; response: string };

/** `POST /v1/keys/request/claim` — single-use pickup, bound to the requesting session. */
export function claimKeyRequest(token: string, ephPub: string): Promise<ClaimKeyRequestResult> {
  return postJson("/v1/keys/request/claim", { ephPub }, token);
}

/** `POST /v1/push/subscribe` — register (or update) a push subscription. */
export function subscribePush(token: string, body: PushSubscribeBody): Promise<{ id: string }> {
  return postJson("/v1/push/subscribe", body, token);
}

/** `DELETE /v1/push/subscribe` — remove a push subscription by endpoint. */
export function unsubscribePush(token: string, endpoint: string): Promise<{ ok: true }> {
  return sendJson("DELETE", "/v1/push/subscribe", { endpoint }, token);
}

/** `POST /v1/push/telegram/link` — mint a Telegram `/start` pairing deep link. */
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

/** `GET /v1/account/notifications-mute` — current "mute all" state. */
export function getMutedAll(token: string): Promise<{ mutedAll: boolean }> {
  return getJson("/v1/account/notifications-mute", token);
}

/** `PUT /v1/account/notifications-mute` — toggle "mute all". */
export function setMutedAll(token: string, mutedAll: boolean): Promise<{ mutedAll: boolean }> {
  return putJson("/v1/account/notifications-mute", { mutedAll }, token);
}

/** `PUT /v1/sessions/:id/notifications-mute` — mute/unmute one session. */
export function setSessionMuted(
  token: string,
  sessionId: string,
  muted: boolean,
): Promise<{ muted: boolean }> {
  return putJson(`/v1/sessions/${sessionId}/notifications-mute`, { muted }, token);
}

/** `GET /v1/sync?since=0` — full account snapshot. Always requests from `since=0` because
 * the route has no incremental-resync support yet, so threading a real cursor adds no benefit. */
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

/** `POST /v1/sessions/:id/archive` — flip a session to `status: "archived"`. Idempotent server-side. */
export function archiveSession(token: string, sessionId: string): Promise<{ status: "archived" }> {
  return postJson(`/v1/sessions/${sessionId}/archive`, undefined, token);
}

export type PutSessionMetadataCasResult =
  | { ok: true; version: number }
  | { ok: false; current: { value: EncryptedBox | null; version: number } };

/** `PUT /v1/sessions/:id/metadata` — CAS update for encrypted session metadata.
 * Deliberately doesn't go through `request()`/`putJson`: a `409` carries the CURRENT
 * box the caller needs to re-open and retry against, which those helpers would discard. */
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
    throw new ApiError("Could not reach the Kvy server. Check your connection.", 0);
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

/** `POST /v1/workspaces` — create-or-get a workspace row by `pathHash`
 * (`CryptoBridgeClient.hashWorkspacePath` — never the raw path itself, which
 * the server must never see). Idempotent. */
export function createWorkspace(
  token: string,
  body: { pathHash: string; metadata: EncryptedBox; dek: string },
): Promise<WorkspaceRow> {
  return postJson("/v1/workspaces", body, token);
}

export type PutWorkspaceMetadataCasResult =
  | { ok: true; version: number }
  | { ok: false; current: { value: EncryptedBox; version: number } };

/** `PUT /v1/workspaces/:id/metadata` — CAS update of a workspace's encrypted
 * `baseBranch`/`remote` config, same shape as `putSessionMetadataCas`. */
export async function putWorkspaceMetadataCas(
  token: string,
  workspaceId: string,
  body: { expectedVersion: number; value: EncryptedBox },
): Promise<PutWorkspaceMetadataCasResult> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/v1/workspaces/${workspaceId}/metadata`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Could not reach the Kvy server. Check your connection.", 0);
  }

  if (response.ok) {
    const parsed = (await response.json()) as { version: number };
    return { ok: true, version: parsed.version };
  }

  if (response.status === 409) {
    const parsed = (await response.json()) as {
      current: { value: EncryptedBox; version: number };
    };
    return { ok: false, current: parsed.current };
  }

  const bodyText = await response.text().catch(() => "");
  throw new ApiError(
    bodyText.length > 0
      ? `workspace metadata update failed with ${response.status}: ${bodyText}`
      : `workspace metadata update failed with ${response.status}`,
    response.status,
  );
}

/** `POST /v1/blobs/request-upload` — mint an upload target for an already-encrypted blob. `size`/`contentHash` describe the encrypted bytes - the server never sees plaintext. */
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
