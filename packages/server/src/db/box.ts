import type { EncryptedBox } from "@kvy/wire";

/**
 * Codec between an `EncryptedBox` (the wire-visible `{t, v, c}` envelope,
 * see `@kvy/wire`'s `box.ts`) and the raw `bytea` bytes every encrypted
 * column in `db/schema.ts` actually stores.
 *
 * The *whole* envelope round-trips through `bytea` — not just the inner
 * ciphertext (`c`) — so `t`/`v` (routing/version metadata the server is
 * allowed to read, design §5.3/§6.1) survive a write/read cycle unchanged.
 * The server never touches `c` itself; it has no keys to open it with.
 */
export function encodeBox(box: EncryptedBox): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(box));
}

export function decodeBox(bytes: Uint8Array): EncryptedBox {
  return JSON.parse(new TextDecoder().decode(bytes)) as EncryptedBox;
}
