/**
 * Core crypto-bridge worker logic — the part of `worker.ts` that's actually
 * worth unit testing. Split out from the `self.onmessage` wiring so tests can
 * drive it directly (with an in-memory `KeyStorage`) without needing a real
 * Worker/IndexedDB.
 *
 * Trust boundary (falcon-system-design.md §5.3, §9.1): `keyTree`, `masterSecret`,
 * `refreshToken`, `pin`, and `activeDek` below are closed over by `handle()` and never
 * appear in any response — there is no request type whose result includes them.
 * That's the whole point of this module: the main thread can ask the worker to
 * seal/open data or mint a fresh access token, but it can never read the keys
 * (or the refresh token) back out.
 *
 * issue-4-plan.md §6.1/§6.4: the master secret is never stored raw — only
 * PIN-wrapped (`key-storage.ts`'s `StoredKeyRecord`). `init` wraps + persists
 * it and leaves the worker unlocked; a fresh worker (e.g. after a page
 * reload) starts with `keyTree`/`masterSecret` both `null` and requires an
 * explicit `unlock(pin)` before any key-dependent operation succeeds — there
 * is deliberately no auto-loading-on-startup path anymore.
 *
 * Security review finding F1: the refresh token is PIN-wrapped the same way —
 * `init`/`setRefreshToken` wrap and persist it, `unlock` recovers it into worker
 * memory alongside the master secret, and `refreshSession` mints a fresh access
 * token from it via a real HTTP call made FROM INSIDE THE WORKER (re-wrapping and
 * persisting the rotated refresh token the server returns). The raw refresh token
 * never crosses back out to the main thread at all — only the freshly-minted
 * access token does, which is short-lived and no more sensitive than any other
 * bearer token this app already sends over plain HTTP headers.
 */

import type { KeyTree } from "@falcon/crypto/web";
import {
  decodeBase64,
  decryptBlob,
  deriveBlobKey,
  deriveKeyTree,
  encodeBase64,
  encryptBlob,
  libsodiumEncryptForPublicKey,
  open,
  pinReady,
  ready,
  seal,
  signDetached,
  unwrapDek,
  unwrapWithPin,
  wrapWithPin,
} from "@falcon/crypto/web";
import { API_URL } from "@/lib/config.js";
import type { KeyStorage, StoredKeyRecord } from "./key-storage.js";
import type { CryptoWorkerRequest, CryptoWorkerResponse } from "./protocol.js";

// X25519 public keys are 32 raw bytes (falcon-system-design.md §5.1/§5.2) — same
// convention the server's pair.ts enforces on the other end of this handshake.
const X25519_PUBLIC_KEY_BYTES = 32;
// Payload version byte for the sealed pairing box (design §5.2: "box(ephPub,
// [version|payload…])"). v1 (issue-4-plan.md §6.3) adds the refresh token
// alongside the master secret so pairing no longer needs a second, plaintext
// channel for it; v0 is kept only as a documented historical marker — no
// caller mints it anymore, so there is nothing left to tolerate-decode.
const PAIR_PAYLOAD_VERSION = 0x01;

export interface CryptoWorkerHandler {
  handle(request: CryptoWorkerRequest): Promise<CryptoWorkerResponse>;
}

/** Distinguishes "nothing has ever been provisioned on this device" from
 * "something's provisioned but this worker instance hasn't been unlocked
 * yet" — the sign-in/unlock UI needs to tell those apart to know whether to
 * show a PIN-entry prompt or a fresh sign-up flow. */
async function keyDependentError(storage: KeyStorage): Promise<"locked" | "not-initialized"> {
  const stored = await storage.load();
  return stored ? "locked" : "not-initialized";
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

/** Manual duck-type guard (mirrors `sync/apiSocket.ts`'s own `isRpcCallResult` —
 * a flat shape doesn't need a full zod schema pulled into the worker bundle just to
 * parse-don't-trust it). */
function isRefreshResponse(value: unknown): value is RefreshResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { accessToken: unknown }).accessToken === "string" &&
    typeof (value as { refreshToken: unknown }).refreshToken === "string"
  );
}

export function createCryptoWorkerHandler(storage: KeyStorage): CryptoWorkerHandler {
  let keyTree: KeyTree | null = null;
  // Kept alongside `keyTree` (not just derivable from it) because pairing's
  // `sealForPeer` must seal the verbatim master secret bytes to a peer —
  // `deriveKeyTree`'s output doesn't preserve them.
  let masterSecret: Uint8Array | null = null;
  // F1: the refresh token, recovered on `unlock`/set on `init`/`setRefreshToken`, and
  // rotated in place by `refreshSession` — never persisted anywhere except PIN-wrapped
  // (`key-storage.ts`'s `wrappedRefreshToken`) and never handed back to the main thread.
  let refreshToken: string | null = null;
  // Cached (not just used-once) so a later token rotation can re-wrap the new refresh
  // token without asking the main thread to prompt for the PIN again — same "keys never
  // leave the worker" boundary as `masterSecret` above.
  let pin: string | null = null;
  let activeDek: Uint8Array | null = null;

  function deriveFrom(secret: Uint8Array): void {
    masterSecret = secret;
    keyTree = deriveKeyTree(secret);
  }

  function resetMemory(): void {
    keyTree = null;
    masterSecret = null;
    refreshToken = null;
    pin = null;
    activeDek = null;
  }

  /** Re-wraps the current in-memory `refreshToken` under the cached `pin` and persists
   * it alongside whatever's already stored (the master secret's own wrapped blob is
   * left untouched). No-op (never throws) if either is missing — a caller mid-flow
   * without a persisted record yet just skips this until the next `init`. */
  async function persistRefreshToken(): Promise<void> {
    if (!refreshToken || !pin) return;
    const stored = await storage.load();
    if (!stored) return;
    await pinReady;
    const wrappedRefreshToken = await wrapWithPin(new TextEncoder().encode(refreshToken), pin);
    await storage.save({ ...stored, wrappedRefreshToken });
  }

  async function handle(request: CryptoWorkerRequest): Promise<CryptoWorkerResponse> {
    try {
      switch (request.type) {
        case "init": {
          await ready;
          await pinReady;
          const wrapped = await wrapWithPin(request.masterSecret, request.pin);
          const wrappedRefreshToken = await wrapWithPin(
            new TextEncoder().encode(request.refreshToken),
            request.pin,
          );
          deriveFrom(request.masterSecret);
          pin = request.pin;
          refreshToken = request.refreshToken;
          if (!keyTree) {
            // Unreachable — `deriveFrom` always sets `keyTree` — guarded anyway.
            return { id: request.id, ok: false, error: "not-initialized" };
          }
          const record: StoredKeyRecord = {
            wrapped,
            signPubKey: encodeBase64(keyTree.signing.publicKey),
            contentPubKey: encodeBase64(keyTree.content.publicKey),
            wrappedRefreshToken,
          };
          await storage.save(record);
          activeDek = null;
          return { id: request.id, ok: true, result: null };
        }

        case "unlock": {
          const record = await storage.load();
          if (!record) {
            return { id: request.id, ok: false, error: "not-initialized" };
          }
          await ready;
          await pinReady;
          const secret = await unwrapWithPin(record.wrapped, request.pin);
          if (!secret) {
            return { id: request.id, ok: true, result: false };
          }
          deriveFrom(secret);
          pin = request.pin;
          refreshToken = null;
          if (record.wrappedRefreshToken) {
            const refreshTokenBytes = await unwrapWithPin(record.wrappedRefreshToken, request.pin);
            refreshToken = refreshTokenBytes ? new TextDecoder().decode(refreshTokenBytes) : null;
          }
          activeDek = null;
          return { id: request.id, ok: true, result: true };
        }

        case "setSessionKey": {
          if (!keyTree) {
            return { id: request.id, ok: false, error: await keyDependentError(storage) };
          }
          await ready;
          const dek = unwrapDek(request.wrappedDek, keyTree.content.secretKey);
          activeDek = dek;
          return { id: request.id, ok: true, result: dek !== null };
        }

        case "seal": {
          if (!activeDek) {
            return { id: request.id, ok: false, error: "no-active-session-key" };
          }
          const box = await seal(request.data, activeDek);
          return { id: request.id, ok: true, result: box };
        }

        case "open": {
          if (!activeDek) {
            return { id: request.id, ok: false, error: "no-active-session-key" };
          }
          const result = await open(request.box, activeDek);
          return { id: request.id, ok: true, result };
        }

        case "sealBlob": {
          if (!activeDek) {
            return { id: request.id, ok: false, error: "no-active-session-key" };
          }
          const blobKey = deriveBlobKey(activeDek);
          const bundle = encryptBlob(request.data, blobKey);
          return { id: request.id, ok: true, result: bundle };
        }

        case "openBlob": {
          if (!activeDek) {
            return { id: request.id, ok: false, error: "no-active-session-key" };
          }
          const blobKey = deriveBlobKey(activeDek);
          const result = decryptBlob(request.bundle, blobKey);
          return { id: request.id, ok: true, result };
        }

        case "clear": {
          await storage.clear();
          resetMemory();
          return { id: request.id, ok: true, result: null };
        }

        case "getIdentity": {
          if (keyTree) {
            return {
              id: request.id,
              ok: true,
              result: {
                signPubKey: encodeBase64(keyTree.signing.publicKey),
                contentPubKey: encodeBase64(keyTree.content.publicKey),
              },
            };
          }
          // No unlock required: the public identity keys are stored in the
          // clear specifically so this call can answer "known device" before
          // a PIN is ever entered.
          const record = await storage.load();
          if (!record) {
            return { id: request.id, ok: true, result: null };
          }
          return {
            id: request.id,
            ok: true,
            result: { signPubKey: record.signPubKey, contentPubKey: record.contentPubKey },
          };
        }

        case "bindKeysProof": {
          if (!keyTree) {
            return { id: request.id, ok: false, error: await keyDependentError(storage) };
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
          if (!keyTree || !masterSecret) {
            return { id: request.id, ok: false, error: await keyDependentError(storage) };
          }
          // The CLI mints the URL fragment with `encodeBase64Url` (falcon-plan.md §2.2 —
          // URL-safe, no padding), but the caller here (`app/(public)/pair/page.tsx`) always
          // re-encodes it to PLAIN base64 before calling `sealForPeer` — the server looks up
          // a pending pair request by that same plain-base64 string (`pair.ts`'s
          // `eq(pairRequests.ephPub, ...)`), so this must decode with the matching plain
          // variant too, not the URL-safe one: decoding a `+`/`/`-containing plain-base64
          // string as base64url would silently drop those characters
          // (`decodeBase64`'s own "never throw" contract) and the key would come out short,
          // failing the length check below for a spurious reason — exactly the bug a real
          // pairing attempt hit whenever the peer's ephemeral key happened to plain-base64-encode
          // with a `+` or `/` in it.
          const ephPub = decodeBase64(request.ephPub);
          if (ephPub.length !== X25519_PUBLIC_KEY_BYTES) {
            return { id: request.id, ok: false, error: "invalid-eph-pub" };
          }
          await ready;
          const refreshTokenBytes = new TextEncoder().encode(request.refreshToken);
          const payload = new Uint8Array(1 + masterSecret.length + refreshTokenBytes.length);
          payload[0] = PAIR_PAYLOAD_VERSION;
          payload.set(masterSecret, 1);
          payload.set(refreshTokenBytes, 1 + masterSecret.length);
          const sealedBox = libsodiumEncryptForPublicKey(payload, ephPub);
          return { id: request.id, ok: true, result: encodeBase64(sealedBox) };
        }

        case "setRefreshToken": {
          if (!keyTree || !pin) {
            return { id: request.id, ok: false, error: await keyDependentError(storage) };
          }
          refreshToken = request.refreshToken;
          await persistRefreshToken();
          return { id: request.id, ok: true, result: null };
        }

        case "refreshSession": {
          if (!refreshToken) {
            // Nothing to refresh with — a normal "not signed in" outcome, not an RPC
            // error (mirrors `unlock`'s own wrong-PIN "resolve false, don't reject").
            return { id: request.id, ok: true, result: null };
          }
          try {
            const res = await fetch(`${API_URL}/v1/auth/refresh`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ refreshToken }),
            });
            if (!res.ok) {
              return { id: request.id, ok: true, result: null };
            }
            const body: unknown = await res.json();
            if (!isRefreshResponse(body)) {
              return { id: request.id, ok: true, result: null };
            }
            refreshToken = body.refreshToken;
            await persistRefreshToken();
            return { id: request.id, ok: true, result: body.accessToken };
          } catch {
            // Network failure — same "couldn't refresh right now" outcome as a
            // rejected/malformed response; never throws for this, per the module's
            // "no silent failures, but no spurious hard errors either" convention.
            return { id: request.id, ok: true, result: null };
          }
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
