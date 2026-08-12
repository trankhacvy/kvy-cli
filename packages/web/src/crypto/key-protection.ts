/**
 * Main-thread resolution of how this browser protects its keys at rest.
 *
 * WebAuthn is not exposed to Web Workers (`prf-key.ts`), so the passkey round trip has to
 * happen here and the resulting non-extractable `CryptoKey` is handed to the worker across
 * `postMessage` (structured clone supports `CryptoKey`). The raw key bytes never exist on
 * either side, and the worker refuses to record a `"prf"` mode it wasn't given a real key
 * for — so an unsupported browser degrades to `"device"` visibly, never silently.
 */
import type { KeyWrapMode } from "./key-storage.js";
import {
  createPrfCredential,
  derivePrfMasterSecret,
  derivePrfWrapKey,
  isPrfAvailable,
} from "./prf-key.js";

export interface KeyProtection {
  mode: KeyWrapMode;
  wrapKey?: CryptoKey;
  credentialId?: Uint8Array;
}

/**
 * Provision protection for a NEW key record.
 *
 * "passkey" → create a passkey (biometric #1), return its credentialId. The masterSecret
 *             will be derived in `completeOAuthSignIn` after `register()` gives us the
 *             accountId needed for HKDF (biometric #2). Falls back to "device" if PRF
 *             is unavailable or the user dismisses.
 * "prf"     → legacy wrap mode: create passkey + derive wrap key. Kept for the key-sharing
 *             receive path. Falls back to "device" if PRF unavailable.
 * "device"  → no-friction fallback, always succeeds.
 *
 * The caller always reads `result.mode` to know what was actually provisioned.
 */
export async function provisionKeyProtection(
  requested: KeyWrapMode,
  accountLabel: string,
): Promise<KeyProtection> {
  if (requested === "passkey") {
    if (!(await isPrfAvailable())) return { mode: "device" };
    const credentialId = await createPrfCredential(accountLabel);
    if (!credentialId) return { mode: "device" };
    return { mode: "passkey", credentialId };
  }

  if (requested === "prf") {
    if (!(await isPrfAvailable())) return { mode: "device" };
    const credentialId = await createPrfCredential(accountLabel);
    if (!credentialId) return { mode: "device" };
    const wrapKey = await derivePrfWrapKey(credentialId);
    if (!wrapKey) return { mode: "device" };
    return { mode: "prf", wrapKey, credentialId };
  }

  return { mode: "device" };
}

export type ResolvedKeyMaterial =
  | { kind: "master-secret"; masterSecret: Uint8Array }
  | { kind: "wrap-key"; wrapKey: CryptoKey }
  | { kind: "device" }
  | null;

/**
 * Re-derive the key material for an EXISTING record on a new page load.
 *
 * "passkey" → derive masterSecret from PRF (biometric gesture)
 * "prf"     → derive wrap key from PRF (biometric gesture)
 * "device"  → nothing needed (worker reads the CryptoKey handle from the record)
 * null      → failed (dismissed biometric, deleted passkey, unsupported mode)
 */
export async function resolveKeyMaterial(
  mode: KeyWrapMode | null,
  credentialId: Uint8Array | null,
  accountId: string,
): Promise<ResolvedKeyMaterial> {
  if (mode === "passkey") {
    if (!credentialId) return null;
    const masterSecret = await derivePrfMasterSecret(credentialId, accountId);
    return masterSecret ? { kind: "master-secret", masterSecret } : null;
  }
  if (mode === "prf") {
    if (!credentialId) return null;
    const wrapKey = await derivePrfWrapKey(credentialId);
    return wrapKey ? { kind: "wrap-key", wrapKey } : null;
  }
  if (mode === "device") {
    return { kind: "device" };
  }
  return null;
}

/**
 * Re-derive the wrap key for an EXISTING record. Returns undefined for a `"device"`
 * record (the worker holds that key itself) and null when a `"prf"` derivation failed —
 * a dismissed prompt, a deleted passkey — which the caller must surface rather than
 * treating as "no keys on this browser".
 *
 * @deprecated Use `resolveKeyMaterial` instead, which also handles `"passkey"` mode.
 */
export async function resolveWrapKeyForRecord(
  mode: KeyWrapMode | null,
  credentialId: Uint8Array | null,
): Promise<CryptoKey | undefined | null> {
  if (mode !== "prf") return undefined;
  if (!credentialId) return null;
  return derivePrfWrapKey(credentialId);
}
