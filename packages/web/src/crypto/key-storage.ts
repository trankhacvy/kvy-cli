/**
 * Persistence for the crypto worker's key material. The worker owns this store — keys live
 * in worker memory, loaded from IndexedDB at startup.
 *
 * A v2 record wraps the master secret under one of two mechanisms, recorded in `mode`:
 *
 *   - `"prf"`    — the wrap key is re-derived per session from a passkey (`prf-key.ts`).
 *                  Key material never exists at rest; unlocking needs a biometric gesture.
 *   - `"device"` — the wrap key is a non-extractable `CryptoKey` stored right here
 *                  (`device-key.ts`). Zero friction, but same-origin script can use the
 *                  handle even though it can't export it.
 *
 * The two public identity keys stay in the clear so `getIdentity()` can answer "does this
 * browser have keys" without any unlock step.
 *
 * `wrappedRefreshToken` is gone from v2 — the session credential lives in its own store
 * (`session-storage.ts`) so a browser with no key material can still hold a session. It
 * remains on the v1 shape purely so the migration can carry it across.
 */
import type { PinWrapped } from "@kvy/crypto/web";
import type { WrappedBytes } from "./device-key.js";

export type KeyWrapMode = "prf" | "device";

export interface StoredKeyRecordV2 {
  v: 2;
  /**
   * Which account this key material belongs to (the access token's `sub`). Absent on
   * records written before this field existed — see `worker-handler.ts`'s `belongsTo`
   * for the legacy-adoption policy.
   *
   * This slot has always been single-tenant, but nothing recorded WHOSE keys were in it, so
   * signing into a second account on the same browser produced a worker loaded with the
   * first account's key tree and a silent `setSessionKey` failure on every session.
   */
  accountId?: string;
  mode: KeyWrapMode;
  /** Present only for `mode: "device"`. */
  wrapKey?: CryptoKey;
  /** Present only for `mode: "prf"`. */
  credentialId?: Uint8Array;
  wrapped: WrappedBytes;
  signPubKey: string;
  contentPubKey: string;
}

/**
 * The pre-Phase-5 PIN-wrapped record. It has no version field at all, so v1 detection is
 * "no `v` property" — not `v === 1`.
 */
export interface StoredKeyRecordV1 {
  v?: undefined;
  wrapped: PinWrapped;
  signPubKey: string;
  contentPubKey: string;
  wrappedRefreshToken?: PinWrapped;
}

export type AnyStoredKeyRecord = StoredKeyRecordV1 | StoredKeyRecordV2;

export function isV2Record(record: AnyStoredKeyRecord): record is StoredKeyRecordV2 {
  return record.v === 2;
}

export interface KeyStorage {
  save(record: StoredKeyRecordV2): Promise<void>;
  load(): Promise<AnyStoredKeyRecord | null>;
  clear(): Promise<void>;
  /**
   * Wipe the record AND remove the database itself. `clear()` empties the store but leaves
   * `kvy-crypto-bridge` enumerable by `indexedDB.databases()` after sign-out — the data is
   * gone, but the empty shell is not the same as "both are gone".
   *
   * Safe to call from the worker: every operation in this module opens and closes its own
   * connection, so nothing here is holding one open for `deleteDatabase` to block on. The
   * `onblocked` path still resolves rather than hanging — a connection from ANOTHER context
   * (the shared bridge worker, a second tab) can block the delete, and logout is
   * best-effort past the crypto step by design (`lib/logout.ts`).
   */
  destroy(): Promise<void>;
}

const DB_NAME = "kvy-crypto-bridge";
const DB_VERSION = 1;
const STORE_NAME = "keys";
const RECORD_KEY = "keyRecord";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("failed to open crypto key store"));
  });
}

export function createIndexedDbKeyStorage(): KeyStorage {
  return {
    async save(record) {
      const db = await openDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).put(record, RECORD_KEY);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("failed to save key material"));
        });
      } finally {
        db.close();
      }
    },
    async load() {
      const db = await openDb();
      try {
        return await new Promise<AnyStoredKeyRecord | null>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readonly");
          const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
          req.onsuccess = () => resolve((req.result as AnyStoredKeyRecord | undefined) ?? null);
          req.onerror = () => reject(req.error ?? new Error("failed to load key material"));
        });
      } finally {
        db.close();
      }
    },
    async clear() {
      const db = await openDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).delete(RECORD_KEY);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("failed to clear key material"));
        });
      } finally {
        db.close();
      }
    },
    async destroy() {
      await this.clear();
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      });
    },
  };
}

/** In-memory key storage — used by tests, which run outside a browser/IndexedDB. */
export function createMemoryKeyStorage(initial: AnyStoredKeyRecord | null = null): KeyStorage {
  let stored = initial;
  return {
    async save(record) {
      stored = record;
    },
    async load() {
      return stored;
    },
    async clear() {
      stored = null;
    },
    async destroy() {
      stored = null;
    },
  };
}
