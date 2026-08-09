/**
 * `GET /v1/auth/sessions` + `PATCH /v1/auth/sessions/:id` + `POST /v1/auth/sessions/:id/revoke` +
 * `POST /v1/auth/sessions/current/revoke` + `POST /v1/auth/sessions/revoke-others` — lets an account
 * manage its own `device_sessions` (the web Settings "Devices" list), and makes
 * revocation genuinely immediate by disconnecting any live socket for the revoked
 */
import { and, eq, ne } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { accounts, authIdentities, deviceSessions } from "../../db/schema.js";
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

/** Narrows the untyped `auth_identities.kind` text column — guards against a
 * future/foreign value rather than trusting the DB blindly. */
function toIdentityKind(kind: string | undefined): "password" | "google" | "github" | null {
  return kind === "password" || kind === "google" || kind === "github" ? kind : null;
}

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
        schema: {
          response: {
            200: z.object({
              // this is the read path for the email `routes/oauth.ts` (and
              // `routes/password.ts`) capture onto `auth_identities` — there being
              // no other account-summary endpoint to hang it off. Best-effort
              // display only, never authoritative: unverified emails are included
              // the same as verified ones (there's no auth decision riding on it
              // here), so this is a UI label, not a claim of ownership.
              email: z.string().nullable(),
              // Avatar URL, same best-effort/display-only treatment as `email` — null
              // for password identities (never captured) or before the first OAuth
              // sign-in refreshed it.
              image: z.string().nullable(),
              // 'password' identities exist for local/dev only (prod only offers
              // Google/GitHub sign-in) — null when there's no identity row yet.
              identityKind: z.enum(["password", "google", "github"]).nullable(),
              // Same nullable shape as `email` above — the `accounts` row is
              // practically always present (every FK that reaches this route
              // requires it), but stays honest about the edge case rather than
              // reporting a fabricated "created today".
              accountCreatedAt: z.string().nullable(),
              sessions: z.array(DeviceSessionRowSchema),
            }),
          },
        },
      },
      async (request, reply) => {
        const [rows, identity, account] = await Promise.all([
          db.query.deviceSessions.findMany({
            where: eq(deviceSessions.accountId, request.accountId),
          }),
          db.query.authIdentities.findFirst({
            where: eq(authIdentities.accountId, request.accountId),
          }),
          db.query.accounts.findFirst({ where: eq(accounts.id, request.accountId) }),
        ]);
        const active = rows.filter((row) => !row.revokedAt);
        return reply.send({
          email: identity?.email ?? null,
          image: identity?.image ?? null,
          identityKind: toIdentityKind(identity?.kind),
          accountCreatedAt: account?.createdAt.toISOString() ?? null,
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

    app.patch(
      "/v1/auth/sessions/:id",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: {
          params: z.object({ id: z.string().min(1) }),
          body: z.object({ label: z.string().trim().min(1).max(80) }),
          response: {
            200: z.object({ success: z.literal(true), label: z.string() }),
            404: z.object({ error: z.string() }),
          },
        },
      },
      async (request, reply) => {
        const rows = await db
          .update(deviceSessions)
          .set({ label: request.body.label })
          .where(
            and(
              eq(deviceSessions.id, request.params.id),
              eq(deviceSessions.accountId, request.accountId),
            ),
          )
          .returning({ id: deviceSessions.id });
        if (rows.length === 0) return reply.code(404).send({ error: "Session not found" });

        return reply.send({ success: true, label: request.body.label });
      },
    );

    app.post(
      "/v1/auth/sessions/current/revoke",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: {
          response: { 200: z.object({ success: z.literal(true) }) },
        },
      },
      async (request, reply) => {
        await db
          .update(deviceSessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(deviceSessions.id, request.sessionId),
              eq(deviceSessions.accountId, request.accountId),
            ),
          );

        disconnect(request.accountId, request.sessionId);
        return reply.send({ success: true });
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
