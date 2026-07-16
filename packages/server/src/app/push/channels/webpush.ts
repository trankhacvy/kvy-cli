import { PushPayloadSchema } from "@falcon/wire";
import webpush from "web-push";
import { env } from "../../../config.js";
import type { PushChannel } from "../types.js";

/**
 * `web-push`'s VAPID details are process-global (`webpush.setVapidDetails`
 * mutates a module-level singleton inside the library) — configure once,
 * lazily, the first time a send is attempted. Falls back to a documented
 * no-op (logged) rather than throwing when the keys aren't set, matching the
 * rest of this module's "missing config = skipped capability, not a crash"
 * stance (see config.ts's VAPID_* comment).
 */
let vapidConfigured = false;

function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  vapidConfigured = true;
  return true;
}

/**
 * The `webpush` push channel (design §3 "Push | Web Push (VAPID) via
 * `web-push`", §6.4). Payload is deliberately generic — `{sessionId, kind}`
 * only, `PushPayloadSchema`-shaped — never session content: the server holds
 * no keys to decrypt it anyway (design §5.3), and the service worker renders
 * a fixed, kind-keyed title/body client-side (`public/sw.js`).
 */
export const webpushChannel: PushChannel = {
  async send(sub, payload) {
    if (!ensureVapidConfigured()) {
      console.error(
        { module: "push", channel: "webpush" },
        "VAPID keys not configured — dropping notification",
      );
      return;
    }

    const keys = sub.keys as { p256dh?: unknown; auth?: unknown } | null;
    if (typeof keys?.p256dh !== "string" || typeof keys.auth !== "string") {
      throw new Error(`webpush subscription ${sub.id} is missing p256dh/auth keys`);
    }

    const body = JSON.stringify(PushPayloadSchema.parse(payload));
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
      body,
    );
  },
};
