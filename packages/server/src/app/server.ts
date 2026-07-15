import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { authPlugin } from "../auth/index.js";
import { db as defaultDb } from "../db/client.js";
import type { Database } from "../db/types.js";
import { buildLoggerOptions } from "../logger.js";
import { healthRoutes } from "./api/health.js";
import { eventRouter as defaultEventRouter, type EventRouter } from "./eventRouter.js";
import { buildMachinesRoutes } from "./routes/machines.js";
import { buildMessagesRoutes } from "./routes/messages.js";
import { buildSessionCasRoutes } from "./routes/sessionCas.js";
import { buildSessionsRoutes } from "./routes/sessions.js";
import { buildSyncRoutes } from "./routes/sync.js";

// Default request-size cap (design §4.3: "request-size caps"). The message
// ingest route overrides this per-route to fit one coalesced outbox flush —
// see messages.ts's MESSAGE_BODY_LIMIT_BYTES. Every other route is
// structural/control-plane JSON, for which Fastify's own 1 MiB default is
// already generous; set explicitly here so it's a documented decision, not
// an implicit default.
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

// App factory (kept separate from process startup in src/main.ts) so tests
// can build+inject() without opening a real port or a real pino transport.
// `db`/`eventRouter` default to the module-level singletons but can be
// overridden — route tests bind an in-memory Postgres and/or a
// test-local EventRouter instead of touching `DATABASE_URL` or asserting on
// a shared process-wide event stream.
export async function buildServer(
  opts: FastifyServerOptions = {},
  deps: { db?: Database; eventRouter?: EventRouter } = {},
) {
  const db = deps.db ?? defaultDb;
  const eventRouter = deps.eventRouter ?? defaultEventRouter;

  const app = Fastify({
    logger: buildLoggerOptions(),
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    ...opts,
  }).withTypeProvider<ZodTypeProvider>();

  // Zod becomes the schema/validation/serialization language for every
  // typed route registered below (design §3: "Typed routes").
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Global default; individual routes narrow it further via `config.rateLimit`
  // (design §4.3: "rate limits on auth + ingest routes"). Keyed by the
  // authenticated account when available (set by `app.authenticate` below)
  // so one account can't starve another sharing an IP/NAT; falls back to IP
  // for routes that run before/without authentication (health checks, and
  // the auth routes themselves once task 0.4's remaining routes land).
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.accountId || req.ip,
  });

  // Decorates `app.authenticate` (design §16 "0.4 Server foundation") so routes
  // registered below or in later phases can require a valid bearer JWT via
  // `{ preHandler: app.authenticate }`.
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(buildSessionsRoutes(db, eventRouter));
  await app.register(buildMessagesRoutes(db, eventRouter));
  await app.register(buildSessionCasRoutes(db, eventRouter));
  await app.register(buildSyncRoutes(db));
  await app.register(buildMachinesRoutes(db, eventRouter));

  return app;
}
