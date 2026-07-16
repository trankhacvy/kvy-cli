import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { accounts, sessions } from "../../db/schema.js";
import { allocHeaderSeq } from "../../db/seq.js";
import type { Database } from "../../db/types.js";
import type { EventRouterPort } from "../events/eventRouter.js";
import { NotFoundSchema, SessionIdParamsSchema } from "./shared.js";

const MutedAllBodySchema = z.object({ mutedAll: z.boolean() });
const MutedAllResponseSchema = z.object({ mutedAll: z.boolean() });

const SessionMuteBodySchema = z.object({ muted: z.boolean() });
const SessionMuteResponseSchema = z.object({ muted: z.boolean() });

/**
 * Per-account quiet controls (PRD FR-8.3, plan.md §10 "Per-session mute +
 * mute-all settings"). Plaintext columns (`accounts.notificationsMutedAll`,
 * `sessions.notificationsMuted`) — not the encrypted `settings`/`metadata`
 * blobs — because the push dispatcher (`app/push/dispatch.ts`) has to be
 * able to check them without decrypting anything (design §5.3: the server
 * holds no keys). Both routes are plain booleans, not CAS: there's no
 * legitimate concurrent writer to race against (a user only ever flips their
 * own mute switch from one settings page at a time), unlike the versioned
 * `metadata`/`agentState` fields in `sessionCas.ts`.
 */
export function buildNotificationSettingsRoutes(
  db: Database,
  eventRouter: EventRouterPort,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      "/v1/account/notifications-mute",
      {
        preHandler: app.authenticate,
        schema: { response: { 200: MutedAllResponseSchema } },
      },
      async (req) => {
        const account = await db.query.accounts.findFirst({
          where: eq(accounts.id, req.accountId),
          columns: { notificationsMutedAll: true },
        });
        if (!account) {
          throw new Error(
            `GET /v1/account/notifications-mute: authenticated accountId ${req.accountId} has no account row`,
          );
        }
        return { mutedAll: account.notificationsMutedAll };
      },
    );

    app.put(
      "/v1/account/notifications-mute",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          body: MutedAllBodySchema,
          response: { 200: MutedAllResponseSchema },
        },
      },
      async (req) => {
        const [updated] = await db
          .update(accounts)
          .set({ notificationsMutedAll: req.body.mutedAll })
          .where(eq(accounts.id, req.accountId))
          .returning();
        if (!updated) {
          throw new Error(
            `PUT /v1/account/notifications-mute: authenticated accountId ${req.accountId} has no account row`,
          );
        }
        return { mutedAll: updated.notificationsMutedAll };
      },
    );

    app.put(
      "/v1/sessions/:id/notifications-mute",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          params: SessionIdParamsSchema,
          body: SessionMuteBodySchema,
          response: { 200: SessionMuteResponseSchema, 404: NotFoundSchema },
        },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const { id } = req.params;
        const { muted } = req.body;

        const outcome = await db.transaction(async (tx) => {
          const session = await tx.query.sessions.findFirst({
            where: and(eq(sessions.id, id), eq(sessions.accountId, accountId)),
            columns: { id: true, notificationsMuted: true },
          });
          if (!session) return { status: "not-found" as const };
          if (session.notificationsMuted === muted) {
            // Idempotent no-op: don't bump headerSeq / fan out for a setting
            // that's already at the requested value (e.g. a retried request).
            return { status: "unchanged" as const };
          }

          await tx
            .update(sessions)
            .set({ notificationsMuted: muted, updatedAt: new Date() })
            .where(and(eq(sessions.id, id), eq(sessions.accountId, accountId)));

          const headerSeq = await allocHeaderSeq(tx, accountId);
          return { status: "updated" as const, headerSeq };
        });

        if (outcome.status === "not-found") return reply.code(404).send({});

        if (outcome.status === "updated") {
          reply.raw.once("finish", () => {
            eventRouter.emitUpdate({
              accountId,
              recipientFilter: { type: "all-interested-in-session", sessionId: id },
              payload: {
                seq: outcome.headerSeq,
                ts: Date.now(),
                body: { t: "session-update", id, notificationsMuted: muted },
              },
            });
          });
        }

        return { muted };
      },
    );
  };
}
