/**
 * Falcon-specific OAuth sign-up route — see https://github.com/slopus/happy
 * (MIT), the reference codebase for this monorepo. This route is not a port:
 * it has no equivalent in Happy's original single-key auth model
 * (falcon-plan.md §1.2 delta D5). It is the sibling of `auth.ts`'s
 * near-verbatim `POST /v1/auth` port; see the docblock on `buildOAuthRoutes`
 * below for the full delta rationale.
 */
import { decodeBase64 } from "@falcon/crypto";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import { z } from "zod";
import {
  defaultGithubCodeExchanger,
  defaultOAuthVerifier,
  type GithubCodeExchanger,
  type OAuthVerifier,
} from "../../auth/oauth.js";
import { mintToken } from "../../auth/tokens.js";
import { accounts } from "../../db/schema.js";
import { toHex } from "./hex.js";

// See auth.ts for why both generic slots are erased to `any`: this route only ever
// calls `db.insert(accounts)...`, whose typing comes from the `accounts` import, not
// from either driver's generic.
type Database = PgDatabase<any, any>;

const RegisterRequestSchema = z.object({
  oauthProvider: z.enum(["google", "github"]),
  // Google: an OpenID Connect ID token (JWT). GitHub: an OAuth access token. Verified
  // server-side by `auth/oauth.ts` — never trusted at face value.
  oauthProof: z.string().min(1),
  // Ed25519 identity key (base64) minted client-side from the browser-generated
  // masterSecret (design §5.2 "Sign-up"). Field name matches the design doc's
  // `POST /v1/auth/register` body shape exactly (`signPubKey`, not `publicKey` as in
  // the sibling `/v1/auth` challenge-response route — this is a separate endpoint with
  // its own documented contract).
  signPubKey: z.string().min(1),
  // X25519 content key (base64) — stored as `accounts.contentPubKey`, same as `/v1/auth`.
  contentPubKey: z.string().min(1),
});

const RegisterResponseSchema = z.object({
  success: z.literal(true),
  token: z.string(),
});

const RegisterErrorSchema = z.object({
  error: z.string(),
});

/**
 * `POST /v1/auth/register` — Falcon-specific sign-up route, not present in Happy
 * (falcon-plan.md §1.2 delta D5). Per design §5.2: the browser generates masterSecret
 * and derives keys entirely client-side; OAuth (Google/GitHub — email+password
 * deferred, falcon-plan.md §1.2) only binds an identity for account recovery/contact,
 * it is never the account's key material. The server:
 *
 *   1. verifies `oauthProof` against the named provider (`auth/oauth.ts`) — a forged
 *      or expired proof is rejected before touching the database;
 *   2. upserts the `accounts` row keyed by the hex-encoded `signPubKey` (idempotent,
 *      same shape as `/v1/auth`'s upsert), stamping `oauthProvider`/`oauthSubject`;
 *   3. mints and returns a JWT, exactly like `/v1/auth`.
 *
 * Re-registering the same `signPubKey` (e.g. the user re-runs sign-up, or switches
 * which OAuth account they bind) rebinds the recovery identity and refreshes
 * `contentPubKey` — the row is otherwise the same one `/v1/auth` logs into afterward.
 *
 * `db`/`verifier` are injected (mirrors `buildAuthRoutes`) so tests can bind an
 * in-memory Postgres and a fake OAuth verifier without touching `DATABASE_URL` or the
 * network.
 */
export function buildOAuthRoutes(
  db: Database,
  verifier: OAuthVerifier = defaultOAuthVerifier,
  githubExchanger: GithubCodeExchanger = defaultGithubCodeExchanger,
): FastifyPluginAsyncZod {
  return async (app) => {
    // `POST /v1/auth/oauth/github/exchange` — not present in Happy, and not part of
    // the design doc's auth-flow diagram either: it exists purely as a plumbing detail
    // of the web app being a static export with no server-held secret of its own.
    // GitHub's authorization-code flow (unlike Google's OIDC implicit flow, which
    // yields a usable ID token straight from a browser redirect) requires the app's
    // client secret to exchange `code` for an access token, and GitHub's token
    // endpoint has no CORS allowance for a direct browser fetch — so the browser
    // hands the `code` here, and this server (which already holds `FALCON_MASTER_SECRET`
    // and other real secrets) makes that one call on its behalf. The resulting access
    // token is returned to the browser exactly as if it had obtained one itself, and is
    // used the same way afterward: as `oauthProof` to `/v1/auth/register` (unaltered).
    app.post(
      "/v1/auth/oauth/github/exchange",
      {
        // Unauthenticated (no account yet), and it holds this server's own client
        // secret behind it — keep it tight (falcon-system-design.md §12, plan.md §16
        // "4.4 Hardening").
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        schema: {
          body: z.object({ code: z.string().min(1), redirectUri: z.string().min(1) }),
          response: {
            200: z.object({ accessToken: z.string() }),
            401: RegisterErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const accessToken = await githubExchanger.exchange(
          request.body.code,
          request.body.redirectUri,
        );
        if (!accessToken) {
          return reply.code(401).send({ error: "GitHub code exchange failed" });
        }
        return reply.send({ accessToken });
      },
    );

    app.post(
      "/v1/auth/register",
      {
        // Unauthenticated route (no account yet) — same rationale as `auth.ts`'s
        // `POST /v1/auth` (falcon-system-design.md §12, plan.md §16 "4.4 Hardening").
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: {
          body: RegisterRequestSchema,
          response: {
            200: RegisterResponseSchema,
            400: RegisterErrorSchema,
            401: RegisterErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const signPublicKey = decodeBase64(request.body.signPubKey);
        if (signPublicKey.length !== tweetnacl.sign.publicKeyLength) {
          return reply.code(400).send({ error: "Malformed signPubKey" });
        }

        const identity = await verifier.verify(request.body.oauthProvider, request.body.oauthProof);
        if (!identity) {
          return reply.code(401).send({ error: "Invalid OAuth proof" });
        }

        const signPublicKeyHex = toHex(signPublicKey);
        const contentPubKey = request.body.contentPubKey;

        const [account] = await db
          .insert(accounts)
          .values({
            signPublicKey: signPublicKeyHex,
            contentPubKey,
            oauthProvider: identity.provider,
            oauthSubject: identity.subject,
          })
          .onConflictDoUpdate({
            target: accounts.signPublicKey,
            set: {
              contentPubKey,
              oauthProvider: identity.provider,
              oauthSubject: identity.subject,
            },
          })
          .returning();

        if (!account) {
          // Unreachable in practice — see auth.ts's identical guard.
          throw new Error("oauth register: upsert returned no account row");
        }

        const token = await mintToken(account.id);
        return reply.send({ success: true, token });
      },
    );
  };
}
