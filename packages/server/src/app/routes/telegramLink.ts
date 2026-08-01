import { encodeBase64Url, getRandomBytes } from "@kvy/crypto";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "../../config.js";
import { pushSubscriptions, telegramLinkRequests } from "../../db/schema.js";
import type { Database } from "../../db/types.js";
import { sendTelegramMessage } from "../push/channels/telegram.js";

// Bounded pairing window, same rationale as `pairRequests` (design §5.2):
// an unbounded window is a standing vulnerability, since the code is the
// only thing standing between "anyone who messages this bot" and "this
// account's push subscriptions".
const LINK_CODE_TTL_MS = 10 * 60_000;

const LinkResponseSchema = z.object({ code: z.string(), deepLink: z.string() });
const LinkErrorSchema = z.object({ error: z.string() });

// Telegram's Update object (https://core.telegram.org/bots/api#update) is
// large; this only reads the two fields the `/start` pairing flow needs.
// `.passthrough()` so the rest of the payload round-trips without being
// rejected by strict zod parsing.
const TelegramUpdateSchema = z
  .object({
    message: z
      .object({
        text: z.string().optional(),
        chat: z.object({ id: z.number() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * `POST /v1/push/telegram/link` + `POST /v1/push/telegram/webhook` —
 * Telegram bot `/start` deep-link pairing (kvy-system-design.md §6.4,
 * plan.md §10: "Telegram bot `/start` pairing"). Two-step flow:
 *
 *  1. The signed-in web client calls `/link`; the server mints a short-lived,
 *     single-use code and returns `https://t.me/<bot>?start=<code>`.
 *  2. The user taps that link, Telegram opens a chat with the bot and sends
 *     `/start <code>` as the first message; Telegram POSTs that message to
 *     `/webhook` (registered out-of-band via the Bot API's `setWebhook`).
 *     The webhook resolves the code back to the account that requested it
 *     and upserts a `push_subscriptions` row for the resulting chat id —
 *     same shape `POST /v1/push/subscribe` would have produced, just
 *     server-initiated because the chat id isn't known until this point.
 */
export function buildTelegramLinkRoutes(db: Database): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/push/telegram/link",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        schema: {
          response: { 200: LinkResponseSchema, 400: LinkErrorSchema },
        },
      },
      async (req, reply) => {
        if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_BOT_USERNAME) {
          return reply.code(400).send({ error: "Telegram isn't configured on this server" });
        }

        const code = encodeBase64Url(getRandomBytes(24));
        await db.insert(telegramLinkRequests).values({
          code,
          accountId: req.accountId,
          expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS),
        });

        return {
          code,
          deepLink: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${code}`,
        };
      },
    );

    // No `app.authenticate` here — this is called by Telegram's servers, not
    // a signed-in Kvy client. `TELEGRAM_WEBHOOK_SECRET` (when configured)
    // is the actual access control, mirroring Telegram's own `secret_token`
    // convention for `setWebhook`.
    app.post(
      "/v1/push/telegram/webhook",
      {
        config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
        schema: { response: { 200: z.object({}), 401: z.object({}) } },
      },
      async (req, reply) => {
        if (env.TELEGRAM_WEBHOOK_SECRET) {
          const header = req.headers["x-telegram-bot-api-secret-token"];
          if (header !== env.TELEGRAM_WEBHOOK_SECRET) {
            return reply.code(401).send({});
          }
        }

        // Always ack 200 past this point — Telegram retries aggressively on
        // any non-2xx, and there's nothing a retry could fix here (a
        // malformed/irrelevant update, or an expired/unknown code).
        const parsed = TelegramUpdateSchema.safeParse(req.body);
        const chatId = parsed.success ? parsed.data.message?.chat?.id : undefined;
        const text = parsed.success ? parsed.data.message?.text : undefined;
        if (!parsed.success || chatId === undefined || !text?.startsWith("/start")) {
          return {};
        }

        const code = text.slice("/start".length).trim();
        if (!code) return {};

        const linkRequest = await db.query.telegramLinkRequests.findFirst({
          where: eq(telegramLinkRequests.code, code),
        });

        if (!linkRequest || linkRequest.expiresAt < new Date()) {
          await sendTelegramMessage(
            String(chatId),
            "This link has expired — generate a new one from Kvy's notification settings.",
          ).catch((err) => {
            console.error({ module: "push", channel: "telegram" }, `webhook reply failed: ${err}`);
          });
          return {};
        }

        // Single-use: delete before acting on it, so a duplicate Telegram
        // retry of the same update can't re-pair (or re-notify) twice.
        await db.delete(telegramLinkRequests).where(eq(telegramLinkRequests.code, code));

        const endpoint = String(chatId);
        // Re-linking always reassigns the chat to whichever account most
        // recently completed pairing — a Telegram chat id belongs to one
        // person, so "the most recent /start wins" is the correct pairing
        // semantics, unlike webpush's endpoint collision (routes/push.ts),
        // which 409s instead.
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
        await db.insert(pushSubscriptions).values({
          accountId: linkRequest.accountId,
          channel: "telegram",
          endpoint,
        });

        await sendTelegramMessage(
          endpoint,
          "You're linked! Kvy will message you here for permission requests, questions, and completed/failed sessions.",
        ).catch((err) => {
          console.error({ module: "push", channel: "telegram" }, `webhook reply failed: ${err}`);
        });

        return {};
      },
    );
  };
}
