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
import {
  decodeBase64,
  decryptBlob,
  deriveBlobKey,
  deriveKeyTree,
  encodeBase64,
  encodeRecoveryCode,
  encryptBlob,
  getRandomBytes,
  libsodiumEncryptForPublicKey,
  open,
  ready,
  seal,
  signDetached,
  unwrapDek,
} from "@falcon/crypto/web";
import type { KeyStorage } from "./key-storage.js";
import type { CryptoWorkerRequest, CryptoWorkerResponse } from "./protocol.js";

// X25519 public keys are 32 raw bytes (falcon-system-design.md §5.1/§5.2) — same
// convention the server's pair.ts enforces on the other end of this handshake.
const X25519_PUBLIC_KEY_BYTES = 32;
// Payload version byte for the sealed pairing box (design §5.2: "box(ephPub,
// [0x00|masterSecret…])") — reserved so a future pairing payload shape (e.g. a
// content-key bundle instead of the raw master secret) can be told apart on read.
const PAIR_PAYLOAD_VERSION = 0x00;

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

        case "sealBlob": {
          await ensureStartupLoaded();
          if (!activeDek) {
            return { id: request.id, ok: false, error: "no-active-session-key" };
          }
          const blobKey = deriveBlobKey(activeDek);
          const bundle = encryptBlob(request.data, blobKey);
          return { id: request.id, ok: true, result: bundle };
        }

        case "openBlob": {
          await ensureStartupLoaded();
          if (!activeDek) {
            return { id: request.id, ok: false, error: "no-active-session-key" };
          }
          const blobKey = deriveBlobKey(activeDek);
          const result = decryptBlob(request.bundle, blobKey);
          return { id: request.id, ok: true, result };
        }

        case "clear": {
          await storage.clear();
          keyTree = null;
          activeDek = null;
          startupLoad = null;
          return { id: request.id, ok: true, result: null };
        }

        case "getIdentity": {
          await ensureStartupLoaded();
          if (!keyTree) {
            return { id: request.id, ok: true, result: null };
          }
          return {
            id: request.id,
            ok: true,
            result: {
              signPubKey: encodeBase64(keyTree.signing.publicKey),
              contentPubKey: encodeBase64(keyTree.content.publicKey),
            },
          };
        }

        case "signInChallenge": {
          await ensureStartupLoaded();
          if (!keyTree) {
            return { id: request.id, ok: false, error: "not-initialized" };
          }
          await ready;
          const challenge = getRandomBytes(32);
          const signature = signDetached(challenge, keyTree.signing.secretKey);
          return {
            id: request.id,
            ok: true,
            result: {
              signPubKey: encodeBase64(keyTree.signing.publicKey),
              contentPubKey: encodeBase64(keyTree.content.publicKey),
              challenge: encodeBase64(challenge),
              signature: encodeBase64(signature),
            },
          };
        }

        case "exportRecoveryCode": {
          await ensureStartupLoaded();
          if (!keyTree) {
            return { id: request.id, ok: false, error: "not-initialized" };
          }
          // The recovery code is the master secret's export form, not the derived
          // keyTree — reload the raw bytes from storage rather than keeping a
          // second long-lived copy of the secret around in a closure variable.
          const masterSecret = await storage.load();
          if (!masterSecret) {
            // Unreachable in practice — `keyTree` is only ever set alongside a
            // successful `storage.save()` (init) or a successful `storage.load()`
            // (ensureStartupLoaded) — guarded anyway per the "no silent failures"
            // principle.
            return { id: request.id, ok: false, error: "not-initialized" };
          }
          return { id: request.id, ok: true, result: encodeRecoveryCode(masterSecret) };
        }

        case "bindKeysProof": {
          await ensureStartupLoaded();
          if (!keyTree) {
            return { id: request.id, ok: false, error: "not-initialized" };
          }
          await ready;
          const contentPubKey = keyTree.content.publicKey;
          const accountIdBytes = new TextEncoder().encode(request.accountId);
          const nonce = decodeBase64(request.nonce);
          const signed = new Uint8Array(
            accountIdBytes.length + contentPubKey.length + nonce.length,
          );
          signed.set(accountIdBytes, 0);
          signed.set(contentPubKey, accountIdBytes.length);
          signed.set(nonce, accountIdBytes.length + contentPubKey.length);
          const signature = signDetached(signed, keyTree.signing.secretKey);
          return {
            id: request.id,
            ok: true,
            result: {
              signPubKey: encodeBase64(keyTree.signing.publicKey),
              contentPubKey: encodeBase64(contentPubKey),
              signature: encodeBase64(signature),
            },
          };
        }

        case "sealForPeer": {
          await ensureStartupLoaded();
          if (!keyTree) {
            return { id: request.id, ok: false, error: "not-initialized" };
          }
          // The CLI mints this fragment with `encodeBase64Url` (falcon-plan.md
          // §2.2 — URL-safe, no padding), never plain base64: must decode with
          // the matching variant or `-`/`_` chars get silently dropped
          // (`decodeBase64`'s own "never throw" contract) and the key comes
          // out short, failing the length check below for a spurious reason.
          const ephPub = decodeBase64(request.ephPub, "base64url");
          if (ephPub.length !== X25519_PUBLIC_KEY_BYTES) {
            return { id: request.id, ok: false, error: "invalid-eph-pub" };
          }
          const masterSecret = await storage.load();
          if (!masterSecret) {
            return { id: request.id, ok: false, error: "not-initialized" };
          }
          await ready;
          const payload = new Uint8Array(1 + masterSecret.length);
          payload[0] = PAIR_PAYLOAD_VERSION;
          payload.set(masterSecret, 1);
          const sealedBox = libsodiumEncryptForPublicKey(payload, ephPub);
          return { id: request.id, ok: true, result: encodeBase64(sealedBox) };
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
