import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { TokenCache } from "./token-cache.js";
import type { ClientKind } from "./tokens.js";
import { verifyToken } from "./tokens.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Route preHandler (falcon-plan.md §16 "0.4 Server foundation"): rejects the
     * request with 401 unless `Authorization: Bearer <token>` carries a valid,
     * unexpired token; otherwise sets `request.accountId`/`request.sessionId`/
     * `request.clientKind`. Usage: `{ preHandler: app.authenticate }`.
     */
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }

  interface FastifyRequest {
    /** Set by `app.authenticate`; only defined on routes that use it as a preHandler. */
    accountId: string;
    /** The `device_sessions.id` (JWT `sid` claim) the request's access token was minted for. */
    sessionId: string;
    /** The `device_sessions.clientKind` (JWT `ct` claim) the request's access token was minted for. */
    clientKind: ClientKind;
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
    app.decorateRequest("sessionId", "");
    app.decorateRequest("clientKind", "web");

    /**
     * Best-effort, NON-enforcing identification, so anything running later in the request
     * lifecycle can key on the account.
     *
     * This exists because global `preHandler` hooks run before route-level ones: the
     * rate limiter's `keyGenerator` (`app/server.ts`) is a global hook, while
     * `app.authenticate` is a route-level `preHandler`, so `request.accountId` was still
     * `""` at keying time and every "per-account" limit silently degraded to per-IP.
     * That let an attacker on a different IP get their own budget against a victim.
     *
     * Deliberately never rejects — enforcement stays entirely with `app.authenticate`, so
     * an unauthenticated or malformed request just falls through with `accountId` unset
     * and gets IP-keyed as before. Registered before the rate-limit plugin so it runs
     * first; the `TokenCache` keeps the extra verification to one per token.
     */
    app.addHook("preHandler", async (request) => {
      const token = extractBearerToken(request.headers.authorization);
      if (!token) return;
      const cached = cache.get(token);
      if (cached) {
        request.accountId = cached.accountId;
        request.sessionId = cached.sessionId;
        request.clientKind = cached.clientKind;
        return;
      }
      const verified = await verifyToken(token);
      if (!verified) return;
      cache.set(token, verified);
      request.accountId = verified.accountId;
      request.sessionId = verified.sessionId;
      request.clientKind = verified.clientKind;
    });

    app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
      const token = extractBearerToken(request.headers.authorization);
      if (!token) {
        await reply.code(401).send({ error: "Missing or malformed Authorization header" });
        return;
      }

      const cached = cache.get(token);
      if (cached) {
        request.accountId = cached.accountId;
        request.sessionId = cached.sessionId;
        request.clientKind = cached.clientKind;
        return;
      }

      const verified = await verifyToken(token);
      if (!verified) {
        await reply.code(401).send({ error: "Invalid or expired token" });
        return;
      }

      cache.set(token, verified);
      request.accountId = verified.accountId;
      request.sessionId = verified.sessionId;
      request.clientKind = verified.clientKind;
    });
  },
  { name: "auth-plugin" },
);
