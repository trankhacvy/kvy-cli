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
import { createPrfCredential, derivePrfWrapKey, isPrfAvailable } from "./prf-key.js";

export interface KeyProtection {
  mode: KeyWrapMode;
  wrapKey?: CryptoKey;
  credentialId?: Uint8Array;
}

/**
 * Provision protection for a NEW key record. Asking for `"prf"` creates a passkey; if the
 * platform declines or the user dismisses it, this returns `{ mode: "device" }` so the
 * caller can tell the user what they actually got.
 */
export async function provisionKeyProtection(
  requested: KeyWrapMode,
  accountLabel: string,
): Promise<KeyProtection> {
  if (requested !== "prf") return { mode: "device" };
  if (!(await isPrfAvailable())) return { mode: "device" };

  const credentialId = await createPrfCredential(accountLabel);
  if (!credentialId) return { mode: "device" };

  const wrapKey = await derivePrfWrapKey(credentialId);
  if (!wrapKey) return { mode: "device" };

  return { mode: "prf", wrapKey, credentialId };
}

/**
 * Re-derive the wrap key for an EXISTING record. Returns undefined for a `"device"`
 * record (the worker holds that key itself) and null when a `"prf"` derivation failed —
 * a dismissed prompt, a deleted passkey — which the caller must surface rather than
 * treating as "no keys on this browser".
 */
export async function resolveWrapKeyForRecord(
  mode: KeyWrapMode | null,
  credentialId: Uint8Array | null,
): Promise<CryptoKey | undefined | null> {
  if (mode !== "prf") return undefined;
  if (!credentialId) return null;
  return derivePrfWrapKey(credentialId);
}
