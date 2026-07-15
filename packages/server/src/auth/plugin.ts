import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { TokenCache } from "./token-cache.js";
import { verifyToken } from "./tokens.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Route preHandler (falcon-plan.md §16 "0.4 Server foundation"): rejects the
     * request with 401 unless `Authorization: Bearer <token>` carries a valid,
     * unexpired token; otherwise sets `request.accountId`. Usage on a route once the
     * DB layer lands: `{ preHandler: app.authenticate }`.
     */
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }

  interface FastifyRequest {
    /** Set by `app.authenticate`; only defined on routes that use it as a preHandler. */
    accountId: string;
  }
}

const BEARER_PREFIX = "Bearer ";

function extractBearerToken(header: string | undefined): string | null {
  if (!header?.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

// Registered on the Fastify skeleton (packages/server/src/app/server.ts) so every route
// plugin registered afterwards — session/message routes land once the Drizzle `accounts`
// table merges (see .worktrees/P0-0.4-drizzle-schema) — can depend on `app.authenticate`.
// Wrapped with fastify-plugin so the decorators below attach to the *root* instance:
// Fastify's default encapsulation would otherwise confine them to this plugin's own
// context, invisible to sibling route plugins.
export const authPlugin: FastifyPluginAsync = fp(
  async (app) => {
    // One cache per app instance (not a module-level singleton) so tests that build
    // multiple `buildServer()` instances don't leak cached tokens between them.
    const cache = new TokenCache();

    app.decorateRequest("accountId", "");

    app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
      const token = extractBearerToken(request.headers.authorization);
      if (!token) {
        await reply.code(401).send({ error: "Missing or malformed Authorization header" });
        return;
      }

      const cached = cache.get(token);
      if (cached) {
        request.accountId = cached.accountId;
        return;
      }

      const verified = await verifyToken(token);
      if (!verified) {
        await reply.code(401).send({ error: "Invalid or expired token" });
        return;
      }

      cache.set(token, verified);
      request.accountId = verified.accountId;
    });
  },
  { name: "auth-plugin" },
);
