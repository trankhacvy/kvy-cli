/**
 * Ported (near-verbatim) from Happy — https://github.com/slopus/happy (MIT)
 * Original: happy/packages/happy-server/sources/app/api/routes/authRoutes.ts
 * (`POST /v1/auth`). See the docblock on `buildAuthRoutes` below for what
 * changed and why.
 */
import { decodeBase64 } from "@falcon/crypto";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import { z } from "zod";
import { issueSession } from "../../auth/index.js";
import { accounts } from "../../db/schema.js";
import type { Database } from "../../db/types.js";
import { toHex } from "./hex.js";

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
  // Whether this signature upserted a brand-new `accounts` row ("created") or
  // found an already-existing one ("found") — see the module docblock's
  // ACCOUNT STATUS note. Additive-only: every existing caller that only reads
  // `success`/`token` (the normal sign-in path) is unaffected by this field's
  // presence; it does not change the 200 status or any other response shape.
  accountStatus: z.enum(["found", "created"]),
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
 * ACCOUNT STATUS (docs/bug-fix-plan.md issue #12, known-issues.md "Recovery code can
 * silently create a disconnected account instead of failing"): this upsert used to
 * report the same `{ success: true, token }` shape whether it found an existing
 * `accounts` row or just created a brand-new one — which meant a client attempting to
 * *restore* an identity from a recovery code (rather than sign in normally) had no way
 * to tell "your code matched a real account" apart from "your code didn't match
 * anything, so here's a fresh, empty, disconnected one." The response now also
 * reports `accountStatus: "found" | "created"`, derived from Postgres's `xmax` system
 * column on the `RETURNING` row: `xmax = 0` iff the row now visible was inserted by
 * *this* command rather than updated (an `ON CONFLICT DO UPDATE` sets `xmax` to the
 * current transaction's id) — the standard "was this an insert or an update" check for
 * a single upsert statement, no separate pre-check `SELECT` needed. This is purely
 * additive: the normal returning-device sign-in path still gets `success: true` and a
 * valid token regardless of `accountStatus`, unchanged from before — only the
 * recovery-restore flow (packages/web) inspects this field to decide whether to roll
 * back and show a "no account found for that recovery code" error.
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
          .returning({
            id: accounts.id,
            // See the module docblock's ACCOUNT STATUS note: `xmax = 0` iff this
            // command inserted the row rather than updating an existing one.
            created: sql<boolean>`(xmax = 0)`,
          });

        if (!account) {
          // Unreachable in practice — an upsert's `.returning()` always yields the
          // affected row — guarded anyway per the "no silent failures" principle.
          throw new Error("auth: upsert returned no account row");
        }

        // issue-4-plan.md §4.1/§4.2: every login mints a real device_sessions row (not a
        // bare stateless token) — this legacy route is slated for deletion once the web
        // migrates off it (§5.5, Phase 4), but until then it must keep minting sessions
        // the same way the new password/OAuth routes do so `verifyToken`'s stricter
        // sid/ct check (§4.1) doesn't reject its tokens.
        const { accessToken } = await issueSession(db, {
          accountId: account.id,
          clientKind: "web",
        });
        return reply.send({
          success: true,
          token: accessToken,
          accountStatus: account.created ? "created" : "found",
        });
      },
    );
  };
}
