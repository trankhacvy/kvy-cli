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
  SignInChallengeResult,
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
  /** Provision the master secret: persists it (in the worker, via IndexedDB) and derives the key tree. */
  init(masterSecret: Uint8Array): Promise<void>;
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
  /** The account identity provisioned on this device, or `null` if none yet. */
  getIdentity(): Promise<DeviceIdentity | null>;
  /** Mint a fresh signed challenge for `POST /v1/auth`. Rejects if not initialized. */
  signInChallenge(): Promise<SignInChallengeResult>;
  /** Export the provisioned master secret as a grouped-Base32 recovery code. */
  exportRecoveryCode(): Promise<string>;
  /** Seal the master secret to a pairing peer's ephemeral X25519 public key (base64). */
  sealForPeer(ephPub: string): Promise<string>;
  /** Sign a server-issued `keys/bind` nonce (issue-4-plan.md §6.2). Rejects if not initialized. */
  bindKeysProof(accountId: string, nonce: string): Promise<BindKeysProofResult>;
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
    init: (masterSecret) => call<null>({ type: "init", masterSecret }).then(() => undefined),
    setSessionKey: (wrappedDek) => call<boolean>({ type: "setSessionKey", wrappedDek }),
    seal: (data) => call<EncryptedBox>({ type: "seal", data }),
    open: <T>(box: EncryptedBox) => call<T | null>({ type: "open", box }),
    sealBlob: (data) => call<Uint8Array>({ type: "sealBlob", data }),
    openBlob: (bundle) => call<Uint8Array | null>({ type: "openBlob", bundle }),
    clear: () => call<null>({ type: "clear" }).then(() => undefined),
    getIdentity: () => call<DeviceIdentity | null>({ type: "getIdentity" }),
    signInChallenge: () => call<SignInChallengeResult>({ type: "signInChallenge" }),
    exportRecoveryCode: () => call<string>({ type: "exportRecoveryCode" }),
    sealForPeer: (ephPub) => call<string>({ type: "sealForPeer", ephPub }),
    bindKeysProof: (accountId, nonce) =>
      call<BindKeysProofResult>({ type: "bindKeysProof", accountId, nonce }),
    terminate: () => {
      rejectAllPending(new Error("crypto-bridge worker terminated"));
      worker.terminate?.();
    },
  };
}
