import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { sessions } from "../../db/schema.js";
import { allocHeaderSeq } from "../../db/seq.js";
import type { Database } from "../../db/types.js";
import type { EventRouterPort } from "../events/eventRouter.js";
import { NotFoundSchema, SessionIdParamsSchema } from "./shared.js";

// `error` is a short, human-readable diagnostic string (e.g. an exit-code
// summary or exception message), not user content — it is never persisted,
// only logged server-side and used to decide whether to fan out at all. The
// E2E model (design §5.3/§6.1: content columns are opaque EncryptedBox
// payloads the server never reads) still holds: nothing derived from this
// field reaches another client in plaintext. "Surfaced remotely" per FR-3.7
// means the session's `status` flips to `failed` (session-update) plus an
// `attention{kind:'failed'}` ephemeral (design §6.4's existing "session
// failed" push trigger) — clients already show a generic, session-scoped
// signal for that, same as every other attention kind.
const SessionStatusBodySchema = z.object({
  status: z.literal("failed"),
  error: z.string().max(2000).optional(),
});
const SessionStatusResponseSchema = z.object({ status: z.literal("failed") });

/**
 * `POST /v1/sessions/:id/status` (PRD FR-3.7; design §7.5's mode state
 * machine — "Crash ⇒ status `failed` + error surfaced"). Deliberately
 * narrow: unlike `sessionCas.ts`'s CAS routes (`PUT .../metadata|state`),
 * this is not a generic, optimistically-concurrent status setter — it only
 * ever transitions a session to `failed`, and takes no `expectedVersion`.
 *
 * Rationale for skipping CAS here: this route exists for exactly one
 * caller shape — a CLI session process's best-effort crash report, fired
 * from a signal/uncaught-exception handler that may itself be racing the
 * process's own shutdown. A dropped/duplicate retry of that POST must
 * still succeed the same way (idempotent), and there is no legitimate
 * concurrent writer to lose a race against: nothing else on `main` today
 * transitions `sessions.status` at all. Explicit archive (`POST
 * .../archive`, design §6.2) and any richer status lifecycle are separate,
 * out-of-scope future work (plan.md §16 "1.4 Transcript pipeline").
 */
export function buildSessionStatusRoutes(
  db: Database,
  eventRouter: EventRouterPort,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/sessions/:id/status",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          params: SessionIdParamsSchema,
          body: SessionStatusBodySchema,
          response: { 200: SessionStatusResponseSchema, 404: NotFoundSchema },
        },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const { id } = req.params;
        const { error } = req.body;

        if (error) {
          app.log.warn({ sessionId: id, accountId, error }, "session reported failed");
        }

        const outcome = await db.transaction(async (tx) => {
          const session = await tx.query.sessions.findFirst({
            where: and(eq(sessions.id, id), eq(sessions.accountId, accountId)),
          });
          if (!session) return { outcome: "not-found" as const };

          // Idempotent no-op: a retried best-effort POST (or a second crash
          // signal firing during the same shutdown) must not bump headerSeq
          // or fan out a second time for a session already marked failed.
          if (session.status === "failed") return { outcome: "already-failed" as const };

          await tx
            .update(sessions)
            .set({ status: "failed", updatedAt: new Date() })
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
                body: { t: "session-update", id, status: "failed" },
              },
            });
            eventRouter.emitEphemeral({
              accountId,
              recipientFilter: { type: "all-interested-in-session", sessionId: id },
              payload: { t: "attention", sessionId: id, kind: "failed" },
            });
          });
        }

        return { status: "failed" as const };
      },
    );
  };
}
