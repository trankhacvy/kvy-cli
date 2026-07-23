/**
 * Persistence for the crypto worker's key material. The worker (not the main
 * thread) owns this store: it's opened and read from inside `worker.ts`, at
 * worker startup, so key bytes never have to cross the postMessage boundary
 * to be loaded — design §9.1 ("keys live in worker memory, loaded from
 * IndexedDB at startup").
 *
 * issue-4-plan.md §6.1/§6.4: the master secret itself is never stored raw —
 * only PIN-wrapped (`wrapped`, AES-256-GCM under an argon2id-derived key, see
 * `@falcon/crypto`'s `wrapWithPin`). The two public identity keys are kept
 * alongside it in the clear so `getIdentity()` can answer "does this browser
 * already have an identity" (known-device vs. new-device, for the sign-in
 * page) without requiring a PIN unlock first.
 *
 * Security review finding F1: the 60-day refresh token used to live in plain
 * `localStorage` (fully XSS-readable, undoing the whole point of the 15-minute
 * access-token hardening). It's now PIN-wrapped here too (`wrappedRefreshToken`,
 * same `wrapWithPin` mechanism, own nonce/salt) — recovered only by the same PIN
 * unlock that recovers the master secret, and re-wrapped in place every time it
 * rotates (`lib/session.ts`'s `silentRefresh`, `crypto/worker-handler.ts`'s
 * `refreshSession`/`setRefreshToken`). Optional because a record can exist with
 * a master secret but no refresh token yet (e.g. mid-signup, before the first
 * `setRefreshToken` call lands).
 */
import type { PinWrapped } from "@falcon/crypto/web";

export interface StoredKeyRecord {
  wrapped: PinWrapped;
  signPubKey: string;
  contentPubKey: string;
  wrappedRefreshToken?: PinWrapped;
}

export interface KeyStorage {
  save(record: StoredKeyRecord): Promise<void>;
  load(): Promise<StoredKeyRecord | null>;
  clear(): Promise<void>;
}

const DB_NAME = "falcon-crypto-bridge";
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

/** Real, browser IndexedDB-backed key storage — used by the worker at runtime. */
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
        return await new Promise<StoredKeyRecord | null>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readonly");
          const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
          req.onsuccess = () => resolve((req.result as StoredKeyRecord | undefined) ?? null);
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
  };
}

/** In-memory key storage — used by tests, which run outside a browser/IndexedDB. */
export function createMemoryKeyStorage(): KeyStorage {
  let stored: StoredKeyRecord | null = null;
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
  };
}
