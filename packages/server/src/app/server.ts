import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  authPlugin,
  createDevLoggerEmailTransport,
  defaultGithubCodeExchanger,
  defaultGoogleCodeExchanger,
  defaultOAuthVerifier,
  type EmailTransport,
  type GithubCodeExchanger,
  type GoogleCodeExchanger,
  type OAuthVerifier,
} from "../auth/index.js";
import {
  type BlobStorageDriver,
  buildBlobStorage,
  resolveLocalDriverConfig,
} from "../blobStorage/index.js";
import type { LocalDriverConfig } from "../blobStorage/localDriver.js";
import { env } from "../config.js";
import { db as defaultDb } from "../db/client.js";
import type { Database } from "../db/types.js";
import { buildLoggerOptions } from "../logger.js";
import { healthRoutes } from "./api/health.js";
import { pairRoutes } from "./api/pair.js";
import {
  eventRouter as defaultEventRouter,
  disconnectSession,
  type EventRouterPort,
} from "./events/eventRouter.js";
import { buildPushDispatcher } from "./push/dispatch.js";
import type { PushDispatcherPort } from "./push/types.js";
import { buildBlobsRoutes } from "./routes/blobs.js";
import { buildKeyRequestRoutes } from "./routes/keyRequests.js";
import { buildKeysRoutes } from "./routes/keys.js";
import { buildMachinesRoutes } from "./routes/machines.js";
import { buildMessagesRoutes } from "./routes/messages.js";
import { metricsRoutes, recordHttpRequest } from "./routes/metrics.js";
import { buildNotificationSettingsRoutes } from "./routes/notificationSettings.js";
import { buildOAuthRoutes } from "./routes/oauth.js";
import { buildPasswordRoutes } from "./routes/password.js";
import { buildPushRoutes } from "./routes/push.js";
import { buildRefreshRoutes } from "./routes/refresh.js";
import { buildSessionArchiveRoutes } from "./routes/sessionArchive.js";
import { buildSessionCasRoutes } from "./routes/sessionCas.js";
import { buildSessionNotifyRoutes } from "./routes/sessionNotify.js";
import { buildSessionStatusRoutes } from "./routes/sessionStatus.js";
import { buildSessionsRoutes } from "./routes/sessions.js";
import { buildSessionsAdminRoutes } from "./routes/sessionsAdmin.js";
import { buildSyncRoutes } from "./routes/sync.js";
import { buildTelegramLinkRoutes } from "./routes/telegramLink.js";
import { buildUnmanagedSessionsRoutes } from "./routes/unmanagedSessions.js";
import { buildWorkspacesRoutes } from "./routes/workspaces.js";
import { buildCorsOriginValidator } from "./security/cors.js";
import { startSocket } from "./socket.js";

// The message ingest route overrides this per-route; every other route is
// structural JSON for which 1 MiB is already generous.
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

// Kept separate from process startup so tests can build+inject() without opening
// a real port. All deps default to real implementations but accept injected fakes
// for test isolation.
export async function buildServer(
  opts: FastifyServerOptions = {},
  deps: {
    db?: Database;
    oauthVerifier?: OAuthVerifier;
    githubExchanger?: GithubCodeExchanger;
    googleExchanger?: GoogleCodeExchanger;
    eventRouter?: EventRouterPort;
    pushDispatcher?: PushDispatcherPort;
    blobStorage?: BlobStorageDriver;
    blobLocalConfig?: LocalDriverConfig;
    emailTransport?: EmailTransport;
  } = {},
) {
  const db = deps.db ?? defaultDb;
  const eventRouter = deps.eventRouter ?? defaultEventRouter;
  const blobStorage = deps.blobStorage ?? buildBlobStorage(env);
  const blobLocalConfig =
    deps.blobLocalConfig ??
    (blobStorage.kind === "local" ? resolveLocalDriverConfig(env) : undefined);
  // Built from `defaultEventRouter`, not the possibly-fake `eventRouter` dep, because
  // `EventRouterPort` doesn't carry `hasActiveVisibleClient` — only the full singleton does.
  const pushDispatcher = deps.pushDispatcher ?? buildPushDispatcher(db, defaultEventRouter);

  const app = Fastify({
    logger: buildLoggerOptions(),
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    ...opts,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const emailTransport = deps.emailTransport ?? createDevLoggerEmailTransport(app.log);

  // Reuses the same allowlist validator as Socket.IO's CORS so one `CORS_ALLOWED_ORIGINS`
  // list governs both transports. `credentials: false`: auth is always a bearer token,
  // never a cookie. `allow ?? false` adapts `buildCorsOriginValidator`'s boolean callback
  // shape into `@fastify/cors`'s StaticOrigin shape without duplicating the allowlist logic.
  const isAllowedOrigin = buildCorsOriginValidator(env.CORS_ALLOWED_ORIGINS);
  await app.register(cors, {
    origin: (origin, callback) => {
      isAllowedOrigin(origin, (err, allow) => callback(err, allow ?? false));
    },
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  // Registered BEFORE the rate limiter: authPlugin installs a non-enforcing global
  // preHandler that populates `req.accountId`, and global hooks run in registration order.
  // The rate limiter's keyGenerator must see accountId, so authPlugin must register first.
  await app.register(authPlugin);

  // Keyed by authenticated account when available so one account can't starve another
  // sharing an IP/NAT. Falls back to IP for unauthenticated routes.
  // `hook: "preHandler"` — the default `onRequest` fires before authPlugin's identification
  // hook and would silently degrade to IP-only keying everywhere.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    hook: "preHandler",
    keyGenerator: (req) => req.accountId || req.ip,
  });

  // `onResponse` hook covers all routes without per-route instrumentation.
  // Uses `routeOptions.url` (the matched pattern) not `request.url` (literal path)
  // to keep the `route` label's cardinality bounded. Falls back to `"unmatched"` for 404s.
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    recordHttpRequest(request.method, route, reply.statusCode, reply.elapsedTime / 1000);
  });

  await app.register(healthRoutes);
  await app.register(metricsRoutes);
  await app.register(
    buildOAuthRoutes(
      db,
      deps.oauthVerifier ?? defaultOAuthVerifier,
      deps.githubExchanger ?? defaultGithubCodeExchanger,
      deps.googleExchanger ?? defaultGoogleCodeExchanger,
    ),
  );
  await app.register(buildRefreshRoutes(db));
  await app.register(buildPasswordRoutes(db, emailTransport));
  await app.register(buildKeysRoutes(db, deps.oauthVerifier ?? defaultOAuthVerifier));
  await app.register(
    buildSessionsAdminRoutes(db, (accountId, sessionId) =>
      disconnectSession(defaultEventRouter, accountId, sessionId),
    ),
  );
  await app.register(pairRoutes);
  await app.register(buildKeyRequestRoutes(db, eventRouter));
  await app.register(buildSessionsRoutes(db, eventRouter, pushDispatcher));
  await app.register(buildMessagesRoutes(db, eventRouter));
  await app.register(buildSessionCasRoutes(db, eventRouter));
  await app.register(buildSessionStatusRoutes(db, eventRouter, pushDispatcher));
  await app.register(buildSessionArchiveRoutes(db, eventRouter));
  await app.register(buildSessionNotifyRoutes(db, eventRouter, pushDispatcher));
  await app.register(buildSyncRoutes(db, eventRouter, pushDispatcher));
  await app.register(buildMachinesRoutes(db, eventRouter));
  await app.register(buildUnmanagedSessionsRoutes(db, eventRouter));
  await app.register(buildWorkspacesRoutes(db, eventRouter));
  await app.register(buildPushRoutes(db));
  await app.register(
    buildBlobsRoutes(db, blobStorage, {
      maxSizeBytes: env.BLOB_MAX_SIZE_BYTES,
      publicApiOrigin: env.PUBLIC_API_ORIGIN,
      local: blobLocalConfig,
    }),
  );
  await app.register(buildTelegramLinkRoutes(db));
  await app.register(buildNotificationSettingsRoutes(db, eventRouter));

  startSocket(app, db);

  return app;
}
