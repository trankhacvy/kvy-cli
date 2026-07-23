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
  defaultGithubCodeExchanger,
  defaultOAuthVerifier,
  type GithubCodeExchanger,
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
import { eventRouter as defaultEventRouter, type EventRouterPort } from "./events/eventRouter.js";
import { buildPushDispatcher } from "./push/dispatch.js";
import type { PushDispatcherPort } from "./push/types.js";
import { buildAuthRoutes } from "./routes/auth.js";
import { buildBlobsRoutes } from "./routes/blobs.js";
import { buildMachinesRoutes } from "./routes/machines.js";
import { buildMessagesRoutes } from "./routes/messages.js";
import { metricsRoutes, recordHttpRequest } from "./routes/metrics.js";
import { buildNotificationSettingsRoutes } from "./routes/notificationSettings.js";
import { buildOAuthRoutes } from "./routes/oauth.js";
import { buildPushRoutes } from "./routes/push.js";
import { buildSessionArchiveRoutes } from "./routes/sessionArchive.js";
import { buildSessionCasRoutes } from "./routes/sessionCas.js";
import { buildSessionNotifyRoutes } from "./routes/sessionNotify.js";
import { buildSessionStatusRoutes } from "./routes/sessionStatus.js";
import { buildSessionsRoutes } from "./routes/sessions.js";
import { buildSyncRoutes } from "./routes/sync.js";
import { buildTelegramLinkRoutes } from "./routes/telegramLink.js";
import { buildUnmanagedSessionsRoutes } from "./routes/unmanagedSessions.js";
import { buildCorsOriginValidator } from "./security/cors.js";
import { startSocket } from "./socket.js";

// Default request-size cap (design §4.3: "request-size caps"). The message
// ingest route overrides this per-route to fit one coalesced outbox flush —
// see messages.ts's MESSAGE_BODY_LIMIT_BYTES. Every other route is
// structural/control-plane JSON, for which Fastify's own 1 MiB default is
// already generous; set explicitly here so it's a documented decision, not
// an implicit default.
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

// App factory (kept separate from process startup in src/main.ts) so tests
// can build+inject() without opening a real port or a real pino transport.
// `db` defaults to the module-level singleton (db/client.ts) but can be overridden —
// auth.test.ts/route tests bind an in-memory Postgres instead of touching
// `DATABASE_URL`. `oauthVerifier`/`githubExchanger` similarly default to the real
// implementations but can be overridden — oauth.test.ts injects fakes instead of
// touching the network. `eventRouter` defaults to the process-wide Socket.IO-backed
// singleton (events/eventRouter.ts) but route tests inject a recording fake so they
// can assert on fan-out without a real socket connection. `pushDispatcher` defaults
// to a real one built from `db` + the process-wide `eventRouter` singleton's presence
// check (`app/push/dispatch.ts`) but route tests inject a recording fake so they can
// assert "a dispatch was requested" without touching real Web Push/Socket.IO.
export async function buildServer(
  opts: FastifyServerOptions = {},
  deps: {
    db?: Database;
    oauthVerifier?: OAuthVerifier;
    githubExchanger?: GithubCodeExchanger;
    eventRouter?: EventRouterPort;
    pushDispatcher?: PushDispatcherPort;
    /** Injectable so tests never need real S3 creds or a writable disk; defaults to `buildBlobStorage(env)` (S3 if `S3_BUCKET` is set, else local-disk). */
    blobStorage?: BlobStorageDriver;
    /** Only consulted when `blobStorage.kind === "local"`; defaults to `resolveLocalDriverConfig(env)`. Tests inject a throwaway temp dir here instead of touching `~/.falcon/server/blobs` or process env. */
    blobLocalConfig?: LocalDriverConfig;
  } = {},
) {
  const db = deps.db ?? defaultDb;
  const eventRouter = deps.eventRouter ?? defaultEventRouter;
  const blobStorage = deps.blobStorage ?? buildBlobStorage(env);
  const blobLocalConfig =
    deps.blobLocalConfig ??
    (blobStorage.kind === "local" ? resolveLocalDriverConfig(env) : undefined);
  // Deliberately built from `defaultEventRouter` (the real, presence-capable
  // singleton), not the possibly-fake `eventRouter` above — `EventRouterPort`
  // (what `deps.eventRouter` is typed as) doesn't carry `hasActiveVisibleClient`,
  // only the full `eventRouter` singleton does (see events/eventRouter.ts).
  const pushDispatcher = deps.pushDispatcher ?? buildPushDispatcher(db, defaultEventRouter);

  const app = Fastify({
    logger: buildLoggerOptions(),
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    ...opts,
  }).withTypeProvider<ZodTypeProvider>();

  // Zod becomes the schema/validation/serialization language for every
  // typed route registered below (design §3: "Typed routes").
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // HTTP CORS for the split-origin self-host shape (falcon-system-design.md §5.3/§9,
  // plan.md §16 "4.3 Distribution & self-host": web is a static export served from a
  // different origin than this API). Reuses the exact same allowlist validator Socket.IO's
  // `cors.origin` already uses (`security/cors.ts`, built for the wildcard-CORS removal in
  // P4-4.4-security-pass) so there is one `CORS_ALLOWED_ORIGINS` allowlist governing both
  // transports, not two independently-drifting lists. `credentials: false`: auth is a
  // bearer token in the `Authorization` header (auth/tokens.ts), never a cookie, so there's
  // no session to leak via a credentialed cross-origin request — omitting
  // `Access-Control-Allow-Credentials` entirely is strictly safer than the alternative.
  // `allowedHeaders` is an explicit allowlist (not the plugin's default "reflect whatever
  // the browser asked for") to match this file's general stance of narrow-by-default.
  //
  // `@fastify/cors`'s origin-function callback is `(err, origin: StaticOrigin) => void`
  // (its second argument becomes the literal `Access-Control-Allow-Origin` value, or a
  // boolean shorthand for "reflect the request origin" / "deny"), which differs just
  // enough from `buildCorsOriginValidator`'s `(err, allow?: boolean) => void` shape
  // (matched to Socket.IO's `cors` package convention) that TypeScript won't structurally
  // unify the two callback types. `allow ?? false` below adapts the boolean the shared
  // validator already produces into this plugin's expected shape without duplicating the
  // allowlist-matching logic itself.
  const isAllowedOrigin = buildCorsOriginValidator(env.CORS_ALLOWED_ORIGINS);
  await app.register(cors, {
    origin: (origin, callback) => {
      isAllowedOrigin(origin, (err, allow) => callback(err, allow ?? false));
    },
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  // Global default; individual routes narrow it further via `config.rateLimit`
  // (design §4.3: "rate limits on auth + ingest routes"). Keyed by the
  // authenticated account when available (set by `app.authenticate` below)
  // so one account can't starve another sharing an IP/NAT; falls back to IP
  // for routes that run before/without authentication (health checks, and
  // the auth routes themselves). `hook: "preHandler"` (rather than the
  // plugin's default `onRequest`) is required for that account-keying to
  // ever take effect: `app.authenticate` itself runs as a route `preHandler`
  // and only sets `req.accountId` there, which is *after* `onRequest` fires —
  // an `onRequest`-hooked key generator would see `req.accountId` unset on
  // every request and silently degrade to IP-only keying for authenticated
  // routes too.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    hook: "preHandler",
    keyGenerator: (req) => req.accountId || req.ip,
  });

  // Decorates `app.authenticate` (design §16 "0.4 Server foundation") so routes
  // registered below or in later phases can require a valid bearer JWT via
  // `{ preHandler: app.authenticate }`.
  await app.register(authPlugin);

  // `onResponse` (not a route-level hook) so every route registered below —
  // present and future — is covered without each one remembering to
  // instrument itself, mirroring how `rpcHandler.ts` instruments every RPC
  // call from one shared `finish()` closure rather than per-method. Reads
  // `request.routeOptions.url` (the matched *pattern*, e.g.
  // `/v1/sessions/:id/messages`) rather than `request.url` (the literal
  // path) to keep the `route` label's cardinality bounded — see
  // `routes/metrics.ts`'s `recordHttpRequest` doc comment. Falls back to
  // `"unmatched"` for 404s, where no route pattern exists yet.
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    recordHttpRequest(request.method, route, reply.statusCode, reply.elapsedTime / 1000);
  });

  await app.register(healthRoutes);
  await app.register(metricsRoutes);
  await app.register(buildAuthRoutes(db));
  await app.register(
    buildOAuthRoutes(
      db,
      deps.oauthVerifier ?? defaultOAuthVerifier,
      deps.githubExchanger ?? defaultGithubCodeExchanger,
    ),
  );
  await app.register(pairRoutes);
  await app.register(buildSessionsRoutes(db, eventRouter));
  await app.register(buildMessagesRoutes(db, eventRouter));
  await app.register(buildSessionCasRoutes(db, eventRouter));
  await app.register(buildSessionStatusRoutes(db, eventRouter, pushDispatcher));
  await app.register(buildSessionArchiveRoutes(db, eventRouter));
  await app.register(buildSessionNotifyRoutes(db, eventRouter, pushDispatcher));
  await app.register(buildSyncRoutes(db));
  await app.register(buildMachinesRoutes(db, eventRouter));
  await app.register(buildUnmanagedSessionsRoutes(db, eventRouter));
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

  // Socket.IO attaches to the underlying HTTP server (design §4.1 "/v1/stream" —
  // read-only updates/ephemerals + RPC transport). Started here rather than in
  // `main.ts` so `buildServer()` remains the single place a real server (or a test)
  // assembles the whole app. `startSocket` binds the process-wide `eventRouter`
  // singleton (events/eventRouter.ts) to this server's Socket.IO instance via
  // `eventRouter.init(io)` — the same singleton the HTTP write routes above fan
  // out through by default, so a write's post-commit `emitUpdate` reaches Socket.IO
  // rooms without either side knowing about the other's transport.
  startSocket(app, db);

  return app;
}
