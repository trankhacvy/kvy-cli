/**
 * crypto-bridge RPC protocol — the postMessage-shaped contract between the
 * main thread (`client.ts`) and the crypto worker (`worker.ts` /
 * `worker-handler.ts`). See falcon-system-design.md §5.3, §9.1: keys must
 * live in worker memory only, so every response shape here is deliberately
 * incapable of carrying raw key material — only ciphertext (`EncryptedBox`)
 * or booleans/void cross back out.
 */
import type { EncryptedBox } from "@falcon/crypto/web";

/** Provision (and persist to IndexedDB) the master secret; derives the key tree in worker memory. */
export interface InitRequest {
  id: string;
  type: "init";
  masterSecret: Uint8Array;
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
 * Report the account identity provisioned on this device, if any — used by
 * the sign-in page to decide between a silent challenge/response login
 * (identity already present) and the OAuth sign-up flow (no identity yet).
 * Only ever returns public keys, never the master secret.
 */
export interface GetIdentityRequest {
  id: string;
  type: "getIdentity";
}

/**
 * Produce everything `POST /v1/auth` needs (design §5.2 "Sign-in"): a fresh
 * locally-generated challenge, its Ed25519 signature, and the account's
 * public keys. Fails with `not-initialized` if no identity has been
 * provisioned on this device yet.
 */
export interface SignInChallengeRequest {
  id: string;
  type: "signInChallenge";
}

/**
 * Export the provisioned master secret as a user-readable recovery code
 * (design §5.1 "Recovery"). This is the one deliberate exception to "keys
 * never leave the worker" — the whole point of a recovery code is to hand
 * the user their key material in backup-able form.
 */
export interface ExportRecoveryCodeRequest {
  id: string;
  type: "exportRecoveryCode";
}

/**
 * CLI pairing approval (design §5.2 "CLI pairing"): seal this device's master
 * secret to a new device's ephemeral X25519 public key (`ephPub`, base64),
 * so it can be relayed through the server without the server ever reading it.
 */
export interface SealForPeerRequest {
  id: string;
  type: "sealForPeer";
  ephPub: string;
}

export type CryptoWorkerRequest =
  | InitRequest
  | SetSessionKeyRequest
  | SealRequest
  | OpenRequest
  | SealBlobRequest
  | OpenBlobRequest
  | ClearRequest
  | GetIdentityRequest
  | SignInChallengeRequest
  | ExportRecoveryCodeRequest
  | SealForPeerRequest;

/** Public identity (base64-encoded keys) provisioned on this device. */
export interface DeviceIdentity {
  signPubKey: string;
  contentPubKey: string;
}

/** Everything `POST /v1/auth` needs, freshly minted. */
export interface SignInChallengeResult extends DeviceIdentity {
  challenge: string;
  signature: string;
}

/**
 * Result payload per request type — kept as a lookup map so `client.ts` can
 * type each RPC call's return value from a single source of truth. None of
 * these shapes can carry raw key bytes.
 */
export interface CryptoWorkerResults {
  init: null;
  setSessionKey: boolean;
  seal: EncryptedBox;
  open: unknown | null;
  sealBlob: Uint8Array;
  openBlob: Uint8Array | null;
  clear: null;
  getIdentity: DeviceIdentity | null;
  signInChallenge: SignInChallengeResult;
  exportRecoveryCode: string;
  sealForPeer: string;
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
