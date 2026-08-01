import { type EncryptedBox, type SessionEnvelope, SessionEnvelopeSchema } from "@kvy/wire";
import { z } from "zod";
import type { MessagesPage } from "./types.js";

/**
 * Decrypts + validates every message row's `content` box across a set of
 * `GET /v1/sessions/:id/messages` pages into a flat `SessionEnvelope[]`,
 * ready to feed straight into `reduceEnvelopes` (kvy-system-design.md
 * §9.1, plan.md's timeline live-wiring follow-up).
 *
 * Each row's `content` is a *batch*, not a single envelope: the CLI's HTTP
 * outbox coalesces up to 20 envelopes (or 300ms) into one `seal(batch, dek)`
 * call before POSTing (`packages/cli/src/api/outbox.ts`) — this is the
 * web's mirror-image "open" of that exact wrapping. Row order doesn't
 * matter here: `reduceEnvelopes` dedupes by id and stable-sorts by `time`
 * internally, so batches from different pages/rows can simply be
 * flattened together.
 *
 * A row that fails to decrypt (foreign/rotated DEK, corrupt ciphertext) or
 * fails schema validation (a future/incompatible batch shape) is logged and
 * dropped rather than thrown — one bad row must not blank the whole
 * timeline, but it also must never fail silently (design principle: no
 * silent failures).
 */
export interface MessageDecryptor {
  open<T = unknown>(box: EncryptedBox): Promise<T | null>;
}

const BatchSchema = z.array(SessionEnvelopeSchema);

export async function decryptMessageBatches(
  pages: MessagesPage[],
  crypto: MessageDecryptor,
): Promise<SessionEnvelope[]> {
  const rows = pages.flatMap((page) => page.messages);
  const batches = await Promise.all(
    rows.map(async (row): Promise<SessionEnvelope[]> => {
      const opened = await crypto.open<unknown>(row.content);
      if (opened === null) {
        console.error(`decryptMessageBatches: failed to decrypt message batch seq=${row.seq}`);
        return [];
      }
      const parsed = BatchSchema.safeParse(opened);
      if (!parsed.success) {
        console.error(
          `decryptMessageBatches: message batch seq=${row.seq} failed schema validation`,
          parsed.error,
        );
        return [];
      }
      return parsed.data;
    }),
  );
  return batches.flat();
}
