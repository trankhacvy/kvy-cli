/**
 * Persistence for the crypto worker's master secret. The worker (not the
 * main thread) owns this store: it's opened and read from inside
 * `worker.ts`, at worker startup, so the raw secret bytes never have to
 * cross the postMessage boundary to be loaded — design §9.1 ("keys live in
 * worker memory, loaded from IndexedDB at startup").
 */

export interface KeyStorage {
  save(masterSecret: Uint8Array): Promise<void>;
  load(): Promise<Uint8Array | null>;
  clear(): Promise<void>;
}

const DB_NAME = "falcon-crypto-bridge";
const DB_VERSION = 1;
const STORE_NAME = "keys";
const MASTER_SECRET_KEY = "masterSecret";

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
    async save(masterSecret) {
      const db = await openDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).put(masterSecret, MASTER_SECRET_KEY);
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
        return await new Promise<Uint8Array | null>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readonly");
          const req = tx.objectStore(STORE_NAME).get(MASTER_SECRET_KEY);
          req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null);
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
          tx.objectStore(STORE_NAME).delete(MASTER_SECRET_KEY);
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
  let stored: Uint8Array | null = null;
  return {
    async save(masterSecret) {
      stored = masterSecret;
    },
    async load() {
      return stored;
    },
    async clear() {
      stored = null;
    },
  };
}
