import Fastify, { type FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { buildLoggerOptions } from "../logger.js";
import { healthRoutes } from "./api/health.js";

// App factory (kept separate from process startup in src/main.ts) so tests
// can build+inject() without opening a real port or a real pino transport.
export async function buildServer(opts: FastifyServerOptions = {}) {
  const app = Fastify({
    logger: buildLoggerOptions(),
    ...opts,
  }).withTypeProvider<ZodTypeProvider>();

  // Zod becomes the schema/validation/serialization language for every
  // typed route registered below (design §3: "Typed routes").
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(healthRoutes);

  return app;
}
