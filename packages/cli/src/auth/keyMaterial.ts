/**
 * Glue between `credentials.ts`'s `KeyMaterial` discriminated union and its concrete
 * wrapping mechanism (`deviceKey.ts`'s OS-vault device-wrap) — issue-4-plan.md §6.1/§6.5.
 * Every reader/writer of `~/.falcon/access.key` goes through this module instead of
 * branching on `keyMaterial.mode` directly, so the mode list only has to be
 * exhaustively handled in one place.
 *
 * Device-wrap is the only mode ever written now: no human should have to type a PIN on
 * every `falcon claude`/daemon start just to unlock a file on their own machine — the
 * OS vault gives the same "not stored raw on disk" property without that friction, and
 * unlike a PIN it works unattended, which the daemon always needs. `"pin"` stays a
 * legal *read* mode (`promptAndUnwrapWithPin`) purely so credentials written by an
 * older `falcon` build still unlock — it is never written by `wrapNewKeyMaterial`
 * anymore.
 */
import { decodeBase64, encodeBase64 } from "@falcon/crypto";
import type { KeyMaterial } from "./credentials.js";
import { unwrapWithDeviceKey, wrapWithDeviceKey } from "./deviceKey.js";
import { type PinPromptDeps, promptAndUnwrapWithPin } from "./pin.js";

/** Device-wraps `secret` — the only mode `falcon auth login` writes. */
export async function wrapNewKeyMaterial(
  secret: Uint8Array,
  homeDir: string,
): Promise<KeyMaterial> {
  return { mode: "device", wrapped: wrapWithDeviceKey(secret, homeDir) };
}

/**
 * Unwraps `keyMaterial` back to raw bytes. `"device"` and `"plaintext-fallback"` never
 * need a human present. `"pin"` does — `pinDeps` must be supplied (and a real TTY must
 * be behind it) or this resolves `null` immediately rather than hanging waiting on
 * input nobody can provide (e.g. the daemon, which never runs interactively). Only
 * reachable for credentials written before the device-only default above.
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

/** `"plaintext-fallback"` constructor — same at-rest custody as before this pass;
 * used where wrapping genuinely isn't wanted/needed (e.g. `e2e/`'s test harness). */
export function plaintextFallbackKeyMaterial(secret: Uint8Array): KeyMaterial {
  return { mode: "plaintext-fallback", bundle: encodeBase64(secret) };
}
