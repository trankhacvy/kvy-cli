/**
 * `POST /v1/keys/request` + `GET /v1/keys/requests` + `POST /v1/keys/request/approve`
 * + `POST /v1/keys/request/claim` — docs/auth-ux-overhaul-plan.md Phase 4.
 *
 * Device-to-device key sharing: a signed-in device with no key material asks another of
 * the account's devices for a copy. The server relays an opaque sealed box and holds no
 * keys, exactly like `api/pair.ts`.
 *
 * Every route requires `app.authenticate` AND scopes its query by `request.accountId`.
 * That is necessary but NOT sufficient on its own — an attacker holding a stolen access
 * token satisfies both. The actual anti-phishing control is the out-of-band verification
 * code both screens display (`web/src/lib/verification-code.ts`), backed here by the
 * server-attested requester facts `GET /v1/keys/requests` returns.
 */
import { decodeBase64, encodeBase64 } from "@kvy/crypto";
import { and, eq, gt, isNotNull, isNull, lt, ne } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { deviceSessions, keyRequests } from "../../db/schema.js";
import type { Database } from "../../db/types.js";
import { buildKeyRequestEphemeral, type EventRouterPort } from "../events/eventRouter.js";

const X25519_PUBLIC_KEY_BYTES = 32;

/** Shorter than pairing's 15 minutes: both devices are already signed in and present, so
 * there is no "walk to your other computer" window to accommodate. */
const KEY_REQUEST_TTL_MS = 5 * 60 * 1000;

const ErrorSchema = z.object({ error: z.string() });
const EphPubSchema = z.string().min(1);

function isValidEphPub(ephPub: string): boolean {
  return decodeBase64(ephPub).length === X25519_PUBLIC_KEY_BYTES;
}

export function buildKeyRequestRoutes(
  db: Database,
  eventRouter: EventRouterPort,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/keys/request",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        schema: {
          body: z.object({ ephPub: EphPubSchema, label: z.string().max(80).optional() }),
          // 400, not 401: this route already passed `authenticate`, so a 401 would read as
          // "your token is dead" to any client with a 401 interceptor and trigger a
          // spurious re-auth loop.
          response: { 200: z.object({ success: z.literal(true) }), 400: ErrorSchema },
        },
      },
      async (request, reply) => {
        const { ephPub, label } = request.body;
        if (!isValidEphPub(ephPub)) return reply.code(400).send({ error: "Invalid public key" });

        const now = new Date();
        // Opportunistic sweep — sealed master-secret boxes must not accumulate, and an
        // approved-but-never-claimed row would otherwise live forever.
        await db.delete(keyRequests).where(lt(keyRequests.expiresAt, now));

        // Upsert WITH a TTL refresh: `onConflictDoNothing` would leave an expired row
        // permanently un-renewable.
        await db
          .insert(keyRequests)
          .values({
            accountId: request.accountId,
            ephPub,
            requestedBySessionId: request.sessionId,
            label,
            expiresAt: new Date(now.getTime() + KEY_REQUEST_TTL_MS),
          })
          .onConflictDoUpdate({
            target: [keyRequests.accountId, keyRequests.ephPub],
            set: {
              requestedBySessionId: request.sessionId,
              label: label ?? null,
              response: null,
              approvedBySessionId: null,
              expiresAt: new Date(now.getTime() + KEY_REQUEST_TTL_MS),
            },
          });

        eventRouter.emitEphemeral({
          accountId: request.accountId,
          payload: buildKeyRequestEphemeral(ephPub, label ?? null),
          recipientFilter: { type: "all-user-authenticated-connections" },
        });

        return reply.send({ success: true });
      },
    );

    app.get(
      "/v1/keys/requests",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          response: {
            200: z.object({
              requests: z.array(
                z.object({
                  ephPub: z.string(),
                  label: z.string().nullable(),
                  createdAt: z.string(),
                  // Server-attested facts about the asking device, rendered ABOVE the
                  // untrusted `label` so the approver has something the requester cannot
                  // forge.
                  requesterClientKind: z.string().nullable(),
                  requesterCreatedAt: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
      async (request, reply) => {
        const rows = await db.query.keyRequests.findMany({
          where: and(
            eq(keyRequests.accountId, request.accountId),
            isNull(keyRequests.response),
            gt(keyRequests.expiresAt, new Date()),
          ),
        });
        const sessions = await db.query.deviceSessions.findMany({
          where: eq(deviceSessions.accountId, request.accountId),
        });
        const byId = new Map(sessions.map((session) => [session.id, session]));

        return reply.send({
          requests: rows.map((row) => {
            const requester = byId.get(row.requestedBySessionId);
            return {
              ephPub: row.ephPub,
              label: row.label,
              createdAt: row.createdAt.toISOString(),
              requesterClientKind: requester?.clientKind ?? null,
              requesterCreatedAt: requester?.createdAt.toISOString() ?? null,
            };
          }),
        });
      },
    );

    app.post(
      "/v1/keys/request/approve",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: {
          body: z.object({ ephPub: EphPubSchema, response: z.string().min(1) }),
          response: { 200: z.object({ success: z.literal(true) }), 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        // One atomic conditional UPDATE — first-approval-wins with no TOCTOU window, plus
        // the accountId/expiry scoping `api/pair.ts` cannot have, plus a self-approval
        // guard so a single compromised session can't both ask and answer.
        const updated = await db
          .update(keyRequests)
          .set({
            response: decodeBase64(request.body.response),
            approvedBySessionId: request.sessionId,
          })
          .where(
            and(
              eq(keyRequests.ephPub, request.body.ephPub),
              eq(keyRequests.accountId, request.accountId),
              isNull(keyRequests.response),
              gt(keyRequests.expiresAt, new Date()),
              ne(keyRequests.requestedBySessionId, request.sessionId),
            ),
          )
          .returning({ id: keyRequests.id });

        if (updated.length === 0) return reply.code(404).send({ error: "Request not found" });
        return reply.send({ success: true });
      },
    );

    app.post(
      "/v1/keys/request/claim",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          body: z.object({ ephPub: EphPubSchema }),
          response: {
            200: z.union([
              z.object({ state: z.literal("pending") }),
              z.object({ state: z.literal("expired") }),
              z.object({ state: z.literal("ready"), response: z.string() }),
            ]),
          },
        },
      },
      async (request, reply) => {
        const { ephPub } = request.body;

        // Single-use pickup, bound to the session that RAISED the request: only a row
        // that already has a response can match this delete, so a pending row is left
        // untouched for a later poll.
        const [picked] = await db
          .delete(keyRequests)
          .where(
            and(
              eq(keyRequests.ephPub, ephPub),
              eq(keyRequests.accountId, request.accountId),
              eq(keyRequests.requestedBySessionId, request.sessionId),
              isNotNull(keyRequests.response),
            ),
          )
          .returning();

        if (picked?.response) {
          if (picked.expiresAt.getTime() < Date.now()) return reply.send({ state: "expired" });
          return reply.send({ state: "ready", response: encodeBase64(picked.response) });
        }

        const row = await db.query.keyRequests.findFirst({
          where: and(
            eq(keyRequests.ephPub, ephPub),
            eq(keyRequests.accountId, request.accountId),
            eq(keyRequests.requestedBySessionId, request.sessionId),
          ),
        });
        if (!row || row.expiresAt.getTime() < Date.now()) return reply.send({ state: "expired" });
        return reply.send({ state: "pending" });
      },
    );
  };
}
