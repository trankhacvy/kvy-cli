/**
 * Core crypto-bridge worker logic — the part of `worker.ts` that's actually
 * worth unit testing. Split out from the `self.onmessage` wiring so tests can
 * drive it directly (with an in-memory `KeyStorage`) without needing a real
 * Worker/IndexedDB.
 *
 * Trust boundary (falcon-system-design.md §5.3, §9.1): `keyTree` and
 * `activeDek` below are closed over by `handle()` and never appear in any
 * response — there is no request type whose result includes them. That's
 * the whole point of this module: the main thread can ask the worker to
 * seal/open data, but it can never read the keys back out.
 */

import type { KeyTree } from "@falcon/crypto/web";
import { deriveKeyTree, open, ready, seal, unwrapDek } from "@falcon/crypto/web";
import type { KeyStorage } from "./key-storage.js";
import type { CryptoWorkerRequest, CryptoWorkerResponse } from "./protocol.js";

export interface CryptoWorkerHandler {
  handle(request: CryptoWorkerRequest): Promise<CryptoWorkerResponse>;
}

export function createCryptoWorkerHandler(storage: KeyStorage): CryptoWorkerHandler {
  let keyTree: KeyTree | null = null;
  let activeDek: Uint8Array | null = null;
  let startupLoad: Promise<void> | null = null;

  /** Load a previously-provisioned secret from storage, at most once, lazily. */
  function ensureStartupLoaded(): Promise<void> {
    if (!startupLoad) {
      startupLoad = (async () => {
        if (keyTree) {
          return;
        }
        const stored = await storage.load();
        if (stored) {
          keyTree = deriveKeyTree(stored);
        }
      })();
    }
    return startupLoad;
  }

  async function handle(request: CryptoWorkerRequest): Promise<CryptoWorkerResponse> {
    try {
      switch (request.type) {
        case "init": {
          await storage.save(request.masterSecret);
          keyTree = deriveKeyTree(request.masterSecret);
          activeDek = null;
          startupLoad = Promise.resolve();
          return { id: request.id, ok: true, result: null };
        }

        case "setSessionKey": {
          await ensureStartupLoaded();
          if (!keyTree) {
            return { id: request.id, ok: false, error: "not-initialized" };
          }
          await ready;
          const dek = unwrapDek(request.wrappedDek, keyTree.content.secretKey);
          activeDek = dek;
          return { id: request.id, ok: true, result: dek !== null };
        }

        case "seal": {
          await ensureStartupLoaded();
          if (!activeDek) {
            return { id: request.id, ok: false, error: "no-active-session-key" };
          }
          const box = await seal(request.data, activeDek);
          return { id: request.id, ok: true, result: box };
        }

        case "open": {
          await ensureStartupLoaded();
          if (!activeDek) {
            return { id: request.id, ok: false, error: "no-active-session-key" };
          }
          const result = await open(request.box, activeDek);
          return { id: request.id, ok: true, result };
        }

        case "clear": {
          await storage.clear();
          keyTree = null;
          activeDek = null;
          startupLoad = null;
          return { id: request.id, ok: true, result: null };
        }

        default: {
          const exhaustive: never = request;
          return exhaustive;
        }
      }
    } catch (err) {
      return { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { handle };
}
