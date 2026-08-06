/**
 * crypto-bridge RPC protocol — the postMessage-shaped contract between the main thread
 * (`client.ts`) and the crypto worker (`worker.ts` / `worker-handler.ts`). Keys live in
 * worker memory only, so every response shape is deliberately incapable of carrying raw
 * key material — only ciphertext (`EncryptedBox`), booleans, or already-public values
 * cross back out.
 */
import type { EncryptedBox } from "@kvy/crypto/web";
import type { KeyWrapMode } from "./key-storage.js";

/**
 * Provision the master secret: wraps and persists it under `mode` (Phase 5 — no PIN),
 * then derives the key tree in worker memory so the freshly-provisioned device is
 * immediately usable. `refreshToken` goes to the separate session store (Phase 4a).
 */
export interface InitRequest {
  id: string;
  type: "init";
  masterSecret: Uint8Array;
  refreshToken: string;
  /**
   * Whose keys these are (the access token's `sub`) — persisted onto the stored record so
   * a later `describeStorage`/`getIdentity`/`ensureLoaded` scoped to a DIFFERENT account
   * can tell it isn't theirs. Required: every real caller of `init` already has an
   * authenticated session (a genuinely new account, or a step-up-proved rotation) by the
   * time it calls this, so there is never a legitimate "provision keys for nobody in
   * particular" case.
   */
  accountId: string;
  mode: KeyWrapMode;
  /**
   * For `mode: "prf"` only — a non-extractable wrap key the MAIN THREAD derived from a
   * passkey, plus the credential id to re-derive it from later. WebAuthn is unavailable
   * inside a Worker (`prf-key.ts`), so the worker can never produce these itself; if they
   * are absent the worker records `"device"` instead of silently storing something it
   * could never unwrap.
   */
  wrapKey?: CryptoKey;
  credentialId?: Uint8Array;
}

/** Persist a freshly-issued or freshly-rotated refresh token. No key material required. */
export interface SetRefreshTokenRequest {
  id: string;
  type: "setRefreshToken";
  refreshToken: string;
}

/**
 * Mint a fresh access token from the stored refresh token via a real
 * `POST /v1/auth/refresh` made from inside the worker. Never rejects — resolves a
 * `RefreshOutcome` distinguishing "no credential stored", "the server rejected it", and
 * "the request never got anywhere" (see `RefreshOutcome`'s docblock).
 */
export interface RefreshSessionRequest {
  id: string;
  type: "refreshSession";
}

/** Unwrap a per-session DEK with the in-memory content secret key and hold it active. */
export interface SetSessionKeyRequest {
  id: string;
  type: "setSessionKey";
  wrappedDek: Uint8Array;
}

/**
 * Mint a fresh DEK, wrap it to this device's own content public key (the
 * same `wrapDek(dek, keyTree.content.publicKey)` the CLI uses when it mints
 * a session/machine DEK — `session/bootstrap.ts`), and seal `data` under it
 * — for a web-originated encrypted entity (e.g. a workspace row created
 * from the Workspace Settings dialog) rather than one relayed from the CLI.
 */
export interface CreateDekRequest {
  id: string;
  type: "createDek";
  data: unknown;
}

/**
 * Deterministic, server-unguessable blind index for a workspace's real
 * absolute path (`hashWorkspacePath`/`KeyTree.workspaceIndexKey`, `@kvy/
 * crypto` — same primitive the CLI uses at `session/resolveServerWorkspaceId.ts`),
 * for the Workspace Settings dialog's `POST /v1/workspaces` create-or-get.
 * The real path never leaves this request — only the hash crosses back to
 * the main thread.
 */
export interface HashWorkspacePathRequest {
  id: string;
  type: "hashWorkspacePath";
  path: string;
}

export interface SealRequest {
  id: string;
  type: "seal";
  data: unknown;
}

export interface OpenRequest {
  id: string;
  type: "open";
  box: EncryptedBox;
}

/** Encrypt binary data under the active session's blob key — `deriveBlobKey(activeDek)`. */
export interface SealBlobRequest {
  id: string;
  type: "sealBlob";
  data: Uint8Array;
}

export interface OpenBlobRequest {
  id: string;
  type: "openBlob";
  bundle: Uint8Array;
}

/** Wipe in-memory keys, the key store, and the session store (logout). */
export interface ClearRequest {
  id: string;
  type: "clear";
}

/**
 * Report the public identity provisioned on this device, if any — read straight from the
 * stored record's plaintext public keys.
 *
 * NOTE: this answers for a v1 (pre-Phase-5) record too, so it must NOT be used as the
 * readiness check. Use `describeStorage` + `ensureLoaded` instead.
 */
export interface GetIdentityRequest {
  id: string;
  type: "getIdentity";
  /**
   * Scope the answer to this account. Omitted is permissive (answers for whatever record
   * is there, today's behavior) — deliberately, since some callers (the OAuth callback's
   * pre-check, before `register()` has minted a token) have no account id available yet.
   * See `worker-handler.ts`'s `belongsTo`.
   */
  accountId?: string;
}

/**
 * What this browser has stored, and under which scheme — the input to the
 * loading/no-keys/needs-migration decision.
 */
export interface DescribeStorageRequest {
  id: string;
  type: "describeStorage";
  /** Same permissive-when-omitted scoping as `GetIdentityRequest.accountId`. */
  accountId?: string;
}

/** Load and unwrap the stored key material into worker memory. No user interaction for
 * `"device"` mode; a biometric gesture for `"prf"`. */
export interface EnsureLoadedRequest {
  id: string;
  type: "ensureLoaded";
  /** Same permissive-when-omitted scoping as `GetIdentityRequest.accountId`. */
  accountId?: string;
  /** Required for a `"prf"` record — see `InitRequest.wrapKey`. */
  wrapKey?: CryptoKey;
}

/** One-time upgrade of a pre-Phase-5 PIN-wrapped record to the current shape. */
export interface MigrateFromPinRequest {
  id: string;
  type: "migrateFromPin";
  pin: string;
  mode: KeyWrapMode;
  wrapKey?: CryptoKey;
  credentialId?: Uint8Array;
}

/** Sign a server-issued `keys/bind` nonce over `accountId‖contentPubKey‖nonce`. */
export interface BindKeysProofRequest {
  id: string;
  type: "bindKeysProof";
  accountId: string;
  nonce: string;
}

/** CLI pairing approval: seal the master secret + the new device's refresh token to its
 * ephemeral X25519 public key. */
export interface SealForPeerRequest {
  id: string;
  type: "sealForPeer";
  ephPub: string;
  refreshToken: string;
}

/**
 * Start asking another device for a copy of the keys. Generates an ephemeral X25519
 * keypair inside the worker — the secret half never crosses postMessage — and returns
 * only the public half, base64.
 */
export interface BeginKeyRequestRequest {
  id: string;
  type: "beginKeyRequest";
}

/**
 * Open a sealed `[0x02 | masterSecret]` box produced by a holder device, using an
 * ephemeral secret key `beginKeyRequest` is holding. On success, derives the key tree and
 * persists it. Resolves `false` on any failure.
 */
export interface AcceptKeyResponseRequest {
  id: string;
  type: "acceptKeyResponse";
  sealed: string;
  mode: KeyWrapMode;
  wrapKey?: CryptoKey;
  credentialId?: Uint8Array;
}

/**
 * Holder side: seal ONLY the master secret to a peer's ephemeral public key — no refresh
 * token, because the requesting device already has its own session.
 */
export interface SealKeysForPeerRequest {
  id: string;
  type: "sealKeysForPeer";
  ephPub: string;
}

export type CryptoWorkerRequest =
  | InitRequest
  | SetSessionKeyRequest
  | CreateDekRequest
  | SealRequest
  | OpenRequest
  | SealBlobRequest
  | OpenBlobRequest
  | ClearRequest
  | GetIdentityRequest
  | DescribeStorageRequest
  | EnsureLoadedRequest
  | MigrateFromPinRequest
  | SealForPeerRequest
  | BindKeysProofRequest
  | SetRefreshTokenRequest
  | RefreshSessionRequest
  | BeginKeyRequestRequest
  | AcceptKeyResponseRequest
  | SealKeysForPeerRequest
  | HashWorkspacePathRequest;

export interface DeviceIdentity {
  signPubKey: string;
  contentPubKey: string;
}

export interface BindKeysProofResult extends DeviceIdentity {
  signature: string;
}

export interface StorageDescription {
  present: boolean;
  /** 1 = pre-Phase-5 PIN record needing migration, 2 = current. */
  version: 1 | 2;
  mode: KeyWrapMode | null;
  /** For a `"prf"` record — the main thread needs it to re-derive the wrap key. Not a
   * secret: it identifies a passkey, it does not unlock one. */
  credentialId: Uint8Array | null;
}

/**
 * Why a refresh did or didn't produce a token. Deliberately NOT a bare `string | null`:
 * "server rejected" and "request never arrived" must be distinct — conflating them can turn
 * a transient network/config failure into a total sign-out for all users.
 */
export type RefreshOutcome =
  | { kind: "ok"; accessToken: string }
  /** Nothing stored to refresh with — a genuinely signed-out browser. */
  | { kind: "no-credential" }
  /** The server answered 401/403: dead, revoked, or replayed. Sign out. */
  | { kind: "rejected" }
  /** The request failed or answered something unusable. Keep the session; retry. */
  | { kind: "unreachable" };

export interface CreateDekResult {
  /** Base64, ready to send as `WorkspaceRow.dek`/`SessionRow.dek`-shaped wire fields. */
  wrappedDek: string;
  box: EncryptedBox;
}

export interface CryptoWorkerResults {
  init: null;
  setSessionKey: boolean;
  createDek: CreateDekResult;
  seal: EncryptedBox;
  open: unknown;
  sealBlob: Uint8Array;
  openBlob: Uint8Array | null;
  clear: null;
  getIdentity: DeviceIdentity | null;
  describeStorage: StorageDescription;
  ensureLoaded: boolean;
  migrateFromPin: boolean;
  sealForPeer: string;
  bindKeysProof: BindKeysProofResult;
  setRefreshToken: null;
  refreshSession: RefreshOutcome;
  beginKeyRequest: string;
  acceptKeyResponse: boolean;
  sealKeysForPeer: string;
  hashWorkspacePath: string;
}

export interface CryptoWorkerOkResponse<T = unknown> {
  id: string;
  ok: true;
  result: T;
}

export interface CryptoWorkerErrResponse {
  id: string;
  ok: false;
  error: string;
}

export type CryptoWorkerResponse<T = unknown> = CryptoWorkerOkResponse<T> | CryptoWorkerErrResponse;

/**
 * `Omit<CryptoWorkerRequest, "id">` is NOT distributive over the request union — TypeScript
 * collapses the union to its common shape first. This distributes member-by-member (naked
 * type parameter in a conditional type) so each request keeps its own required fields.
 */
export type CryptoWorkerRequestPayload<T = CryptoWorkerRequest> = T extends CryptoWorkerRequest
  ? Omit<T, "id">
  : never;
