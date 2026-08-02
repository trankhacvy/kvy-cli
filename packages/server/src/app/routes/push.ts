import { PushSubscribeBodySchema, PushUnsubscribeBodySchema } from "@kvy/wire";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isUniqueViolation } from "../../db/errors.js";
import { pushSubscriptions } from "../../db/schema.js";
import type { Database } from "../../db/types.js";

const SubscribeResponseSchema = z.object({ id: z.string() });
const UnsubscribeResponseSchema = z.object({ ok: z.literal(true) });
const SubscribeConflictSchema = z.object({ error: z.string() });

/**
 * Registers/removes one row per device+channel — a device re-subscribing
 * (browser push subscriptions rotate their endpoint on renewal, and a
 * user may re-link the same Telegram chat) upserts on `endpoint`, which is
 *
 * No content ever touches this table — `keys` is the Web Push transport
 * transport, not content").
 */
export function buildPushRoutes(db: Database): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/push/subscribe",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          body: PushSubscribeBodySchema,
          response: { 200: SubscribeResponseSchema, 409: SubscribeConflictSchema },
        },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const { channel, endpoint, keys } = req.body;

        try {
          const [inserted] = await db
            .insert(pushSubscriptions)
            .values({ accountId, channel, endpoint, keys: keys ?? null })
            .returning();
          if (!inserted) throw new Error("POST /v1/push/subscribe: insert returned no row");
          return { id: inserted.id };
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;

          // Re-subscribe with an endpoint already on file — idempotent for the
          // *same* account (e.g. a retried request, or the client resending
          // its subscription on every app start). `endpoint` is globally
          // existing subscription to a different caller rather than updating
          // across accounts.
          const existing = await db.query.pushSubscriptions.findFirst({
            where: eq(pushSubscriptions.endpoint, endpoint),
          });
          if (!existing) throw err;
          if (existing.accountId !== accountId) {
            return reply
              .code(409)
              .send({ error: "endpoint already registered to another account" });
          }

          const [updated] = await db
            .update(pushSubscriptions)
            .set({ channel, keys: keys ?? null })
            .where(eq(pushSubscriptions.id, existing.id))
            .returning();
          if (!updated) throw err;
          return { id: updated.id };
        }
      },
    );

    app.delete(
      "/v1/push/subscribe",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          body: PushUnsubscribeBodySchema,
          response: { 200: UnsubscribeResponseSchema },
        },
      },
      async (req) => {
        const accountId = req.accountId;
        const { endpoint } = req.body;

        // Scoped to the caller's own account — deleting by `endpoint` alone
        // would let one account unsubscribe another's device.
        await db
          .delete(pushSubscriptions)
          .where(
            and(
              eq(pushSubscriptions.accountId, accountId),
              eq(pushSubscriptions.endpoint, endpoint),
            ),
          );
        return { ok: true as const };
      },
    );
  };
}
