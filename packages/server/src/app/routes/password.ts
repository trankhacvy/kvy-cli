import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { EmailTransport } from "../../auth/email.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { issueSession } from "../../auth/refresh.js";
import { env } from "../../config.js";
import { accounts, authIdentities, deviceSessions, passwordResetTokens } from "../../db/schema.js";
import type { Database } from "../../db/types.js";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h — long enough to fetch an email, short enough to bound abuse

// Per-identity lockout — the route-level IP rate limit is bypassable by rotating IPs.
// This counter is keyed on the identity row itself, so it holds regardless of source IP.
// No lock below `LOCKOUT_THRESHOLD`; past it an exponentially growing backoff, capped.
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_MS = 30_000; // 30s lock on the failure that first crosses the threshold
const LOCKOUT_MAX_MS = 15 * 60_000; // capped at 15 minutes regardless of how long the attack continues

/** `failedLoginCount` is the count AFTER this failure has been recorded — e.g. 5 means
 * "this was the 5th consecutive failure." Returns `null` (no new lock) below the
 * threshold. */
function computeLockedUntil(failedLoginCount: number, now: Date): Date | null {
  if (failedLoginCount < LOCKOUT_THRESHOLD) return null;
  const durationMs = Math.min(
    LOCKOUT_MAX_MS,
    LOCKOUT_BASE_MS * 2 ** (failedLoginCount - LOCKOUT_THRESHOLD),
  );
  return new Date(now.getTime() + durationMs);
}

const ErrorSchema = z.object({ error: z.string() });
const SessionResponseSchema = z.object({
  success: z.literal(true),
  token: z.string(),
  refreshToken: z.string(),
});
const OkResponseSchema = z.object({ success: z.literal(true) });

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Returns 404 in production to avoid advertising this endpoint. Wired as `preValidation`,
// not as the handler's first line: Fastify runs body-schema validation between preParsing
// and preHandler, so a handler-level check would let a malformed request answer 400 first
// — confirming the route exists and leaking its expected shape. `preValidation` fires
// before schema validation, so every request gets the same 404 in production.
async function requireNonProduction(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (env.NODE_ENV === "production") {
    await reply.code(404).send({ error: "Not found" });
  }
}

export function buildPasswordRoutes(db: Database, email: EmailTransport): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/auth/password/register",
      {
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        preValidation: requireNonProduction,
        schema: {
          body: z.object({ email: z.string().email(), password: z.string().min(8) }),
          response: { 200: SessionResponseSchema, 400: ErrorSchema, 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        const identifier = normalizeEmail(request.body.email);

        const existing = await db.query.authIdentities.findFirst({
          where: and(
            eq(authIdentities.kind, "password"),
            eq(authIdentities.identifier, identifier),
          ),
        });
        if (existing) {
          // No-enumeration: return the same generic success shape rather than a 409.
          await email.sendResetEmail({
            to: identifier,
            resetUrl: "(account already exists — use 'forgot password' to sign back in)",
          });
          return reply.send({ success: true, token: "", refreshToken: "" });
        }

        const passwordHash = await hashPassword(request.body.password);
        const accountId = await db.transaction(async (tx) => {
          const [account] = await tx.insert(accounts).values({}).returning({ id: accounts.id });
          if (!account) throw new Error("password register: account insert returned no row");
          await tx.insert(authIdentities).values({
            accountId: account.id,
            kind: "password",
            identifier,
            passwordHash,
            email: identifier,
            emailVerified: false,
          });
          return account.id;
        });

        await email.sendVerificationEmail({
          to: identifier,
          verifyUrl: `(verification is not yet a real flow — account ${accountId} registered)`,
        });

        const { accessToken, refreshToken } = await issueSession(db, {
          accountId,
          clientKind: "web",
        });
        return reply.send({ success: true, token: accessToken, refreshToken });
      },
    );

    app.post(
      "/v1/auth/password/login",
      {
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        preValidation: requireNonProduction,
        schema: {
          body: z.object({ email: z.string().email(), password: z.string().min(1) }),
          response: { 200: SessionResponseSchema, 401: ErrorSchema, 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        const identifier = normalizeEmail(request.body.email);
        // Identical rejection for "no account", "wrong password", and "locked out"
        // to avoid being an oracle for enumeration or lock-state probing.
        const genericError = () => reply.code(401).send({ error: "Invalid email or password" });

        const identity = await db.query.authIdentities.findFirst({
          where: and(
            eq(authIdentities.kind, "password"),
            eq(authIdentities.identifier, identifier),
          ),
        });
        if (!identity?.passwordHash) return genericError();

        const now = new Date();
        if (identity.lockedUntil && identity.lockedUntil > now) {
          return genericError();
        }

        const valid = await verifyPassword(identity.passwordHash, request.body.password);
        if (!valid) {
          const [updated] = await db
            .update(authIdentities)
            .set({ failedLoginCount: sql`${authIdentities.failedLoginCount} + 1` })
            .where(eq(authIdentities.id, identity.id))
            .returning({ failedLoginCount: authIdentities.failedLoginCount });
          const failedLoginCount = updated?.failedLoginCount ?? identity.failedLoginCount + 1;
          const lockedUntil = computeLockedUntil(failedLoginCount, now);
          if (lockedUntil) {
            await db
              .update(authIdentities)
              .set({ lockedUntil })
              .where(eq(authIdentities.id, identity.id));
          }
          return genericError();
        }

        // Clear accumulated failures on a correct password.
        if (identity.failedLoginCount > 0 || identity.lockedUntil) {
          await db
            .update(authIdentities)
            .set({ failedLoginCount: 0, lockedUntil: null })
            .where(eq(authIdentities.id, identity.id));
        }

        const { accessToken, refreshToken } = await issueSession(db, {
          accountId: identity.accountId,
          clientKind: "web",
        });
        return reply.send({ success: true, token: accessToken, refreshToken });
      },
    );

    app.post(
      "/v1/auth/password/reset/request",
      {
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        preValidation: requireNonProduction,
        schema: {
          body: z.object({ email: z.string().email() }),
          response: { 200: OkResponseSchema, 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        const identifier = normalizeEmail(request.body.email);
        const identity = await db.query.authIdentities.findFirst({
          where: and(
            eq(authIdentities.kind, "password"),
            eq(authIdentities.identifier, identifier),
          ),
        });

        // Always 200 regardless of whether the identity exists — no enumeration.
        if (identity) {
          const token = randomBytes(32).toString("base64url");
          await db.insert(passwordResetTokens).values({
            authIdentityId: identity.id,
            token,
            expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
          });
          await email.sendResetEmail({
            to: identifier,
            resetUrl: `(dev transport) reset token: ${token}`,
          });
        }

        return reply.send({ success: true });
      },
    );

    app.post(
      "/v1/auth/password/reset/confirm",
      {
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        preValidation: requireNonProduction,
        schema: {
          body: z.object({ token: z.string().min(1), password: z.string().min(8) }),
          response: { 200: OkResponseSchema, 401: ErrorSchema, 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        const now = new Date();
        const resetRow = await db.query.passwordResetTokens.findFirst({
          where: and(
            eq(passwordResetTokens.token, request.body.token),
            isNull(passwordResetTokens.consumedAt),
            gt(passwordResetTokens.expiresAt, now),
          ),
        });
        if (!resetRow) return reply.code(401).send({ error: "Invalid or expired reset token" });

        const identity = await db.query.authIdentities.findFirst({
          where: eq(authIdentities.id, resetRow.authIdentityId),
        });
        if (!identity) return reply.code(401).send({ error: "Invalid or expired reset token" });

        const passwordHash = await hashPassword(request.body.password);
        await db.transaction(async (tx) => {
          await tx
            .update(passwordResetTokens)
            .set({ consumedAt: now })
            .where(eq(passwordResetTokens.id, resetRow.id));
          await tx
            .update(authIdentities)
            .set({ passwordHash })
            .where(eq(authIdentities.id, identity.id));
          // A reset revokes every device session — losing the password is treated as
          // a possible credential compromise.
          await tx
            .update(deviceSessions)
            .set({ revokedAt: now })
            .where(eq(deviceSessions.accountId, identity.accountId));
        });

        return reply.send({ success: true });
      },
    );
  };
}
