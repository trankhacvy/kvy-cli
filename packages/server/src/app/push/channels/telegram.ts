import type { PushChannel } from "../types.js";

/**
 * Falcon-add fallback channel (plan.md §10, falcon-system-design.md §6.4:
 * "iOS reality" — Web Push on iOS Safari requires an installed PWA and is
 * unreliable, and the notification IS the product). `endpoint` holds the
 * Telegram chat id from the bot's `/start` deep-link pairing flow.
 *
 * Stub only (task scope: "implement webpush fully now, stub telegram/ntfy
 * interfaces for a later task"). `POST /v1/push/subscribe` already accepts
 * `channel: "telegram"` subscriptions so the pairing UI can ship ahead of
 * the sender; this is the documented no-op until the bot integration lands
 * — logged, not thrown, so one unimplemented channel never breaks fan-out
 * to a caller's other subscriptions (`dispatch.ts` catches per-subscription
 * regardless, but this keeps the intent explicit at the source).
 */
export const telegramChannel: PushChannel = {
  async send(sub) {
    console.error(
      { module: "push", channel: "telegram" },
      `telegram channel not yet implemented — dropping notification for subscription ${sub.id}`,
    );
  },
};
