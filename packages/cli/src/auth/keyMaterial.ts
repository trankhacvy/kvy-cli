/**
 * Centralized key-material branching — all code that reads or writes `keyMaterial` from
 * `~/.kvy/access.key` goes through this module, so the exhaustive mode switch lives in
 * one place.
 *
 * Device-wrap is the only mode ever written now. `"pin"` remains a legal read mode so
 * credentials written by an older `kvy` build still unlock; it is never written by
 * `wrapNewKeyMaterial`.
 */
import { decodeBase64, encodeBase64 } from "@kvy/crypto";
import type { KeyMaterial } from "./credentials.js";
import { unwrapWithDeviceKey, wrapWithDeviceKey } from "./deviceKey.js";
import { type PinPromptDeps, promptAndUnwrapWithPin } from "./pin.js";

/** Device-wraps `secret` — the only mode `kvy auth login` writes. */
export async function wrapNewKeyMaterial(
  secret: Uint8Array,
  homeDir: string,
): Promise<KeyMaterial> {
  return { mode: "device", wrapped: wrapWithDeviceKey(secret, homeDir) };
}

/**
 * Unwraps `keyMaterial` back to raw bytes. `"device"` and `"plaintext-fallback"` never
 * need a human present. `"pin"` does — `pinDeps` must be supplied (and a real TTY must
 * be behind it) or this resolves `null` immediately rather than hanging waiting on input
 * nobody can provide (e.g. the daemon, which never runs interactively). Only reachable
 * for credentials written before the device-only default above.
 */
export async function resolveKeyMaterial(
  keyMaterial: KeyMaterial,
  homeDir: string,
  pinDeps?: PinPromptDeps,
): Promise<Uint8Array | null> {
  switch (keyMaterial.mode) {
    case "plaintext-fallback":
      return decodeBase64(keyMaterial.bundle);
    case "device":
      return unwrapWithDeviceKey(keyMaterial.wrapped, homeDir);
    case "pin":
      if (!pinDeps) return null;
      return promptAndUnwrapWithPin(keyMaterial.wrapped, pinDeps);
    default: {
      const exhaustive: never = keyMaterial;
      return exhaustive;
    }
  }
}

/** No-wrap constructor; used where wrapping isn't needed (e.g. test harnesses). */
export function plaintextFallbackKeyMaterial(secret: Uint8Array): KeyMaterial {
  return { mode: "plaintext-fallback", bundle: encodeBase64(secret) };
}
