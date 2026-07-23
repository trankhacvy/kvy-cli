/**
 * Glue between `credentials.ts`'s `KeyMaterial` discriminated union and the two
 * concrete wrapping mechanisms (`pin.ts`'s PIN-wrap, `deviceKey.ts`'s OS-Keychain
 * device-wrap) — issue-4-plan.md §6.1/§6.5. Every reader/writer of
 * `~/.falcon/access.key` goes through this module instead of branching on
 * `keyMaterial.mode` directly, so the mode list only has to be exhaustively handled
 * in one place.
 */
import { decodeBase64, encodeBase64 } from "@falcon/crypto";
import type { KeyMaterial } from "./credentials.js";
import { unwrapWithDeviceKey, wrapWithDeviceKey } from "./deviceKey.js";
import { type PinPromptDeps, promptAndUnwrapWithPin, promptAndWrapWithPin } from "./pin.js";

/**
 * PIN-wraps `secret` when running at an interactive terminal, otherwise falls back to
 * device-key wrapping (§6.5's daemon-friendly default) — used by `falcon auth login`
 * right after a successful pairing, where BOTH are legitimate: a human at a TTY can set
 * a PIN, but a non-interactive login (CI, a headless provisioning script) has no one to
 * prompt.
 */
export async function wrapNewKeyMaterial(
  secret: Uint8Array,
  homeDir: string,
  options: { interactive: boolean; pinDeps?: PinPromptDeps } = { interactive: false },
): Promise<KeyMaterial> {
  if (options.interactive) {
    const { wrapped } = await promptAndWrapWithPin(secret, options.pinDeps);
    return { mode: "pin", wrapped };
  }
  return { mode: "device", wrapped: wrapWithDeviceKey(secret, homeDir) };
}

/**
 * Unwraps `keyMaterial` back to raw bytes. `"device"` and `"plaintext-fallback"` never
 * need a human present. `"pin"` does — `pinDeps` must be supplied (and a real TTY must
 * be behind it) or this resolves `null` immediately rather than hanging waiting on
 * input nobody can provide (e.g. the daemon, which never runs interactively).
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
