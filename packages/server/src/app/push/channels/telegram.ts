import { env } from "../../../config.js";
import type { PushChannel } from "../types.js";
import { notificationDeepLink, notificationLabel } from "./messageText.js";

/**
 * Raw Telegram Bot API `sendMessage` call, shared by the push channel below
 * and `routes/telegramLink.ts`'s webhook (which sends a one-off pairing
 * confirmation once `/start <code>` resolves). Errors are the caller's
 * problem to handle — this never swallows anything itself.
 */
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const err = new Error(`telegram sendMessage failed (${response.status}): ${body}`) as Error & {
      statusCode?: number;
    };
    // Telegram's shape for "this chat is gone" (deleted account, bot blocked,
    // or a chat id that never existed) is a 400/403, not a 404/410 — map it
    // onto the statusCode dispatch.ts already knows to prune on (mirrors
    // webpush's 404/410 "DeviceNotRegistered" convention).
    if (response.status === 400 || response.status === 403) {
      err.statusCode = 410;
    }
    throw err;
  }
}

/**
 * Kvy-add fallback channel (plan.md §10, kvy-system-design.md §6.4:
 * "iOS reality" — Web Push on iOS Safari requires an installed PWA and is
 * unreliable, and the notification IS the product). `endpoint` holds the
 * Telegram chat id captured by the bot's `/start` deep-link pairing flow
 * (`routes/telegramLink.ts`). Same content-free, kind-keyed payload rule as
 * every other channel — see `messageText.ts`.
 */
export const telegramChannel: PushChannel = {
  async send(sub, payload) {
    if (!env.TELEGRAM_BOT_TOKEN) {
      console.error(
        { module: "push", channel: "telegram" },
        "TELEGRAM_BOT_TOKEN not configured — dropping notification",
      );
      return;
    }

    const label = notificationLabel(payload.kind);
    const link = notificationDeepLink(payload.sessionId);
    await sendTelegramMessage(sub.endpoint, link ? `${label}\n${link}` : label);
  },
};
