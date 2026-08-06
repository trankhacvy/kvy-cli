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
import type { EncryptedBox } from "@kvy/crypto/web";
import type { KeyProtection } from "./key-protection.js";
import type {
  BindKeysProofResult,
  CreateDekResult,
  CryptoWorkerRequest,
  CryptoWorkerRequestPayload,
  CryptoWorkerResponse,
  DeviceIdentity,
  RefreshOutcome,
  StorageDescription,
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
  /** Provision the master secret: wraps and persists it under `mode`, tagged with
   * `accountId` (whose keys these are — see `StoredKeyRecordV2.accountId`), and derives
   * the key tree in worker memory. `refreshToken` goes to the separate session store. */
  init(
    masterSecret: Uint8Array,
    refreshToken: string,
    accountId: string,
    protection: KeyProtection,
  ): Promise<void>;
  /** What this browser has stored, and under which scheme. The input to the
   * loading/no-keys/needs-migration decision — `getIdentity()` must NOT be used for that,
   * because it answers for a pre-Phase-5 record too.
   * `accountId` scopes the answer: omit it for today's permissive (whatever-is-there)
   * behavior, or pass it to get `present: false` back for a record known to belong to a
   * different account. */
  describeStorage(accountId?: string): Promise<StorageDescription>;
  /** Load and unwrap stored key material into worker memory. No interaction for
   * `"device"` mode; a biometric gesture for `"prf"`. False if there is nothing usable, or
   * if `accountId` is given and the loaded/stored record is known to belong to someone
   * else. */
  ensureLoaded(accountId?: string, wrapKey?: CryptoKey): Promise<boolean>;
  /** One-time upgrade of a pre-Phase-5 PIN-wrapped record. False on a wrong PIN. */
  migrateFromPin(pin: string, protection: KeyProtection): Promise<boolean>;
  /** Unwrap a per-session DEK and hold it as the active session key. Resolves `false` on a bad/foreign DEK. */
  setSessionKey(wrappedDek: Uint8Array): Promise<boolean>;
  /** Mint a fresh DEK, wrap it to this device's own content public key, and seal `data`
   * under it — for a web-originated encrypted entity rather than one relayed from the CLI. */
  createDek(data: unknown): Promise<CreateDekResult>;
  /** Seal `data` under the active session key. */
  seal(data: unknown): Promise<EncryptedBox>;
  /** Open `box` with the active session key. Resolves `null` on any decryption failure. */
  open<T = unknown>(box: EncryptedBox): Promise<T | null>;
  /** Encrypt binary `data` (e.g. a composer attachment) under the active session's blob key. Result is ready to `PUT` at a blob-storage upload target. */
  sealBlob(data: Uint8Array): Promise<Uint8Array>;
  /** Decrypt a downloaded blob's bytes under the active session's blob key. Resolves `null` on any decryption failure. */
  openBlob(bundle: Uint8Array): Promise<Uint8Array | null>;
  /** Wipe in-memory keys and persisted key material (logout). */
  clear(): Promise<void>;
  /** The account identity provisioned on this device, or `null` if none yet (or, when
   * `accountId` is given, none belonging to that account). Never requires an unlock. */
  getIdentity(accountId?: string): Promise<DeviceIdentity | null>;
  /** Seal the master secret + the current session's refresh token to a pairing peer's
   * ephemeral X25519 public key (base64). Requires the worker to be unlocked. */
  sealForPeer(ephPub: string, refreshToken: string): Promise<string>;
  /** Sign a server-issued `keys/bind` nonce. Rejects if not initialized/locked. */
  bindKeysProof(accountId: string, nonce: string): Promise<BindKeysProofResult>;
  /** Persist a freshly-issued or freshly-rotated refresh token. Needs no key material —
   * a signed-in browser with no keys must still be able to hold a session. */
  setRefreshToken(refreshToken: string): Promise<void>;
  /** Mint a fresh access token from the stored refresh token via a real
   * `/v1/auth/refresh` call made from inside the worker — the raw refresh token never
   * crosses back out to the main thread. Never rejects — resolves a `RefreshOutcome`
   * distinguishing "nothing to refresh with", "the server rejected it", and "the request
   * never got anywhere" (see `RefreshOutcome`'s docblock). */
  refreshSession(): Promise<RefreshOutcome>;
  /** Generate an ephemeral keypair inside the worker and return only its public half. */
  beginKeyRequest(): Promise<string>;
  /** Open a sealed `[0x02 | masterSecret]` box with an ephemeral secret the worker still
   * holds, then derive and persist. Resolves `false` on any failure. */
  acceptKeyResponse(sealed: string, protection: KeyProtection): Promise<boolean>;
  /** Seal ONLY the master secret to a peer's ephemeral public key — the requesting device
   * already has its own session. */
  sealKeysForPeer(ephPub: string): Promise<string>;
  /** Deterministic, server-unguessable blind index for a workspace's real absolute path —
   * the `POST /v1/workspaces` create-or-get key. The path never leaves the worker; only
   * the hash comes back. */
  hashWorkspacePath(path: string): Promise<string>;
  /** Terminate the underlying worker. */
  terminate(): void;
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `cb-${requestCounter}`;
}

// How long `terminate()` waits for in-flight requests to settle for real before killing
// the worker thread outright — see `terminate()`'s own doc comment for why this exists.
const TERMINATE_DRAIN_TIMEOUT_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCryptoBridgeClient(worker: WorkerLike): CryptoBridgeClient {
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  // Resolved (in FIFO order, doesn't matter which) the moment `pending` empties out —
  // `terminate()`'s drain waits on this instead of polling.
  let drainWaiters: Array<() => void> = [];

  function notifyIfDrained(): void {
    if (pending.size !== 0 || drainWaiters.length === 0) return;
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const waiter of waiters) waiter();
  }

  function waitForDrain(): Promise<void> {
    if (pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.push(resolve));
  }

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
    notifyIfDrained();
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
    notifyIfDrained();
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
    init: (masterSecret, refreshToken, accountId, protection) =>
      call<null>({ type: "init", masterSecret, refreshToken, accountId, ...protection }).then(
        () => undefined,
      ),
    describeStorage: (accountId) =>
      call<StorageDescription>({ type: "describeStorage", accountId }),
    ensureLoaded: (accountId, wrapKey) =>
      call<boolean>({ type: "ensureLoaded", accountId, wrapKey }),
    migrateFromPin: (pin, protection) =>
      call<boolean>({ type: "migrateFromPin", pin, ...protection }),
    setSessionKey: (wrappedDek) => call<boolean>({ type: "setSessionKey", wrappedDek }),
    createDek: (data) => call<CreateDekResult>({ type: "createDek", data }),
    seal: (data) => call<EncryptedBox>({ type: "seal", data }),
    open: <T>(box: EncryptedBox) => call<T | null>({ type: "open", box }),
    sealBlob: (data) => call<Uint8Array>({ type: "sealBlob", data }),
    openBlob: (bundle) => call<Uint8Array | null>({ type: "openBlob", bundle }),
    clear: () => call<null>({ type: "clear" }).then(() => undefined),
    getIdentity: (accountId) => call<DeviceIdentity | null>({ type: "getIdentity", accountId }),
    sealForPeer: (ephPub, refreshToken) =>
      call<string>({ type: "sealForPeer", ephPub, refreshToken }),
    bindKeysProof: (accountId, nonce) =>
      call<BindKeysProofResult>({ type: "bindKeysProof", accountId, nonce }),
    setRefreshToken: (refreshToken) =>
      call<null>({ type: "setRefreshToken", refreshToken }).then(() => undefined),
    refreshSession: () => call<RefreshOutcome>({ type: "refreshSession" }),
    beginKeyRequest: () => call<string>({ type: "beginKeyRequest" }),
    acceptKeyResponse: (sealed, protection) =>
      call<boolean>({ type: "acceptKeyResponse", sealed, ...protection }),
    sealKeysForPeer: (ephPub) => call<string>({ type: "sealKeysForPeer", ephPub }),
    hashWorkspacePath: (path) => call<string>({ type: "hashWorkspacePath", path }),
    terminate: () => {
      if (pending.size === 0) {
        rejectAllPending(new Error("crypto-bridge worker terminated"));
        worker.terminate?.();
        return;
      }
      // A request is still in flight against the worker — most likely
      // `key-storage.ts`'s `openDb()`-based load/save, which closes its IndexedDB
      // connection in a `finally` block once its transaction completes.
      // `Worker.terminate()` is abrupt and skips that `finally`: killing the thread
      // mid-transaction can leave the connection open with no code path left to ever
      // close it, wedging a later `indexedDB.deleteDatabase()`/`open()` call behind it
      // forever. Give in-flight requests a
      // bounded grace period to actually settle for real before rejecting them and
      // killing the thread — a request that genuinely answers in that window resolves
      // with its real result, same as if `terminate()` were never called.
      void Promise.race([waitForDrain(), delay(TERMINATE_DRAIN_TIMEOUT_MS)]).then(() => {
        rejectAllPending(new Error("crypto-bridge worker terminated"));
        worker.terminate?.();
      });
    },
  };
}
