import { z } from "zod";

/**
 * The lifecycle events Falcon ever pushes/notifies on — design §5.8 FR-8.2,
 * §10: "no per-message notifications, ever." Shared by the `attention`
 * ephemeral (see `updates.ts`), the server's push-dispatch module
 * (`packages/server/src/app/push/`), and the Web Push payload the service
 * worker decodes (design §6.4: "payload contains only `{sessionId, kind}`").
 */
export const LifecycleKindSchema = z.enum(["perm", "question", "done", "failed"]);
export type LifecycleKind = z.infer<typeof LifecycleKindSchema>;

/**
 * `pushSubscriptions.channel` (design §6.1) — Falcon-add fallback channels
 * (plan.md §10: "iOS Web Push is unreliable, and the notification IS the
 * product"). `webpush` is fully wired; `telegram`/`ntfy` accept subscriptions
 * today but their senders are stubs until a later task.
 */
export const PushChannelSchema = z.enum(["webpush", "telegram", "ntfy"]);
export type PushChannelName = z.infer<typeof PushChannelSchema>;

/**
 * `POST /v1/push/subscribe` body (design §6.2). `keys` carries the Web Push
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
 * that was POSTed; unique per subscription, design §6.1).
 */
export const PushUnsubscribeBodySchema = z.object({
  endpoint: z.string().min(1).max(2048),
});
export type PushUnsubscribeBody = z.infer<typeof PushUnsubscribeBodySchema>;

/**
 * The JSON body Web Push actually delivers to the service worker (design
 * §6.4: generic, content-free — title/body are rendered client-side from
 * `kind` alone; the server never sends plaintext session content over push).
 */
export const PushPayloadSchema = z.object({
  sessionId: z.string(),
  kind: LifecycleKindSchema,
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;
