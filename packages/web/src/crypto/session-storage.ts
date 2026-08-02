/**
 * The SESSION credential (refresh token), stored separately from the CONTENT credential
 * (master secret).
 *
 * Identity and key custody are separate systems, but the storage layer originally fused
 * them: the refresh token lived inside the master secret's record, so a browser with no
 * keys could not hold a session at all. That made the "signed in, no keys" state
 * unreachable — which is precisely the state device-to-device key sharing operates in.
 *
 * ⚠️ This is a deliberate, signed-off partial walk-back of security review finding F1,
 * which moved the refresh token into the PIN-wrapped record to get it out of
 * `localStorage`. It is still not in `localStorage`, and it is wrapped (see
 * `device-key.ts` for the honest scope of that wrap — it is not an XSS defense).
 *
 * Why that is acceptable for THIS credential and would not be for the master secret: the
 * refresh token rotates on every use, is theft-detectable (a replay revokes the whole
 * family — server/src/app/routes/refresh.ts), is revocable per device from
 * Settings → Devices, and expires absolutely after 60 days. The master secret has none of
 * those properties — it decrypts everything, forever, and cannot be rotated without
 * destroying past sessions.
 */
import { createWrapKey, unwrapBytes, type WrappedBytes, wrapBytes } from "./device-key.js";

export interface StoredSessionRecord {
  v: 1;
  wrapKey: CryptoKey;
  wrapped: WrappedBytes;
}

export interface SessionStorage {
  save(refreshToken: string): Promise<void>;
  load(): Promise<string | null>;
  clear(): Promise<void>;
  /** Wipe the record AND remove the database itself — see `KeyStorage.destroy`'s docblock
   * for why this is safe to call from the worker and what "both are gone" means. */
  destroy(): Promise<void>;
}

const DB_NAME = "kvy-session";
const DB_VERSION = 1;
const STORE_NAME = "session";
const RECORD_KEY = "sessionRecord";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("failed to open session store"));
  });
}

function readRecord(db: IDBDatabase): Promise<StoredSessionRecord | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
    req.onsuccess = () => resolve((req.result as StoredSessionRecord | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error("failed to read the session record"));
  });
}

function writeRecord(db: IDBDatabase, record: StoredSessionRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record, RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("failed to write the session record"));
  });
}

export function createIndexedDbSessionStorage(): SessionStorage {
  return {
    async save(refreshToken) {
      const db = await openDb();
      try {
        const existing = await readRecord(db);
        const wrapKey = existing?.wrapKey ?? (await createWrapKey());
        const wrapped = await wrapBytes(wrapKey, new TextEncoder().encode(refreshToken));
        await writeRecord(db, { v: 1, wrapKey, wrapped });
      } finally {
        db.close();
      }
    },
    async load() {
      const db = await openDb();
      try {
        const record = await readRecord(db);
        if (record?.v !== 1) return null;
        const bytes = await unwrapBytes(record.wrapKey, record.wrapped);
        return bytes ? new TextDecoder().decode(bytes) : null;
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
          tx.onerror = () => reject(tx.error ?? new Error("failed to clear the session record"));
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

/** In-memory session storage — used by tests, which run outside a browser/IndexedDB. */
export function createMemorySessionStorage(): SessionStorage {
  let stored: string | null = null;
  return {
    async save(refreshToken) {
      stored = refreshToken;
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
