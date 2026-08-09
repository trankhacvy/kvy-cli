import { decodeBase64, encodeBase64 } from "@kvy/crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { issueSession } from "../../auth/index.js";
import { db } from "../../db/client.js";
import { pairRequests } from "../../db/schema.js";

const X25519_PUBLIC_KEY_BYTES = 32;

// hard 15-minute TTL, enforced on every read below (POST /pair, GET /status, POST /approve)
// rather than via a background sweep — there's no cron here, `expiresAt` is just checked
// live against `Date.now()`.
const PAIR_REQUEST_TTL_MS = 15 * 60 * 1000;

const EphPubSchema = z.string().min(1);

function isValidEphPub(ephPub: string): boolean {
  return decodeBase64(ephPub).length === X25519_PUBLIC_KEY_BYTES;
}

function isExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() < Date.now();
}

const ErrorSchema = z.object({ error: z.string() });

/**
 * `/v1/auth/request*` three-endpoint dance, Prisma→Drizzle): a device without keys
 * (the CLI) generates an ephemeral X25519 keypair and asks an already-authenticated
 * device (the web app, which holds the master secret) to seal that secret — and, since
 * public key. The server only ever relays the opaque sealed box — it holds no keys and
 */
export const pairRoutes: FastifyPluginAsyncZod = async (app) => {
  // Upserts a PairRequest by ephemeral pubkey; once an approver has stored a sealed
  // `response`, the FIRST poller to observe it here consumes (deletes) the row —
  app.post(
    "/v1/auth/pair",
    {
      // Unauthenticated, polled repeatedly by a waiting CLI — allow enough headroom for
      // legitimate polling (a few requests/second) while still bounding abuse
      // "4.4 Hardening").
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        body: z.object({
          ephPub: EphPubSchema,
          // length-capped; never used for an authorization decision.
          label: z.string().max(80).optional(),
          cwd: z.string().max(200).optional(),
        }),
        response: {
          200: z.union([
            z.object({ state: z.literal("pending") }),
            z.object({ state: z.literal("expired") }),
            z.object({ state: z.literal("authorized"), response: z.string() }),
          ]),
          401: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { ephPub, label, cwd } = request.body;
      if (!isValidEphPub(ephPub)) {
        return reply.code(401).send({ error: "Invalid public key" });
      }

      // `db.terminalAuthRequest.upsert({ where: { publicKey }, update: {}, create: {...} })`:
      // the first POST for a given ephPub creates the pending row (with its TTL); every
      // later POST for the same ephPub (including this one, on the happy path) is a no-op
      // insert that just falls through to the pickup attempt below.
      await db
        .insert(pairRequests)
        .values({ ephPub, label, cwd, expiresAt: new Date(Date.now() + PAIR_REQUEST_TTL_MS) })
        .onConflictDoNothing({ target: pairRequests.ephPub });

      // Single-use pickup: only a row that already has a sealed `response` can match
      // this delete — a bare `pending` row is left untouched for a later poll. Deleting
      // (rather than just reading) here is what makes the sealed box single-use: a
      // second poll for the same `ephPub` after this finds no row and falls through to
      // the upsert above, starting a brand-new (still-unauthorized) pairing attempt
      // rather than ever re-serving the same secret.
      const [picked] = await db
        .delete(pairRequests)
        .where(and(eq(pairRequests.ephPub, ephPub), isNotNull(pairRequests.response)))
        .returning();

      if (picked?.response) {
        if (isExpired(picked.expiresAt)) {
          return reply.send({ state: "expired" });
        }
        return reply.send({ state: "authorized", response: encodeBase64(picked.response) });
      }

      const row = await db.query.pairRequests.findFirst({
        where: eq(pairRequests.ephPub, ephPub),
      });
      // Unreachable in practice — the insert above guarantees a row exists for this
      // ephPub whenever the delete above didn't just consume one — but keeps this
      // handler null-safe rather than asserting.
      if (!row) {
        return reply.code(401).send({ error: "Invalid public key" });
      }

      if (isExpired(row.expiresAt)) {
        return reply.send({ state: "expired" });
      }
      return reply.send({ state: "pending" });
    },
  );

  // Cheap polling variant of the above, without ever touching (or being able to
  app.get(
    "/v1/auth/pair/status",
    {
      // Cheap read-only poll, same headroom rationale as `POST /v1/auth/pair` above.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: z.object({ ephPub: EphPubSchema }),
        response: {
          200: z.object({
            status: z.enum(["not_found", "pending", "authorized", "expired"]),
            // whatever the requesting device sent. Deliberately NOT the account's email
            // or any other account fact: this route is unauthenticated, so anything it
            // returns is readable by whoever holds the pairing link.
            label: z.string().nullable().optional(),
            cwd: z.string().nullable().optional(),
            requestedAt: z.string().nullable().optional(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { ephPub } = request.query;
      if (!isValidEphPub(ephPub)) {
        return reply.send({ status: "not_found" });
      }

      const row = await db.query.pairRequests.findFirst({
        where: eq(pairRequests.ephPub, ephPub),
      });
      if (!row) return reply.send({ status: "not_found" });
      if (isExpired(row.expiresAt)) return reply.send({ status: "expired" });

      const details = {
        label: row.label,
        cwd: row.cwd,
        requestedAt: row.createdAt.toISOString(),
      };
      if (row.response) return reply.send({ status: "authorized", ...details });
      return reply.send({ status: "pending", ...details });
    },
  );

  // Mint the new device's session server-side and hand its refresh token straight back
  // point is that this value must reach the browser's crypto worker so it can be sealed
  // alongside the master secret BEFORE anything derived from it ever touches Postgres.
  // Deliberately not persisted anywhere here: the session itself already lives in
  // `device_sessions` (via `issueSession`, hashed) — if the approving browser never
  // follows up with `POST /pair/approve`, this is just an unused, otherwise-ordinary
  // device session that expires on its own like any other.
  app.post(
    "/v1/auth/pair/mint",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: z.object({ ephPub: EphPubSchema }),
        response: {
          200: z.object({ refreshToken: z.string() }),
          401: ErrorSchema,
          404: ErrorSchema,
          410: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { ephPub } = request.body;
      if (!isValidEphPub(ephPub)) {
        return reply.code(401).send({ error: "Invalid public key" });
      }

      const row = await db.query.pairRequests.findFirst({
        where: eq(pairRequests.ephPub, ephPub),
      });
      if (!row) return reply.code(404).send({ error: "Request not found" });
      if (isExpired(row.expiresAt)) return reply.code(410).send({ error: "Pair request expired" });

      const { refreshToken } = await issueSession(db, {
        accountId: request.accountId,
        clientKind: "cli-daemon",
        label: row.label ?? undefined,
      });
      return reply.send({ refreshToken });
    },
  );

  // Approve a pending pair request. Requires the approver to already be authenticated
  // `/v1/auth/response`.
  app.post(
    "/v1/auth/pair/approve",
    {
      preHandler: app.authenticate,
      // Authenticated write that stores the sealed session for the requesting device —
      // tighter than the poll routes above.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: z.object({ ephPub: EphPubSchema, response: z.string().min(1) }),
        response: {
          200: z.object({ success: z.literal(true) }),
          401: ErrorSchema,
          404: ErrorSchema,
          410: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { ephPub, response } = request.body;
      if (!isValidEphPub(ephPub)) {
        return reply.code(401).send({ error: "Invalid public key" });
      }

      const row = await db.query.pairRequests.findFirst({
        where: eq(pairRequests.ephPub, ephPub),
      });
      if (!row) {
        return reply.code(404).send({ error: "Request not found" });
      }
      if (isExpired(row.expiresAt)) {
        return reply.code(410).send({ error: "Pair request expired" });
      }

      // if not already set"). A naive read-then-write (`if (!authRequest.response)
      // { update(...) }`) is a TOCTOU race under two concurrent approvals. This is the
      // same intent expressed as a single atomic conditional UPDATE — the
      // `isNull(response)` guard is Drizzle's equivalent of `onConflictDoNothing` for a
      // row that (unlike an INSERT conflict) already exists: a second concurrent approve
      // matches zero rows and silently no-ops.
      await db
        .update(pairRequests)
        .set({ response: decodeBase64(response), state: "authorized" })
        .where(and(eq(pairRequests.ephPub, ephPub), isNull(pairRequests.response)));

      return reply.send({ success: true });
    },
  );
};
