/**
 * Ported (near-verbatim) from Happy — https://github.com/slopus/happy (MIT)
 * Original: happy/packages/happy-server/sources/app/api/routes/authRoutes.ts
 * (`POST /v1/auth`). See the docblock on `buildAuthRoutes` below for what
 * changed and why.
 */
import { decodeBase64 } from "@falcon/crypto";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import { z } from "zod";
import { mintToken } from "../../auth/index.js";
import { accounts } from "../../db/schema.js";
import { toHex } from "./hex.js";

// Both generic slots are erased to `any` on purpose: they're the two places
// `PostgresJsDatabase` (production, db/client.ts) and `PgliteDatabase` (tests, see
// auth.test.ts) structurally diverge (query-result HKT and relational-schema shape),
// and this route only ever calls `db.insert(accounts)...` — whose typing comes from
// the `accounts` table import directly, not from either generic — so nothing is lost
// by accepting either driver here.
type Database = PgDatabase<any, any>;

const AuthRequestSchema = z.object({
  // Ed25519 identity key (base64) — the account's `signPublicKey`, hex-encoded below
  // to match the `accounts` table convention (design §6.1).
  publicKey: z.string().min(1),
  // X25519 content key (base64), stored as `accounts.contentPubKey`. Not part of
  // Happy's original single-key model — Falcon's schema (`P0-0.4-drizzle-schema`)
  // requires it NOT NULL at row-creation time, so it travels alongside the sign key
  // on every request; re-sending it on subsequent logins keeps the row's key material
  // fresh if a device rotates its content key without changing identity.
  contentPublicKey: z.string().min(1),
  // Random 32 bytes (base64) minted client-side by `@falcon/crypto`'s `authChallenge`.
  challenge: z.string().min(1),
  // Ed25519 detached signature (base64) over `challenge`, produced by the same call.
  signature: z.string().min(1),
});

const AuthResponseSchema = z.object({
  success: z.literal(true),
  token: z.string(),
});

const AuthErrorSchema = z.object({
  error: z.string(),
});

/**
 * Ported (near-verbatim) from Happy's `POST /v1/auth` —
 * happy/packages/happy-server/sources/app/api/routes/authRoutes.ts.
 *
 * The client generates its own Ed25519 challenge locally (`@falcon/crypto`'s
 * `authChallenge`, given the identity key derived from its masterSecret) and signs it
 * before ever talking to the server — there is no server-issued nonce or extra round
 * trip; the server only ever verifies a self-contained proof of key possession
 * (design §5.2 "Sign-in"). A valid signature upserts the `accounts` row keyed by the
 * hex-encoded sign public key (idempotent: the same key always maps to the same
 * account row) and returns a fresh JWT (`mintToken`, `@falcon/server`'s auth module).
 *
 * `db` is injected (rather than importing the module singleton) so tests can bind an
 * in-memory Postgres (see auth.test.ts) without touching `DATABASE_URL`.
 */
export function buildAuthRoutes(db: Database): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/auth",
      {
        // Unauthenticated route (no account yet) — keyed by IP via the global default
        // (server.ts's `keyGenerator: (req) => req.accountId || req.ip`), tighter than
        // the app-wide 300/min so a single client can't hammer signature verification
        // (falcon-system-design.md §12: "Rate limits: auth endpoints", plan.md §16
        // "4.4 Hardening": one of the reported Happy vuln classes).
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: {
          body: AuthRequestSchema,
          response: {
            200: AuthResponseSchema,
            401: AuthErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const publicKey = decodeBase64(request.body.publicKey);
        const challenge = decodeBase64(request.body.challenge);
        const signature = decodeBase64(request.body.signature);

        let isValid: boolean;
        try {
          isValid = tweetnacl.sign.detached.verify(challenge, signature, publicKey);
        } catch {
          // tweetnacl throws on a malformed key/signature length rather than
          // returning false; either way it means "not a valid signature".
          isValid = false;
        }
        if (!isValid) {
          return reply.code(401).send({ error: "Invalid signature" });
        }

        const signPublicKey = toHex(publicKey);
        const contentPubKey = request.body.contentPublicKey;

        const [account] = await db
          .insert(accounts)
          .values({ signPublicKey, contentPubKey })
          .onConflictDoUpdate({
            target: accounts.signPublicKey,
            set: { contentPubKey },
          })
          .returning();

        if (!account) {
          // Unreachable in practice — an upsert's `.returning()` always yields the
          // affected row — guarded anyway per the "no silent failures" principle.
          throw new Error("auth: upsert returned no account row");
        }

        const token = await mintToken(account.id);
        return reply.send({ success: true, token });
      },
    );
  };
}
