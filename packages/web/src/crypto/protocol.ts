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

/** Wipe in-memory keys and cached IndexedDB key material (logout). */
export interface ClearRequest {
  id: string;
  type: "clear";
}

export type CryptoWorkerRequest =
  | InitRequest
  | SetSessionKeyRequest
  | SealRequest
  | OpenRequest
  | ClearRequest;

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
  clear: null;
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

export type CryptoWorkerResponse<T = unknown> =
  | CryptoWorkerOkResponse<T>
  | CryptoWorkerErrResponse;

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
