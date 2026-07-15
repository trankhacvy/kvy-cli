import { z } from "zod";

/**
 * Outermost container the server stores/routes for any content field. The
 * server can read `t`/`v` (routing metadata) but never `c` — it holds no
 * keys. Binary layout of the base64 payload inside `c` (after AES-256-GCM
 * decrypt): [ver(1)=0x01 | nonce(12) | ciphertext | gcmTag(16)] (design §4.1).
 */
export const EncryptedBoxSchema = z.object({
  t: z.literal("enc"),
  v: z.literal(1),
  c: z.string(),
});
export type EncryptedBox = z.infer<typeof EncryptedBoxSchema>;

/**
 * Optimistic-concurrency wrapper: a value plus the version it was written
 * at. Metadata/state writes are compare-and-swap on `version` — callers send
 * `expectedVersion`, the server returns `409 {current: Versioned<T>}` on
 * mismatch (design §4.3).
 */
export type Versioned<T> = { value: T; version: number };

export function VersionedSchema<Inner extends z.ZodTypeAny>(inner: Inner) {
  return z.object({
    value: inner,
    version: z.number(),
  });
}
