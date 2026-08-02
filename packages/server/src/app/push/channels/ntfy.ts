import { env } from "../../../config.js";
import type { PushChannel } from "../types.js";
import { notificationDeepLink, notificationLabel } from "./messageText.js";

/**
 * `endpoint` holds the ntfy.sh (or self-hosted ntfy) topic name the user
 * configured in Settings — no pairing needed, unlike Telegram, since a topic
 * is just a name the user picks; `POST /v1/push/subscribe` already accepts
 * `channel: "ntfy"` subscriptions directly.
 *
 * Same content-free, kind-keyed payload rule as every other channel (see
 * `messageText.ts`): the label is ntfy's message body, and the deep link (if
 * `PUBLIC_WEB_ORIGIN` is configured) rides in ntfy's `Click` header so
 * tapping the notification opens the session directly.
 */
export const ntfyChannel: PushChannel = {
  async send(sub, payload) {
    const label = notificationLabel(payload.kind);
    const link = notificationDeepLink(payload.sessionId);
    const url = `${env.NTFY_BASE_URL.replace(/\/+$/, "")}/${encodeURIComponent(sub.endpoint)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Title: "Kvy",
        ...(link ? { Click: link } : {}),
      },
      body: label,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`ntfy publish failed (${response.status}): ${body}`);
    }
  },
};
