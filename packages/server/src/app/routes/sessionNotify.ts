import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { sessions } from "../../db/schema.js";
import type { Database } from "../../db/types.js";
import type { EventRouterPort } from "../events/eventRouter.js";
import type { PushDispatcherPort } from "../push/types.js";
import { NotFoundSchema, SessionIdParamsSchema } from "./shared.js";

// The three lifecycle kinds this route reports; `failed` has its own richer
// endpoint (`POST /v1/sessions/:id/status`, which also transitions
// `sessions.status`) — see the module doc below.
const NotifyBodySchema = z.object({ kind: z.enum(["perm", "question", "done"]) });
const NotifyResponseSchema = z.object({ ok: z.literal(true) });

/**
 * `POST /v1/sessions/:id/notify` — the generic lifecycle-signal endpoint
 * turn-end(status!=cancelled)"). Deliberately content-free — `kind` only, no
 * title/body/data — because session content is E2E encrypted and the server
 * :sessionId/push-event` carries plaintext title/body because Happy has no
 * E2E encryption; Kvy's push payload stays `{sessionId, kind}` and the
 * client renders a fixed, kind-keyed message.
 *
 * Callers: the CLI's transcript pipeline already detects `turn-end` locally
 * (the `SessionEvent` `turn-end` variant, `@kvy/wire`'s `session.ts`) and
 * will POST here on a remote-initiated turn's completion once that call site
 * is wired (out of scope for this task — CLI is a disjoint worktree); the
 * lands. Both are unblocked by this route existing now: `kind` is generic,
 * so no dispatch-side change is needed when those callers arrive.
 *
 * Same fan-out shape as `sessionStatus.ts`'s `failed` branch: an `attention`
 * fire-and-forget push dispatch (presence-suppressed).
 */
export function buildSessionNotifyRoutes(
  db: Database,
  eventRouter: EventRouterPort,
  pushDispatcher: PushDispatcherPort,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/sessions/:id/notify",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          params: SessionIdParamsSchema,
          body: NotifyBodySchema,
          response: { 200: NotifyResponseSchema, 404: NotFoundSchema },
        },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const { id } = req.params;
        const { kind } = req.body;

        const session = await db.query.sessions.findFirst({
          where: and(eq(sessions.id, id), eq(sessions.accountId, accountId)),
          columns: { id: true },
        });
        if (!session) return reply.code(404).send({});

        eventRouter.emitEphemeral({
          accountId,
          recipientFilter: { type: "all-interested-in-session", sessionId: id },
          payload: { t: "attention", sessionId: id, kind },
        });

        void pushDispatcher.dispatch({ accountId, sessionId: id, kind });

        return { ok: true as const };
      },
    );
  };
}
