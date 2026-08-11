/**
 * Core crypto-bridge worker logic. Split out from `worker.ts`'s `self.onmessage` wiring
 * so tests can drive it directly with in-memory storage.
 *
 * Trust boundary: `keyTree`, `masterSecret`, `refreshToken`, `activeDek`, and every pending
 * ephemeral secret are closed over by `handle()` and never appear in any response. The main
 * thread can ask the worker to seal/open data or mint a fresh access token, but can never
 * read the keys back out.
 *
 * The refresh token lives in its own store, independent of key material, so a browser with
 * no keys can still hold a session and ask for keys from another device.
 */

import type { KeyTree } from "@kvy/crypto/web";
import {
  decodeBase64,
  decryptBlob,
  deriveBlobKey,
  deriveKeyTree,
  encodeBase64,
  encryptBlob,
  generateEphemeralKeyPair,
  getRandomBytes,
  hashWorkspacePath,
  libsodiumDecryptWithSecretKey,
  libsodiumEncryptForPublicKey,
  open,
  pinReady,
  ready,
  seal,
  signDetached,
  unwrapDek,
  unwrapWithPin,
  wrapDek,
} from "@kvy/crypto/web";
import { API_URL } from "@/lib/config.js";
import { createWrapKey, unwrapBytes, wrapBytes } from "./device-key.js";
import {
  type AnyStoredKeyRecord,
  isPasskeyRecord,
  isV2Record,
  type KeyStorage,
  type KeyWrapMode,
  type StoredKeyRecordPasskey,
  type StoredKeyRecordV2,
} from "./key-storage.js";
import type { CryptoWorkerRequest, CryptoWorkerResponse } from "./protocol.js";
import type { SessionStorage } from "./session-storage.js";

const X25519_PUBLIC_KEY_BYTES = 32;
const MASTER_SECRET_BYTES = 32;
const DEK_LENGTH_BYTES = 32;

/** `[0x01 | masterSecret | refreshToken]` — CLI pairing payload format. */
const PAIR_PAYLOAD_VERSION = 0x01;
/** `[0x02 | masterSecret]` — device-to-device key sharing; the peer has its own session. */
const KEY_SHARE_PAYLOAD_VERSION = 0x02;

/** Bounded so a runaway caller can't grow this map without limit. */
const MAX_PENDING_KEY_REQUESTS = 4;

export interface CryptoWorkerHandler {
  handle(request: CryptoWorkerRequest): Promise<CryptoWorkerResponse>;
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

function isRefreshResponse(value: unknown): value is RefreshResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.accessToken === "string" && typeof candidate.refreshToken === "string";
}

export function createCryptoWorkerHandler(
  storage: KeyStorage,
  sessionStorage: SessionStorage,
): CryptoWorkerHandler {
  let keyTree: KeyTree | null = null;
  // Kept alongside `keyTree` (not merely derivable from it) because pairing and key
  // sharing must seal the verbatim master secret bytes to a peer.
  let masterSecret: Uint8Array | null = null;
  let refreshToken: string | null = null;
  let activeDek: Uint8Array | null = null;
  /**
   * Which account the in-memory `keyTree` was loaded/provisioned for, when known. `null`
   * means "not tagged" (a legacy-record load, or a path that doesn't thread an account id —
   * see `persistKeyMaterial`'s callers) and is treated permissively: a `null` here is NOT
   * evidence the tree belongs to someone else, only that this session never positively
   * confirmed whose it is.
   */
  let loadedForAccount: string | null = null;
  /**
   * Keyed by `ephPub`, not a single slot: the worker is a refcounted singleton shared
   * app-wide, so two concurrent requests with one slot would destroy the first request's
   * secret while its claim still consumed (and deleted) the sealed box server-side —
   * losing the key material outright.
   */
  const pendingKeyRequests = new Map<string, Uint8Array>();

  function deriveFrom(secret: Uint8Array): void {
    masterSecret = secret;
    keyTree = deriveKeyTree(secret);
  }

  function resetMemory(): void {
    keyTree = null;
    masterSecret = null;
    refreshToken = null;
    activeDek = null;
    loadedForAccount = null;
    pendingKeyRequests.clear();
  }

  /**
   * Does this record belong to the account asking?
   *
   * `undefined` on either side is permissive, deliberately:
   *  - a caller with no account id yet (a pre-sign-in `describeStorage`) gets today's answer;
   *  - a record written before `accountId` existed is ADOPTED by the first account that asks,
   *    and stamped on the next successful `ensureLoaded`.
   *
   * Adoption is the honest trade, not an oversight. The strict alternative — treat every
   * untagged record as foreign — would show "One more step" to every existing single-device
   * user, whose only exit is `/reset-keys/` and permanent loss of their sessions. Adoption
   * mis-tags only the browsers that already have the cross-account collision this fix is
   * about, and those were already broken. The residual risk is bounded by the server: a
   * wrongly-adopted key cannot be re-bound to a second account while the first still holds it
   * (`server/src/app/routes/keys.ts:207-214`).
   */
  function belongsTo(record: AnyStoredKeyRecord, accountId?: string): boolean {
    if (!accountId) return true;
    if (isPasskeyRecord(record)) return record.accountId === accountId;
    if (!isV2Record(record) || record.accountId === undefined) return true;
    return record.accountId === accountId;
  }

  /**
   * There is no unlock step any more: the first key-dependent call in a fresh worker
   * loads and unwraps from storage. Idempotent; safe to call on every branch.
   * Returns false for a missing record, a v1 (pre-Phase-5) record needing migration, a
   * wrap key that could not be resolved (e.g. a dismissed biometric prompt), or — when
   * `accountId` is given — a record positively known to belong to a different account.
   */
  async function ensureLoaded(
    providedWrapKey?: CryptoKey,
    accountId?: string,
    masterSecretFromMain?: Uint8Array,
  ): Promise<boolean> {
    if (keyTree) {
      // A `keyTree` already in memory for a DIFFERENT, known account must not be handed to
      // this account — see `loadedForAccount`'s docblock for why `null` stays permissive.
      if (accountId !== undefined && loadedForAccount !== null && loadedForAccount !== accountId) {
        return false;
      }
      return true;
    }
    const record = await storage.load();
    if (!record || !belongsTo(record, accountId)) return false;

    // Passkey mode: the masterSecret is derived on the main thread and passed in directly.
    // The worker never unwraps anything from storage — there is nothing to unwrap.
    if (isPasskeyRecord(record)) {
      if (!masterSecretFromMain || masterSecretFromMain.length !== MASTER_SECRET_BYTES) {
        return false;
      }
      await ready;
      deriveFrom(masterSecretFromMain);
      loadedForAccount = accountId ?? record.accountId;
      return true;
    }

    if (!isV2Record(record)) return false;

    // A "prf" record's wrap key can only be derived on the main thread (WebAuthn is not
    // exposed to workers), so the caller must hand it in. Refusing here — rather than
    // falling back to something weaker — is what keeps the mode honest.
    const wrapKey = record.mode === "prf" ? providedWrapKey : record.wrapKey;
    if (!wrapKey) return false;

    const secret = await unwrapBytes(wrapKey, record.wrapped);
    if (!secret || secret.length !== MASTER_SECRET_BYTES) return false;

    await ready;
    deriveFrom(secret);
    loadedForAccount = accountId ?? record.accountId ?? null;
    if (accountId && record.accountId === undefined) {
      // Legacy record — adopted now that we know whose it is (see `belongsTo`'s docblock).
      await storage.save({ ...record, accountId });
    }
    return true;
  }

  /**
   * Wrap + persist `secret`. A `"prf"` mode is only honoured when the caller actually
   * supplied a main-thread-derived key AND its credential id; otherwise this records
   * `"device"` — never a `"prf"` record it could not unwrap on the next page load.
   *
   * `accountId` is `undefined` for the two callers that don't have one to give
   * (`migrateFromPin` upgrades an already-loaded record in place; `acceptKeyResponse`'s
   * device-to-device share doesn't carry one across the wire) — an accepted, narrower scope
   * than `init`'s, same trade the fix plan calls out: an omitted call site keeps today's
   * (unscoped) behavior rather than refusing outright.
   */
  async function persistKeyMaterial(
    secret: Uint8Array,
    tree: KeyTree,
    mode: KeyWrapMode,
    accountId: string | undefined,
    wrapKey?: CryptoKey,
    credentialId?: Uint8Array,
  ): Promise<KeyWrapMode> {
    const usePrf = mode === "prf" && wrapKey !== undefined && credentialId !== undefined;
    const effectiveKey = usePrf ? wrapKey : await createWrapKey();

    const record: StoredKeyRecordV2 = {
      v: 2,
      accountId,
      mode: usePrf ? "prf" : "device",
      wrapped: await wrapBytes(effectiveKey, secret),
      signPubKey: encodeBase64(tree.signing.publicKey),
      contentPubKey: encodeBase64(tree.content.publicKey),
      ...(usePrf ? { credentialId } : { wrapKey: effectiveKey }),
    };
    await storage.save(record);
    if (accountId) loadedForAccount = accountId;
    return record.mode;
  }

  function identityFrom(record: AnyStoredKeyRecord): {
    signPubKey: string;
    contentPubKey: string;
  } {
    return { signPubKey: record.signPubKey, contentPubKey: record.contentPubKey };
  }

  async function handle(request: CryptoWorkerRequest): Promise<CryptoWorkerResponse> {
    try {
      switch (request.type) {
        case "init": {
          await ready;
          deriveFrom(request.masterSecret);
          if (!keyTree) return { id: request.id, ok: false, error: "not-initialized" };

          if (request.mode === "passkey") {
            if (!request.credentialId) {
              return { id: request.id, ok: false, error: "passkey-mode-requires-credential-id" };
            }
            const record: StoredKeyRecordPasskey = {
              v: 3,
              mode: "passkey",
              accountId: request.accountId,
              credentialId: request.credentialId,
              signPubKey: encodeBase64(keyTree.signing.publicKey),
              contentPubKey: encodeBase64(keyTree.content.publicKey),
            };
            await storage.save(record);
            loadedForAccount = request.accountId;
          } else {
            await persistKeyMaterial(
              request.masterSecret,
              keyTree,
              request.mode,
              request.accountId,
              request.wrapKey,
              request.credentialId,
            );
          }

          refreshToken = request.refreshToken;
          await sessionStorage.save(request.refreshToken);
          activeDek = null;
          return { id: request.id, ok: true, result: null };
        }

        case "describeStorage": {
          const record = await storage.load();
          if (!record || !belongsTo(record, request.accountId)) {
            return {
              id: request.id,
              ok: true,
              result: { present: false, version: 2, mode: null, credentialId: null },
            };
          }
          if (isPasskeyRecord(record)) {
            return {
              id: request.id,
              ok: true,
              result: {
                present: true,
                version: 3 as const,
                mode: "passkey" as const,
                credentialId: record.credentialId,
              },
            };
          }
          return {
            id: request.id,
            ok: true,
            result: isV2Record(record)
              ? {
                  present: true,
                  version: 2 as const,
                  mode: record.mode,
                  credentialId: record.credentialId ?? null,
                }
              : { present: true, version: 1 as const, mode: null, credentialId: null },
          };
        }

        case "ensureLoaded": {
          return {
            id: request.id,
            ok: true,
            result: await ensureLoaded(request.wrapKey, request.accountId, request.masterSecret),
          };
        }

        case "migrateFromPin": {
          const record = await storage.load();
          if (!record || isV2Record(record) || isPasskeyRecord(record)) {
            return { id: request.id, ok: true, result: false };
          }
          await ready;
          await pinReady;
          const secret = await unwrapWithPin(record.wrapped, request.pin);
          if (!secret || secret.length !== MASTER_SECRET_BYTES) {
            return { id: request.id, ok: true, result: false };
          }
          // Carry the session credential across to its own store before the old record
          // is replaced — otherwise a migrating user is silently signed out.
          if (record.wrappedRefreshToken) {
            const tokenBytes = await unwrapWithPin(record.wrappedRefreshToken, request.pin);
            if (tokenBytes) {
              refreshToken = new TextDecoder().decode(tokenBytes);
              await sessionStorage.save(refreshToken);
            }
          }
          deriveFrom(secret);
          if (!keyTree) return { id: request.id, ok: true, result: false };
          // No account id here (this upgrades whichever record is already loaded, in
          // place) — `loadedForAccount` stays `null`, which `ensureLoaded`'s fast path
          // treats as permissive rather than foreign. See `persistKeyMaterial`'s docblock.
          await persistKeyMaterial(
            secret,
            keyTree,
            request.mode,
            undefined,
            request.wrapKey,
            request.credentialId,
          );
          return { id: request.id, ok: true, result: true };
        }

        case "setSessionKey": {
          if (!(await ensureLoaded()) || !keyTree) {
            return { id: request.id, ok: false, error: "needs-keys" };
          }
          await ready;
          const dek = unwrapDek(request.wrappedDek, keyTree.content.secretKey);
          activeDek = dek;
          return { id: request.id, ok: true, result: dek !== null };
        }

        case "createDek": {
          if (!(await ensureLoaded()) || !keyTree) {
            return { id: request.id, ok: false, error: "needs-keys" };
          }
          await ready;
          const dek = getRandomBytes(DEK_LENGTH_BYTES);
          const wrappedDek = wrapDek(dek, keyTree.content.publicKey);
          const box = await seal(request.data, dek);
          return {
            id: request.id,
            ok: true,
            result: { wrappedDek: encodeBase64(wrappedDek), box },
          };
        }

        case "hashWorkspacePath": {
          if (!(await ensureLoaded()) || !keyTree) {
            return { id: request.id, ok: false, error: "needs-keys" };
          }
          return {
            id: request.id,
            ok: true,
            result: hashWorkspacePath(keyTree.workspaceIndexKey, request.path),
          };
        }

        case "seal": {
          if (!activeDek) return { id: request.id, ok: false, error: "no-active-session-key" };
          return { id: request.id, ok: true, result: await seal(request.data, activeDek) };
        }

        case "open": {
          if (!activeDek) return { id: request.id, ok: false, error: "no-active-session-key" };
          return { id: request.id, ok: true, result: await open(request.box, activeDek) };
        }

        case "sealBlob": {
          if (!activeDek) return { id: request.id, ok: false, error: "no-active-session-key" };
          return {
            id: request.id,
            ok: true,
            result: encryptBlob(request.data, deriveBlobKey(activeDek)),
          };
        }

        case "openBlob": {
          if (!activeDek) return { id: request.id, ok: false, error: "no-active-session-key" };
          return {
            id: request.id,
            ok: true,
            result: decryptBlob(request.bundle, deriveBlobKey(activeDek)),
          };
        }

        case "clear": {
          await storage.destroy();
          await sessionStorage.destroy();
          resetMemory();
          return { id: request.id, ok: true, result: null };
        }

        case "getIdentity": {
          // `loadedForAccount === (request.accountId ?? loadedForAccount)`: when the caller
          // gives no account id this is trivially true (today's permissive answer); when it
          // does, the in-memory tree must actually be tagged for that account.
          if (keyTree && loadedForAccount === (request.accountId ?? loadedForAccount)) {
            return {
              id: request.id,
              ok: true,
              result: {
                signPubKey: encodeBase64(keyTree.signing.publicKey),
                contentPubKey: encodeBase64(keyTree.content.publicKey),
              },
            };
          }
          const record = await storage.load();
          return {
            id: request.id,
            ok: true,
            result: record && belongsTo(record, request.accountId) ? identityFrom(record) : null,
          };
        }

        case "bindKeysProof": {
          if (!(await ensureLoaded()) || !keyTree) {
            return { id: request.id, ok: false, error: "needs-keys" };
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
          return {
            id: request.id,
            ok: true,
            result: {
              signPubKey: encodeBase64(keyTree.signing.publicKey),
              contentPubKey: encodeBase64(contentPubKey),
              signature: encodeBase64(signDetached(signed, keyTree.signing.secretKey)),
            },
          };
        }

        case "sealForPeer": {
          if (!(await ensureLoaded()) || !masterSecret) {
            return { id: request.id, ok: false, error: "needs-keys" };
          }
          // The CLI mints the URL fragment as base64url, but the caller always re-encodes
          // to PLAIN base64 first (the server looks the row up by that exact string), so
          // this must decode with the matching variant.
          const ephPub = decodeBase64(request.ephPub);
          if (ephPub.length !== X25519_PUBLIC_KEY_BYTES) {
            return { id: request.id, ok: false, error: "invalid-eph-pub" };
          }
          await ready;
          const tokenBytes = new TextEncoder().encode(request.refreshToken);
          const payload = new Uint8Array(1 + masterSecret.length + tokenBytes.length);
          payload[0] = PAIR_PAYLOAD_VERSION;
          payload.set(masterSecret, 1);
          payload.set(tokenBytes, 1 + masterSecret.length);
          return {
            id: request.id,
            ok: true,
            result: encodeBase64(libsodiumEncryptForPublicKey(payload, ephPub)),
          };
        }

        case "beginKeyRequest": {
          if (pendingKeyRequests.size >= MAX_PENDING_KEY_REQUESTS) {
            return { id: request.id, ok: false, error: "too-many-key-requests" };
          }
          await ready;
          const keyPair = generateEphemeralKeyPair();
          const ephPub = encodeBase64(keyPair.publicKey);
          pendingKeyRequests.set(ephPub, keyPair.secretKey);
          return { id: request.id, ok: true, result: ephPub };
        }

        case "acceptKeyResponse": {
          await ready;
          const sealed = decodeBase64(request.sealed);
          for (const [ephPub, secretKey] of pendingKeyRequests) {
            const payload = libsodiumDecryptWithSecretKey(sealed, secretKey);
            if (
              !payload ||
              payload.length !== 1 + MASTER_SECRET_BYTES ||
              payload[0] !== KEY_SHARE_PAYLOAD_VERSION
            ) {
              continue;
            }
            const secret = payload.slice(1, 1 + MASTER_SECRET_BYTES);
            deriveFrom(secret);
            pendingKeyRequests.delete(ephPub);
            if (!keyTree) return { id: request.id, ok: true, result: false };
            // No account id crosses the device-to-device share wire — same accepted,
            // narrower scope as `migrateFromPin` (see `persistKeyMaterial`'s docblock).
            await persistKeyMaterial(
              secret,
              keyTree,
              request.mode,
              undefined,
              request.wrapKey,
              request.credentialId,
            );
            activeDek = null;
            return { id: request.id, ok: true, result: true };
          }
          return { id: request.id, ok: true, result: false };
        }

        case "sealKeysForPeer": {
          if (!(await ensureLoaded()) || !masterSecret) {
            return { id: request.id, ok: false, error: "needs-keys" };
          }
          const ephPub = decodeBase64(request.ephPub);
          if (ephPub.length !== X25519_PUBLIC_KEY_BYTES) {
            return { id: request.id, ok: false, error: "invalid-eph-pub" };
          }
          await ready;
          const payload = new Uint8Array(1 + masterSecret.length);
          payload[0] = KEY_SHARE_PAYLOAD_VERSION;
          payload.set(masterSecret, 1);
          return {
            id: request.id,
            ok: true,
            result: encodeBase64(libsodiumEncryptForPublicKey(payload, ephPub)),
          };
        }

        case "setRefreshToken": {
          // Phase 4a: no key dependency. A signed-in browser with no key material must
          // still be able to persist its session — that is the whole state key sharing
          // has to operate in.
          refreshToken = request.refreshToken;
          await sessionStorage.save(request.refreshToken);
          return { id: request.id, ok: true, result: null };
        }

        case "refreshSession": {
          refreshToken ??= await sessionStorage.load();
          if (!refreshToken) {
            return { id: request.id, ok: true, result: { kind: "no-credential" } };
          }
          try {
            const res = await fetch(`${API_URL}/v1/auth/refresh`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ refreshToken }),
            });
            // 401/403 is the server genuinely rejecting the credential — the only answer
            // that should ever sign a user out. Anything else (404 from a misconfigured
            // API base, 5xx, a proxy error) is a transport fault: keep the session and let
            // the caller retry, per "never claim a security property you have not verified".
            if (res.status === 401 || res.status === 403) {
              return { id: request.id, ok: true, result: { kind: "rejected" } };
            }
            if (!res.ok) return { id: request.id, ok: true, result: { kind: "unreachable" } };
            const body: unknown = await res.json();
            if (!isRefreshResponse(body)) {
              return { id: request.id, ok: true, result: { kind: "unreachable" } };
            }
            refreshToken = body.refreshToken;
            await sessionStorage.save(refreshToken);
            return {
              id: request.id,
              ok: true,
              result: { kind: "ok", accessToken: body.accessToken },
            };
          } catch {
            return { id: request.id, ok: true, result: { kind: "unreachable" } };
          }
        }

        case "claimPasskey": {
          await ready;
          deriveFrom(request.masterSecret);
          if (!keyTree) return { id: request.id, ok: true, result: false };
          const record: StoredKeyRecordPasskey = {
            v: 3,
            mode: "passkey",
            accountId: request.accountId,
            credentialId: request.credentialId,
            signPubKey: encodeBase64(keyTree.signing.publicKey),
            contentPubKey: encodeBase64(keyTree.content.publicKey),
          };
          await storage.save(record);
          loadedForAccount = request.accountId;
          activeDek = null;
          return { id: request.id, ok: true, result: true };
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
