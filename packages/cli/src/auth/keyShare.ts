/**
 * Node twin of the web crypto worker's `sealKeysForPeer`
 * (docs/auth-ux-overhaul-plan.md AX-4.18) — lets a CLI machine that holds the master
 * secret answer another device's key request when no browser is open.
 *
 * The payload format is shared with `web/src/crypto/worker-handler.ts` and is asserted
 * byte-compatible in `keyShare.test.ts`; changing one side without the other silently
 * breaks cross-platform key sharing.
 */
import { decodeBase64, encodeBase64, libsodiumEncryptForPublicKey } from "@kvy/crypto";

const X25519_PUBLIC_KEY_BYTES = 32;
export const KEY_SHARE_PAYLOAD_VERSION = 0x02;

/** Seals `[0x02 | masterSecret]` to `ephPub` (base64). Returns null for a malformed key. */
export function sealKeysForPeer(masterSecret: Uint8Array, ephPub: string): string | null {
  const recipient = decodeBase64(ephPub);
  if (recipient.length !== X25519_PUBLIC_KEY_BYTES) return null;

  const payload = new Uint8Array(1 + masterSecret.length);
  payload[0] = KEY_SHARE_PAYLOAD_VERSION;
  payload.set(masterSecret, 1);
  return encodeBase64(libsodiumEncryptForPublicKey(payload, recipient));
}
