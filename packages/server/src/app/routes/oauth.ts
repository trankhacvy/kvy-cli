/**
 * Falcon-specific OAuth sign-up route — see https://github.com/slopus/happy
 * (MIT), the reference codebase for this monorepo. This route is not a port:
 * it has no equivalent in Happy's original single-key auth model
 * (falcon-plan.md §1.2 delta D5). It is the sibling of `auth.ts`'s
 * near-verbatim `POST /v1/auth` port; see the docblock on `buildOAuthRoutes`
 * below for the full delta rationale.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  defaultGithubCodeExchanger,
  defaultOAuthVerifier,
  type GithubCodeExchanger,
  type OAuthVerifier,
} from "../../auth/oauth.js";
import { issueSession } from "../../auth/refresh.js";
import { accounts, authIdentities } from "../../db/schema.js";
import type { Database } from "../../db/types.js";

const RegisterRequestSchema = z.object({
  // "dev" is the `FALCON_DEV_AUTH` local-testing bypass (auth/oauth.ts) — accepted
  // here unconditionally; `verifier.verify()` is what actually fails it closed when
  // the flag is off, same as an unconfigured google/github provider.
  oauthProvider: z.enum(["google", "github", "dev"]),
  // Google: an OpenID Connect ID token (JWT). GitHub: an OAuth access token. Verified
  // server-side by `auth/oauth.ts` — never trusted at face value.
  oauthProof: z.string().min(1),
});

const RegisterResponseSchema = z.object({
  success: z.literal(true),
  token: z.string(),
  // issue-4-plan.md §6.1/§6.4: OAuth is a real device session now, same as password —
  // a bare access token with no way to refresh it would go stale in 15m with no way
  // back, exactly the gap the password routes' `refreshToken` closes.
  refreshToken: z.string(),
});

const RegisterErrorSchema = z.object({
  error: z.string(),
});

/**
 * `POST /v1/auth/register` — OAuth sign-in/sign-up (issue-4-plan.md §5.5): identity and
 * key custody are split. OAuth is now a first-class login identity, resolved by
 * `(kind, subject)` in `auth_identities` (find-or-create, idempotent — signing in with
 * the same Google/GitHub account twice always resolves to the same account row) — it no
 * longer binds `signPubKey`/`contentPubKey` at all; that happens afterward via
 * `keys/challenge` + `keys/bind` (§6.2), once the client has generated or unwrapped its
 * `masterSecret`. The server:
 *
 *   1. verifies `oauthProof` against the named provider (`auth/oauth.ts`) — a forged
 *      or expired proof is rejected before touching the database;
 *   2. finds or creates the `auth_identities` row (and its `accounts` row, on first
 *      sign-in) for `(provider, subject)`;
 *   3. mints a real device session (`issueSession`) and returns its access token.
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
        const identity = await verifier.verify(request.body.oauthProvider, request.body.oauthProof);
        if (!identity) {
          return reply.code(401).send({ error: "Invalid OAuth proof" });
        }

        // issue-4-plan.md §5.5: OAuth is a first-class login identity now, resolved by
        // `(kind, subject)` in `auth_identities` — not a key-binding side channel on
        // `accounts` anymore. Key material (signPubKey/contentPubKey) is bound
        // separately via `keys/challenge` + `keys/bind` (§6.2), after login.
        const existing = await db.query.authIdentities.findFirst({
          where: and(
            eq(authIdentities.kind, identity.provider),
            eq(authIdentities.identifier, identity.subject),
          ),
        });

        const accountId = existing
          ? existing.accountId
          : await db.transaction(async (tx) => {
              const [account] = await tx.insert(accounts).values({}).returning({ id: accounts.id });
              if (!account) throw new Error("oauth register: account insert returned no row");
              await tx.insert(authIdentities).values({
                accountId: account.id,
                kind: identity.provider,
                identifier: identity.subject,
              });
              return account.id;
            });

        const { accessToken, refreshToken } = await issueSession(db, {
          accountId,
          clientKind: "web",
        });
        return reply.send({ success: true, token: accessToken, refreshToken });
      },
    );
  };
}
