/**
 * `POST /v1/auth/refresh` — issue-4-plan.md §4.3: rotating refresh tokens with a
 * previous-hash lineage that makes theft detectable, not just "session lives forever."
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hashRefreshToken, mintAccessToken, newRefreshToken } from "../../auth/index.js";
import type { ClientKind } from "../../auth/tokens.js";
import { deviceSessions } from "../../db/schema.js";
import type { Database } from "../../db/types.js";

// Two tabs sharing one refresh token both rotate within this window → tolerated as a
// benign race rather than flagged as theft (§4.3).
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

        // (1) Happy path: presented hash matches the CURRENT hash. Atomic conditional
        // rotate — the WHERE clause doubles as the "still valid" check, so a revoked or
        // expired session simply matches zero rows rather than needing a separate read.
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

        // (2) presented hash matches a PREVIOUS (already-rotated) hash. Either a benign
        // multi-tab race (within the grace window) or a stolen token being replayed
        // after the legitimate holder already rotated past it (outside the window).
        const prior = await db.query.deviceSessions.findFirst({
          where: eq(deviceSessions.previousRefreshTokenHash, presented),
        });
        if (
          prior &&
          prior.previousRotatedAt &&
          now.getTime() - prior.previousRotatedAt.getTime() <= GRACE_MS &&
          !prior.revokedAt
        ) {
          // Benign race: hand back the CURRENT credential idempotently. We cannot return
          // the raw current refresh token (only its hash is stored), so the client is
          // expected to keep whichever refresh token it already holds when the response
          // echoes it back unchanged (§4.3's client contract).
          const accessToken = await mintAccessToken({
            accountId: prior.accountId,
            sessionId: prior.id,
            clientKind: prior.clientKind as ClientKind,
          });
          return reply.send({ accessToken, refreshToken: request.body.refreshToken });
        }
        if (prior) {
          // Replay of a rotated token outside the grace window ⇒ theft ⇒ revoke the
          // whole family, not just this one row (§4.3, §9).
          await db
            .update(deviceSessions)
            .set({ revokedAt: now })
            .where(eq(deviceSessions.familyId, prior.familyId));
          return reply.code(401).send({ error: "Refresh token reuse detected" });
        }

        // (3) Unknown hash entirely (garbage, or ≥2 rotations old — see §4.3's note on
        // extending lineage depth if deeper replay detection is ever needed).
        return reply.code(401).send({ error: "Invalid refresh token" });
      },
    );
  };
}
