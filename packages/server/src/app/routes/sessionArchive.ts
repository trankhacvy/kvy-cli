import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { sessions } from "../../db/schema.js";
import { allocHeaderSeq } from "../../db/seq.js";
import type { Database } from "../../db/types.js";
import type { EventRouterPort } from "../events/eventRouter.js";
import { NotFoundSchema, SessionIdParamsSchema } from "./shared.js";

const ArchiveResponseSchema = z.object({ status: z.literal("archived") });
const DeleteResponseSchema = z.object({});

/**
 * `POST /v1/sessions/:id/archive` + `DELETE /v1/sessions/:id`
 * (falcon-system-design.md §6.2/§6.1's `sessions.status = 'archived'` note,
 * plan-v2.md W4.2 "Archive/delete: server routes exist … wire buttons" —
 * that line assumed these routes already existed; they didn't yet, so this
 * is where they land). Both wire shapes (`session-update{status:"archived"}`,
 * `session-delete`) were already defined on `UpdateBodySchema` — no wire
 * change needed here, just the first two callers.
 *
 * Neither route has a CLI-side reaction (design §6.1 note ported into the
 * plan: "an archived live session keeps running" — W2.3's `stop` RPC is the
 * "end it" path for that). Archive is a plain, idempotent status transition
 * mirroring `sessionStatus.ts`'s "failed" route's own shape (no CAS —
 * there's no legitimate concurrent writer to lose a race against for a
 * user-initiated archive either). Delete is a hard row delete; every FK that
 * references `sessions.id` (`session_messages`) is declared `onDelete:
 * "cascade"` in `schema.ts`, so this is the one place in the schema where a
 * cascade, not a soft-delete tombstone, is the intended behavior.
 */
export function buildSessionArchiveRoutes(
  db: Database,
  eventRouter: EventRouterPort,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/sessions/:id/archive",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          params: SessionIdParamsSchema,
          response: { 200: ArchiveResponseSchema, 404: NotFoundSchema },
        },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const { id } = req.params;

        const outcome = await db.transaction(async (tx) => {
          const session = await tx.query.sessions.findFirst({
            where: and(eq(sessions.id, id), eq(sessions.accountId, accountId)),
          });
          if (!session) return { outcome: "not-found" as const };

          // Idempotent no-op — a retried POST (double-click, offline replay)
          // must not bump headerSeq or fan out a second time.
          if (session.status === "archived") return { outcome: "already-archived" as const };

          await tx
            .update(sessions)
            .set({ status: "archived", updatedAt: new Date() })
            .where(and(eq(sessions.id, id), eq(sessions.accountId, accountId)));

          const headerSeq = await allocHeaderSeq(tx, accountId);
          return { outcome: "updated" as const, headerSeq };
        });

        if (outcome.outcome === "not-found") return reply.code(404).send({});

        if (outcome.outcome === "updated") {
          reply.raw.once("finish", () => {
            eventRouter.emitUpdate({
              accountId,
              recipientFilter: { type: "all-interested-in-session", sessionId: id },
              payload: {
                seq: outcome.headerSeq,
                ts: Date.now(),
                body: { t: "session-update", id, status: "archived" },
              },
            });
          });
        }

        return { status: "archived" as const };
      },
    );

    app.delete(
      "/v1/sessions/:id",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          params: SessionIdParamsSchema,
          response: { 200: DeleteResponseSchema, 404: NotFoundSchema },
        },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const { id } = req.params;

        const outcome = await db.transaction(async (tx) => {
          const [deleted] = await tx
            .delete(sessions)
            .where(and(eq(sessions.id, id), eq(sessions.accountId, accountId)))
            .returning({ id: sessions.id });
          if (!deleted) return { outcome: "not-found" as const };

          const headerSeq = await allocHeaderSeq(tx, accountId);
          return { outcome: "deleted" as const, headerSeq };
        });

        if (outcome.outcome === "not-found") return reply.code(404).send({});

        reply.raw.once("finish", () => {
          eventRouter.emitUpdate({
            accountId,
            recipientFilter: { type: "all-interested-in-session", sessionId: id },
            payload: {
              seq: outcome.headerSeq,
              ts: Date.now(),
              body: { t: "session-delete", id },
            },
          });
        });

        return {};
      },
    );
  };
}
