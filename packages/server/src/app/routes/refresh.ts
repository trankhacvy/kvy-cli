import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hashRefreshToken, mintAccessToken, newRefreshToken } from "../../auth/index.js";
import type { ClientKind } from "../../auth/tokens.js";
import { deviceSessions } from "../../db/schema.js";
import type { Database } from "../../db/types.js";

// Two tabs sharing one refresh token can rotate within this window without being flagged as theft.
const GRACE_MS = 60_000;

const RefreshRequestSchema = z.object({ refreshToken: z.string().min(1) });
const RefreshResponseSchema = z.object({ accessToken: z.string(), refreshToken: z.string() });
const RefreshErrorSchema = z.object({ error: z.string() });

export function buildRefreshRoutes(db: Database): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/auth/refresh",
      {
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          body: RefreshRequestSchema,
          response: { 200: RefreshResponseSchema, 401: RefreshErrorSchema },
        },
      },
      async (request, reply) => {
        const presented = hashRefreshToken(request.body.refreshToken);
        const now = new Date();

        // (1) Happy path: presented hash matches the CURRENT hash. The WHERE clause
        // is the "still valid" check — a revoked or expired session matches zero rows.
        const next = newRefreshToken();
        const rotated = await db
          .update(deviceSessions)
          .set({
            refreshTokenHash: hashRefreshToken(next),
            previousRefreshTokenHash: presented,
            previousRotatedAt: now,
            lastRefreshedAt: now,
          })
          .where(
            and(
              eq(deviceSessions.refreshTokenHash, presented),
              isNull(deviceSessions.revokedAt),
              gt(deviceSessions.expiresAt, now),
            ),
          )
          .returning();
        const current = rotated[0];
        if (current) {
          const accessToken = await mintAccessToken({
            accountId: current.accountId,
            sessionId: current.id,
            clientKind: current.clientKind as ClientKind,
          });
          return reply.send({ accessToken, refreshToken: next });
        }

        // (2) presented hash matches a PREVIOUS (already-rotated) hash.
        const prior = await db.query.deviceSessions.findFirst({
          where: eq(deviceSessions.previousRefreshTokenHash, presented),
        });
        if (
          prior?.previousRotatedAt &&
          now.getTime() - prior.previousRotatedAt.getTime() <= GRACE_MS &&
          !prior.revokedAt
        ) {
          // Benign race: hand back the CURRENT credential idempotently. Only the hash is
          // stored, so echo back the client's own token and it will keep whichever it holds.
          const accessToken = await mintAccessToken({
            accountId: prior.accountId,
            sessionId: prior.id,
            clientKind: prior.clientKind as ClientKind,
          });
          return reply.send({ accessToken, refreshToken: request.body.refreshToken });
        }
        if (prior) {
          // Replay outside the grace window implies theft — revoke the whole token family.
          await db
            .update(deviceSessions)
            .set({ revokedAt: now })
            .where(eq(deviceSessions.familyId, prior.familyId));
          return reply.code(401).send({ error: "Refresh token reuse detected" });
        }

        // (3) Unknown hash entirely (garbage, or >= 2 rotations old).
        return reply.code(401).send({ error: "Invalid refresh token" });
      },
    );
  };
}
