import Fastify, { type FastifyServerOptions } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { authPlugin } from "../auth/index.js";
import { db as defaultDb } from "../db/client.js";
import { buildLoggerOptions } from "../logger.js";
import { healthRoutes } from "./api/health.js";
import { buildAuthRoutes } from "./routes/auth.js";

// App factory (kept separate from process startup in src/main.ts) so tests
// can build+inject() without opening a real port or a real pino transport.
// `db` defaults to the module-level singleton (db/client.ts) but can be overridden —
// auth.test.ts binds an in-memory Postgres instead of touching `DATABASE_URL`.
export async function buildServer(
  opts: FastifyServerOptions = {},
  deps: { db?: Parameters<typeof buildAuthRoutes>[0] } = {},
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

  return app;
}
