import { and, eq, ne } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { sessions } from "../../db/schema.js";
import { allocHeaderSeq } from "../../db/seq.js";
import type { Database } from "../../db/types.js";
import type { EventRouterPort } from "../events/eventRouter.js";
import type { PushDispatcherPort } from "../push/types.js";
import { NotFoundSchema, SessionIdParamsSchema } from "./shared.js";

// `error` is a short, human-readable diagnostic string (e.g. an exit-code
// summary or exception message), not user content — it is never persisted,
// only logged server-side and used to decide whether to fan out at all. The
// payloads the server never reads) still holds: nothing derived from this
// means the session's `status` flips to `failed` (session-update) plus an
// failed" push trigger) — clients already show a generic, session-scoped
// signal for that, same as every other attention kind.
//
// (`start.ts`) reports it on a normal exit or SIGTERM/SIGHUP, so the web can
// show the session as over instead of inferring nothing. It only fans out
// `session-update` — unlike `failed`, ending a session isn't itself an
// attention-worthy event (no push, no `attention` ephemeral); a resumable
// lifecycle-push list (`LifecycleKindSchema`) covers.
const SessionStatusBodySchema = z.object({
  status: z.enum(["failed", "ended"]),
  error: z.string().max(2000).optional(),
});
const SessionStatusResponseSchema = z.object({ status: z.enum(["failed", "ended"]) });

/**
 * adds the `ended` normal/signal-exit report). Deliberately narrow: unlike
 * `sessionCas.ts`'s CAS routes (`PUT .../metadata|state`), this is not a
 * generic, optimistically-concurrent status setter — it only ever
 * transitions a session to one of these two terminal statuses, and takes no
 * `expectedVersion`.
 *
 * Rationale for skipping full optimistic-concurrency CAS here: this route
 * exists for exactly one caller shape — a best-effort exit/crash report,
 * fired from `start.ts`'s normal-exit path, a signal/uncaught-exception
 * handler racing the process's own shutdown, OR the DAEMON's own
 * best-effort fallback report when it observes a spawned process exit
 * without ever seeing the session's own clean report land (this covers
 * orphaned active session rows when the process dies after DB-row creation
 * on an otherwise-healthy machine; the CLI-side fix is
 * `daemon/machineIntegration.ts`'s `watchForUnreportedDeath`). A dropped/
 * duplicate retry of that POST must still succeed the same way (idempotent).
 *
 * That second caller IS a second legitimate writer, though — unlike the
 * original single-writer assumption, `failed` can now race a session's own
 * `ended` report (deliberately imprecise on purpose: the daemon can't always
 * tell whether the process's own exit was clean, so it reports on nearly any
 * exit and lets the server decide whether it still matters). The one targeted
 * guard below — `failed` only ever applies to a session still `active` — is
 * what keeps that safe: a late/redundant daemon report can never downgrade an
 * already-`ended` (or already-`failed`) session back to `failed`.
 *
 * `ended` has a second legitimate writer too now: the web's Archive action
 * (`sessionArchive.ts`) stops a still-live process (via the session `stop`
 * RPC) before marking the row `archived` — the CLI's own graceful-exit
 * report for that same signal can land either before or after the archive
 * PATCH. Mirroring the `failed` guard, `ended` never applies to a session
 * that's already `archived`: archive is the stronger, user-initiated
 * terminal state, and a stray graceful-exit report racing in afterward must
 * not downgrade it back to a merely-ended-looking row.
 */
export function buildSessionStatusRoutes(
  db: Database,
  eventRouter: EventRouterPort,
  pushDispatcher: PushDispatcherPort,
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
        const { status, error } = req.body;

        if (error) {
          app.log.warn({ sessionId: id, accountId, status, error }, `session reported ${status}`);
        }

        const outcome = await db.transaction(async (tx) => {
          const session = await tx.query.sessions.findFirst({
            where: and(eq(sessions.id, id), eq(sessions.accountId, accountId)),
          });
          if (!session) return { outcome: "not-found" as const };

          // Idempotent no-op: a retried best-effort POST (or a second
          // crash/exit signal firing during the same shutdown) must not bump
          // headerSeq or fan out a second time for a session already in this
          // exact status.
          if (session.status === status) return { outcome: "already-set" as const };

          // `failed` now has a second legitimate writer (the daemon's own
          // best-effort fallback report, `machineIntegration.ts`'s
          // `watchForUnreportedDeath` — see this route's own doc comment).
          // Guard it to only ever apply to a still-`active` session so a
          // late/imprecise daemon report can never downgrade a session that
          // already reported its own `ended`/`failed` outcome. `ended` has
          // its own second writer (the web's Archive action, see this
          // route's own doc comment) — guarded the same way, just against
          // `archived` specifically rather than requiring `active`.
          if (status === "failed" && session.status !== "active") {
            return { outcome: "already-set" as const };
          }
          if (status === "ended" && session.status === "archived") {
            return { outcome: "already-set" as const };
          }

          const updated = await tx
            .update(sessions)
            .set({ status, updatedAt: new Date() })
            .where(
              and(
                eq(sessions.id, id),
                eq(sessions.accountId, accountId),
                ...(status === "failed" ? [eq(sessions.status, "active")] : []),
                ...(status === "ended" ? [ne(sessions.status, "archived")] : []),
              ),
            )
            .returning();

          // Re-check the affected-row count — a concurrent writer (the CLI's
          // own report racing the daemon's fallback report for `failed`, or
          // racing the web's Archive action for `ended`) could have moved the
          // session off the required current-status between the read above
          // and this statement (READ COMMITTED). Losing that race is a
          // no-op, not an error — matches `staleSessions.ts`'s own
          // `.returning()`-based CAS pattern.
          if ((status === "failed" || status === "ended") && updated.length === 0) {
            return { outcome: "already-set" as const };
          }

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
                body: { t: "session-update", id, status },
              },
            });
            // push trigger + in-tab attention dot) — `ended` is a normal/
            // resumable exit, not something to notify or badge on.
            if (status === "failed") {
              eventRouter.emitEphemeral({
                accountId,
                recipientFilter: { type: "all-interested-in-session", sessionId: id },
                payload: { t: "attention", sessionId: id, kind: "failed" },
              });
              // blocks the response; presence-suppressed inside the dispatcher.
              void pushDispatcher.dispatch({ accountId, sessionId: id, kind: "failed" });
            }
          });
        }

        return { status };
      },
    );
  };
}
