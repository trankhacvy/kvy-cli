import { z } from "zod";

/**
 * ephemeral (see `updates.ts`), the server's push-dispatch module
 * (`packages/server/src/app/push/`), and the Web Push payload the service
 */
export const LifecycleKindSchema = z.enum(["perm", "question", "done", "failed"]);
export type LifecycleKind = z.infer<typeof LifecycleKindSchema>;

/**
 * product"). `webpush` is fully wired; `telegram`/`ntfy` accept subscriptions
 * today but their senders are stubs until a later task.
 */
export const PushChannelSchema = z.enum(["webpush", "telegram", "ntfy"]);
export type PushChannelName = z.infer<typeof PushChannelSchema>;

/**
 * p256dh/auth key pair for the `webpush` channel; other channels leave it
 * unset and put their addressing info in `endpoint` instead (a Telegram chat
 * id, an ntfy.sh topic name).
 */
export const PushSubscribeBodySchema = z.object({
  channel: PushChannelSchema,
  endpoint: z.string().min(1).max(2048),
  keys: z
    .object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    })
    .optional(),
});
export type PushSubscribeBody = z.infer<typeof PushSubscribeBodySchema>;

/**
 * `DELETE /v1/push/subscribe` body — unsubscribe by endpoint (the same value
 */
export const PushUnsubscribeBodySchema = z.object({
  endpoint: z.string().min(1).max(2048),
});
export type PushUnsubscribeBody = z.infer<typeof PushUnsubscribeBodySchema>;

/**
 * The JSON body Web Push actually delivers to the service worker (design
 * `kind` alone; the server never sends plaintext session content over push).
 */
export const PushPayloadSchema = z.object({
  sessionId: z.string(),
  kind: LifecycleKindSchema,
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;
