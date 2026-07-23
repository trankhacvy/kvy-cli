/**
 * `GET /v1/auth/sessions` + `POST /v1/auth/sessions/:id/revoke` +
 * `POST /v1/auth/sessions/revoke-others` — issue-4-plan.md §4.4: lets an account see and
 * manage its own `device_sessions` (the web Settings "Devices" list), and makes
 * revocation genuinely immediate by disconnecting any live socket for the revoked
 * session (§4.5c), not just waiting for its access token to expire.
 */
import { and, eq, ne } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { deviceSessions } from "../../db/schema.js";
import type { Database } from "../../db/types.js";

const DeviceSessionRowSchema = z.object({
  id: z.string(),
  clientKind: z.string(),
  label: z.string().nullable(),
  machineId: z.string().nullable(),
  createdAt: z.string(),
  lastRefreshedAt: z.string().nullable(),
  expiresAt: z.string(),
  isCurrent: z.boolean(),
});

/**
 * `disconnect` is a thin closure over `eventRouter.ts`'s `disconnectSession` — injected
 * (rather than importing the singleton directly) so tests can assert "a disconnect was
 * requested for this session" without a real Socket.IO server, the same seam every
 * other route uses for `eventRouter`/`pushDispatcher`.
 */
export function buildSessionsAdminRoutes(
  db: Database,
  disconnect: (accountId: string, sessionId: string) => void,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      "/v1/auth/sessions",
      {
        preHandler: app.authenticate,
        schema: { response: { 200: z.object({ sessions: z.array(DeviceSessionRowSchema) }) } },
      },
      async (request, reply) => {
        const rows = await db.query.deviceSessions.findMany({
          where: eq(deviceSessions.accountId, request.accountId),
        });
        const active = rows.filter((row) => !row.revokedAt);
        return reply.send({
          sessions: active.map((row) => ({
            id: row.id,
            clientKind: row.clientKind,
            label: row.label,
            machineId: row.machineId,
            createdAt: row.createdAt.toISOString(),
            lastRefreshedAt: row.lastRefreshedAt?.toISOString() ?? null,
            expiresAt: row.expiresAt.toISOString(),
            isCurrent: row.id === request.sessionId,
          })),
        });
      },
    );

    app.post(
      "/v1/auth/sessions/:id/revoke",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: {
          params: z.object({ id: z.string().min(1) }),
          response: {
            200: z.object({ success: z.literal(true) }),
            404: z.object({ error: z.string() }),
          },
        },
      },
      async (request, reply) => {
        const rows = await db
          .update(deviceSessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(deviceSessions.id, request.params.id),
              eq(deviceSessions.accountId, request.accountId),
            ),
          )
          .returning({ id: deviceSessions.id });
        if (rows.length === 0) return reply.code(404).send({ error: "Session not found" });

        disconnect(request.accountId, request.params.id);
        return reply.send({ success: true });
      },
    );

    app.post(
      "/v1/auth/sessions/revoke-others",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: { response: { 200: z.object({ success: z.literal(true), revoked: z.number() }) } },
      },
      async (request, reply) => {
        const rows = await db
          .update(deviceSessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(deviceSessions.accountId, request.accountId),
              ne(deviceSessions.id, request.sessionId),
            ),
          )
          .returning({ id: deviceSessions.id });

        for (const row of rows) disconnect(request.accountId, row.id);
        return reply.send({ success: true, revoked: rows.length });
      },
    );
  };
}
