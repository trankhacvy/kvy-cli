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
  oauthProvider: z.enum(["google", "github"]),
  oauthProof: z.string().min(1),
});

const RegisterResponseSchema = z.object({
  success: z.literal(true),
  token: z.string(),
  refreshToken: z.string(),
});

const RegisterErrorSchema = z.object({
  error: z.string(),
});

export function buildOAuthRoutes(
  db: Database,
  verifier: OAuthVerifier = defaultOAuthVerifier,
  githubExchanger: GithubCodeExchanger = defaultGithubCodeExchanger,
): FastifyPluginAsyncZod {
  return async (app) => {
    // GitHub's token endpoint has no CORS allowance for browser fetches, so the browser
    // hands the authorization `code` here and this server exchanges it on its behalf.
    app.post(
      "/v1/auth/oauth/github/exchange",
      {
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
                email: identity.email,
                emailVerified: identity.emailVerified,
              });
              return account.id;
            });

        // Backfill email on sign-in if the identity was created before email capture existed.
        // Never overwrites an existing email — deliberately conservative.
        if (existing && !existing.email && identity.email) {
          await db
            .update(authIdentities)
            .set({ email: identity.email, emailVerified: identity.emailVerified })
            .where(eq(authIdentities.id, existing.id));
        }

        const { accessToken, refreshToken } = await issueSession(db, {
          accountId,
          clientKind: "web",
        });
        return reply.send({ success: true, token: accessToken, refreshToken });
      },
    );
  };
}
