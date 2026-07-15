import Fastify, { type FastifyServerOptions } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  authPlugin,
  defaultGithubCodeExchanger,
  defaultOAuthVerifier,
  type GithubCodeExchanger,
  type OAuthVerifier,
} from "../auth/index.js";
import { db as defaultDb } from "../db/client.js";
import { buildLoggerOptions } from "../logger.js";
import { healthRoutes } from "./api/health.js";
import { pairRoutes } from "./api/pair.js";
import { buildAuthRoutes } from "./routes/auth.js";
import { buildOAuthRoutes } from "./routes/oauth.js";

// App factory (kept separate from process startup in src/main.ts) so tests
// can build+inject() without opening a real port or a real pino transport.
// `db` defaults to the module-level singleton (db/client.ts) but can be overridden —
// auth.test.ts binds an in-memory Postgres instead of touching `DATABASE_URL`.
// `oauthVerifier`/`githubExchanger` similarly default to the real implementations but
// can be overridden — oauth.test.ts injects fakes instead of touching the network.
export async function buildServer(
  opts: FastifyServerOptions = {},
  deps: {
    db?: Parameters<typeof buildAuthRoutes>[0];
    oauthVerifier?: OAuthVerifier;
    githubExchanger?: GithubCodeExchanger;
  } = {},
) {
  const app = Fastify({
    logger: buildLoggerOptions(),
    ...opts,
  }).withTypeProvider<ZodTypeProvider>();

  // Zod becomes the schema/validation/serialization language for every
  // typed route registered below (design §3: "Typed routes").
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Decorates `app.authenticate` (design §16 "0.4 Server foundation") so routes
  // registered below or in later phases can require a valid bearer JWT via
  // `{ preHandler: app.authenticate }`.
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(buildAuthRoutes(deps.db ?? defaultDb));
  await app.register(
    buildOAuthRoutes(
      deps.db ?? defaultDb,
      deps.oauthVerifier ?? defaultOAuthVerifier,
      deps.githubExchanger ?? defaultGithubCodeExchanger,
    ),
  );
  await app.register(pairRoutes);

  return app;
}
