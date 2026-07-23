/**
 * Main-thread client for the crypto-bridge worker. Talks to the worker
 * purely via postMessage RPC (`protocol.ts`) — this module never has access
 * to key material, only whatever the worker chooses to hand back (ciphertext,
 * booleans, decrypted view-model data). See worker-handler.ts for the
 * guarantee that raw keys never appear in a response.
 *
 * `WorkerLike` is the minimal surface this needs from a `Worker` — narrow
 * enough that tests can swap in an in-process double (see
 * `__tests__/loopback.ts`) instead of spinning up a real Worker thread.
 */
import type { EncryptedBox } from "@falcon/crypto/web";
import type {
  BindKeysProofResult,
  CryptoWorkerRequest,
  CryptoWorkerRequestPayload,
  CryptoWorkerResponse,
  DeviceIdentity,
} from "./protocol.js";

export interface WorkerLike {
  postMessage(message: CryptoWorkerRequest): void;
  onmessage: ((event: MessageEvent<CryptoWorkerResponse>) => void) | null;
  /** Fired when the worker thread itself crashes (e.g. a script/module load
   * error) — as opposed to an RPC-level error, which comes back through
   * `onmessage` as `{ ok: false }` and is handled there. Optional so existing
   * `WorkerLike` doubles that never crash don't need to implement it. */
  onerror?: ((event: ErrorEvent) => void) | null;
  terminate?(): void;
}

export interface CryptoBridgeClient {
  /** Provision the master secret: PIN-wraps and persists it (in the worker, via
   * IndexedDB — issue-4-plan.md §6.1) and derives the key tree in worker memory.
   * `refreshToken` is PIN-wrapped and persisted the same way (security review F1) —
   * it never touches `localStorage`. */
  init(masterSecret: Uint8Array, pin: string, refreshToken: string): Promise<void>;
  /** Load the PIN-wrapped master secret (and refresh token, if one was ever set) from
   * storage and unwrap them into worker memory. Resolves `false` on a wrong PIN.
   * Rejects if nothing was ever provisioned on this device (`not-initialized`). */
  unlock(pin: string): Promise<boolean>;
  /** Unwrap a per-session DEK and hold it as the active session key. Resolves `false` on a bad/foreign DEK. */
  setSessionKey(wrappedDek: Uint8Array): Promise<boolean>;
  /** Seal `data` under the active session key. */
  seal(data: unknown): Promise<EncryptedBox>;
  /** Open `box` with the active session key. Resolves `null` on any decryption failure. */
  open<T = unknown>(box: EncryptedBox): Promise<T | null>;
  /** Encrypt binary `data` (e.g. a composer attachment) under the active session's blob key — the encrypted attachment path (falcon-system-design.md §5.1, plan.md §16 "4.3 Distribution & self-host"). Result is ready to `PUT` at a blob-storage upload target. */
  sealBlob(data: Uint8Array): Promise<Uint8Array>;
  /** Decrypt a downloaded blob's bytes under the active session's blob key. Resolves `null` on any decryption failure. */
  openBlob(bundle: Uint8Array): Promise<Uint8Array | null>;
  /** Wipe in-memory keys and persisted key material (logout). */
  clear(): Promise<void>;
  /** The account identity provisioned on this device, or `null` if none yet. Never requires an unlock. */
  getIdentity(): Promise<DeviceIdentity | null>;
  /** Seal the master secret + the current session's refresh token to a pairing
   * peer's ephemeral X25519 public key (base64) — issue-4-plan.md §6.3. Requires the
   * worker to be unlocked. */
  sealForPeer(ephPub: string, refreshToken: string): Promise<string>;
  /** Sign a server-issued `keys/bind` nonce (issue-4-plan.md §6.2). Rejects if not initialized/locked. */
  bindKeysProof(accountId: string, nonce: string): Promise<BindKeysProofResult>;
  /** F1: PIN-wraps and persists a (freshly-issued or freshly-rotated) refresh token
   * against an already-provisioned identity, without touching the master secret's own
   * wrapped blob — the returning-device login path, where `init` never runs again.
   * Requires the worker to already be unlocked. */
  setRefreshToken(refreshToken: string): Promise<void>;
  /** F1: mints a fresh access token from the in-memory (PIN-recovered) refresh token via
   * a real `/v1/auth/refresh` call made from inside the worker — the raw refresh token
   * never crosses back out to the main thread. Resolves `null` (never rejects) when
   * there's nothing to refresh with, or the server rejects it (dead/revoked). */
  refreshSession(): Promise<string | null>;
  /** Terminate the underlying worker. */
  terminate(): void;
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `cb-${requestCounter}`;
}

export function createCryptoBridgeClient(worker: WorkerLike): CryptoBridgeClient {
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();

  worker.onmessage = (event) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) {
      return;
    }
    pending.delete(response.id);
    if (response.ok) {
      entry.resolve(response.result);
    } else {
      entry.reject(new Error(response.error));
    }
  };

  /**
   * Without this, a worker that fails to load (or crashes outside the
   * request/response cycle handled in `onmessage`) would leave every
   * in-flight caller awaiting a promise that never settles — a silent hang
   * rather than a visible error.
   */
  function rejectAllPending(reason: Error): void {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(reason);
    }
  }

  worker.onerror = (event) => {
    const message = event?.message || "crypto worker crashed";
    rejectAllPending(new Error(`crypto-bridge worker error: ${message}`));
  };

  function call<T>(request: CryptoWorkerRequestPayload): Promise<T> {
    const id = nextRequestId();
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, ...request } as CryptoWorkerRequest);
    });
  }

  return {
    init: (masterSecret, pin, refreshToken) =>
      call<null>({ type: "init", masterSecret, pin, refreshToken }).then(() => undefined),
    unlock: (pin) => call<boolean>({ type: "unlock", pin }),
    setSessionKey: (wrappedDek) => call<boolean>({ type: "setSessionKey", wrappedDek }),
    seal: (data) => call<EncryptedBox>({ type: "seal", data }),
    open: <T>(box: EncryptedBox) => call<T | null>({ type: "open", box }),
    sealBlob: (data) => call<Uint8Array>({ type: "sealBlob", data }),
    openBlob: (bundle) => call<Uint8Array | null>({ type: "openBlob", bundle }),
    clear: () => call<null>({ type: "clear" }).then(() => undefined),
    getIdentity: () => call<DeviceIdentity | null>({ type: "getIdentity" }),
    sealForPeer: (ephPub, refreshToken) =>
      call<string>({ type: "sealForPeer", ephPub, refreshToken }),
    bindKeysProof: (accountId, nonce) =>
      call<BindKeysProofResult>({ type: "bindKeysProof", accountId, nonce }),
    setRefreshToken: (refreshToken) =>
      call<null>({ type: "setRefreshToken", refreshToken }).then(() => undefined),
    refreshSession: () => call<string | null>({ type: "refreshSession" }),
    terminate: () => {
      rejectAllPending(new Error("crypto-bridge worker terminated"));
      worker.terminate?.();
    },
  };
}
