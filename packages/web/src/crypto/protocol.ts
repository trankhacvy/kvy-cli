/**
 * crypto-bridge RPC protocol — the postMessage-shaped contract between the
 * main thread (`client.ts`) and the crypto worker (`worker.ts` /
 * `worker-handler.ts`). See falcon-system-design.md §5.3, §9.1: keys must
 * live in worker memory only, so every response shape here is deliberately
 * incapable of carrying raw key material — only ciphertext (`EncryptedBox`)
 * or booleans/void cross back out.
 */
import type { EncryptedBox } from "@falcon/crypto/web";

/**
 * Provision the master secret: PIN-wraps it (issue-4-plan.md §6.1) and persists the
 * wrapped blob (+ the plaintext public identity keys) to IndexedDB, then derives the
 * key tree in worker memory so the freshly-provisioned device is immediately usable
 * without a separate `unlock` round trip. Also PIN-wraps and persists `refreshToken`
 * the same way (security review finding F1: the refresh token never touches
 * `localStorage` — it only ever exists PIN-wrapped here, or in worker memory after an
 * `unlock`/`init`).
 */
export interface InitRequest {
  id: string;
  type: "init";
  masterSecret: Uint8Array;
  pin: string;
  refreshToken: string;
}

/**
 * Wraps and persists a (freshly-issued or freshly-rotated) refresh token against an
 * ALREADY-provisioned identity, without touching the master secret's own wrapped blob
 * — the returning-device login path (`complete-password-sign-in.ts`'s
 * `completePasswordSignIn`), where `init` never runs again. Requires the worker to
 * already be unlocked (the PIN is needed to wrap) — fails with `locked`/`not-initialized`
 * otherwise.
 */
export interface SetRefreshTokenRequest {
  id: string;
  type: "setRefreshToken";
  refreshToken: string;
}

/**
 * F1: mints a fresh access token from the in-memory refresh token via a real
 * `POST /v1/auth/refresh` call made FROM INSIDE THE WORKER — the raw refresh token
 * never has to cross back out to the main thread to do this. On success, re-wraps and
 * persists the rotated refresh token the server returns (so the next `unlock` recovers
 * the CURRENT one, not one the server will reject as a replay) and resolves the fresh
 * access token (safe to hold in ordinary main-thread memory — it's short-lived and
 * carries no more authority than any other bearer token this app already sends over
 * HTTP). Resolves `null` (never rejects) when there's no refresh token to use, or the
 * server rejects it (dead/revoked) — the caller is responsible for treating that as
 * "signed out".
 */
export interface RefreshSessionRequest {
  id: string;
  type: "refreshSession";
}

/**
 * Load the PIN-wrapped master secret from storage and unwrap it into worker memory.
 * Resolves `true` on success, `false` on a wrong PIN (never throws for that case —
 * mirrors `unwrapWithPin`'s own never-throw contract). Rejects with `not-initialized`
 * if no key material has ever been provisioned on this device.
 */
export interface UnlockRequest {
  id: string;
  type: "unlock";
  pin: string;
}

/** Unwrap a per-session DEK with the in-memory content secret key and hold it as the active session key. */
export interface SetSessionKeyRequest {
  id: string;
  type: "setSessionKey";
  wrappedDek: Uint8Array;
}

/** Seal `data` under the active session DEK. */
export interface SealRequest {
  id: string;
  type: "seal";
  data: unknown;
}

/** Open `box` with the active session DEK. */
export interface OpenRequest {
  id: string;
  type: "open";
  box: EncryptedBox;
}

/**
 * Encrypt binary `data` under the active session's blob key —
 * `deriveBlobKey(activeDek)` (falcon-system-design.md §5.1: "blob key:
 * HKDF(DEK, "falcon-blobs") → attachments isolated from text"), never the
 * DEK itself — backing the composer's encrypted attachment path (plan.md
 * §16 "4.3 Distribution & self-host"). Result is raw `encryptBlob` output
 * bytes, ready to `PUT` at a blob-storage upload target.
 */
export interface SealBlobRequest {
  id: string;
  type: "sealBlob";
  data: Uint8Array;
}

/** Inverse of `SealBlobRequest`: decrypt a downloaded blob's bytes under the same session blob key. */
export interface OpenBlobRequest {
  id: string;
  type: "openBlob";
  bundle: Uint8Array;
}

/** Wipe in-memory keys and cached IndexedDB key material (logout). */
export interface ClearRequest {
  id: string;
  type: "clear";
}

/**
 * Report the account identity provisioned on this device, if any — read
 * straight from the stored record's plaintext public keys, so it answers
 * without requiring a PIN unlock first (used by the sign-in page to decide
 * "known device, prompt for PIN" vs "new device, show sign-up").
 */
export interface GetIdentityRequest {
  id: string;
  type: "getIdentity";
}

/**
 * CLI pairing approval (design §5.2 "CLI pairing", issue-4-plan.md §6.3): seal this
 * device's master secret AND the current session's refresh token to a new device's
 * ephemeral X25519 public key (`ephPub`, base64), so both can be relayed through the
 * server without it ever reading either. Requires the worker to be unlocked (the raw
 * master secret must be in memory) — fails with `locked`/`not-initialized` otherwise.
 */
export interface SealForPeerRequest {
  id: string;
  type: "sealForPeer";
  ephPub: string;
  refreshToken: string;
}

/**
 * issue-4-plan.md §6.2 "keys/bind": sign the server-issued nonce so
 * `POST /v1/auth/keys/bind` can verify this device really holds the identity's
 * signing secret key. The signed payload is `accountId‖contentPubKey‖nonce`
 * (matching `server/src/app/routes/keys.ts` byte-for-byte) — a bare signed
 * nonce alone would let a signature minted for one account/content-key pair
 * be replayed against another.
 */
export interface BindKeysProofRequest {
  id: string;
  type: "bindKeysProof";
  accountId: string;
  nonce: string;
}

export type CryptoWorkerRequest =
  | InitRequest
  | UnlockRequest
  | SetSessionKeyRequest
  | SealRequest
  | OpenRequest
  | SealBlobRequest
  | OpenBlobRequest
  | ClearRequest
  | GetIdentityRequest
  | SealForPeerRequest
  | BindKeysProofRequest
  | SetRefreshTokenRequest
  | RefreshSessionRequest;

/** Public identity (base64-encoded keys) provisioned on this device. */
export interface DeviceIdentity {
  signPubKey: string;
  contentPubKey: string;
}

/** Everything `POST /v1/auth/keys/bind` needs, for the caller's `nonce`. */
export interface BindKeysProofResult extends DeviceIdentity {
  signature: string;
}

/**
 * Result payload per request type — kept as a lookup map so `client.ts` can
 * type each RPC call's return value from a single source of truth. None of
 * these shapes can carry raw key bytes.
 */
export interface CryptoWorkerResults {
  init: null;
  unlock: boolean;
  setSessionKey: boolean;
  seal: EncryptedBox;
  open: unknown | null;
  sealBlob: Uint8Array;
  openBlob: Uint8Array | null;
  clear: null;
  getIdentity: DeviceIdentity | null;
  sealForPeer: string;
  bindKeysProof: BindKeysProofResult;
  setRefreshToken: null;
  refreshSession: string | null;
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
 * `Omit<CryptoWorkerRequest, "id">` is NOT distributive over the request
 * union — TypeScript first collapses the union to its common shape, so a
 * `{ type: "init", masterSecret }` literal would only be checked against the
 * intersection of every member's fields. This distributes member-by-member
 * (naked type parameter in a conditional type) so each request's own extra
 * fields stay required and specific to its `type`.
 */
export type CryptoWorkerRequestPayload<T = CryptoWorkerRequest> = T extends CryptoWorkerRequest
  ? Omit<T, "id">
  : never;
