/**
 * HTTP control server for the Kvy daemon: a Fastify server bound to
 * `127.0.0.1:0` (OS-assigned ephemeral port) exposing `/session-started`,
 * `/list`, `/stop-session`, `/spawn-session`, and `/stop`.
 *
 * `/session-started` is load-bearing: it's the only path by which a spawned
 * session's encryption material reaches the daemon. Keep its shape stable.
 *
 * `getSessions`/`stopSession`/`spawnSession`/`requestShutdown` are injected;
 * this module never spawns processes or owns that state directly.
 */

import { PermissionModeSchema, ProviderIdSchema, StopSessionParamsSchema } from "@kvy/wire";
import fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import type { Logger } from "../logger.js";
import type {
  SessionEncryptionData,
  SpawnSessionOptions,
  SpawnSessionResult,
  TrackedSession,
} from "./types.js";

const SessionStartedBodySchema = z.object({
  sessionId: z.string(),
  metadata: z.unknown().optional(),
  encryption: z
    .object({
      encryptionKey: z.string(),
      seq: z.number(),
      metadataVersion: z.number(),
      agentStateVersion: z.number(),
    })
    .optional(),
  /** This session process's own pid — present when it was daemon-spawned (see module header). */
  pid: z.number().optional(),
});

const SessionStartedResponseSchema = z.object({ status: z.literal("ok") });

/**
 * Best-effort self-report of a startup failure, so a generic 15s timeout
 * doesn't mask the real failure reason, mirroring
 * `/session-started`'s own "session process reports itself" shape but for
 * the failure path. `start.ts`/`startCodex.ts` post here when
 * `bootstrapSession()` (or any other pre-`/session-started` step) fails, so
 * `spawnAwaiter.ts`'s `reject(pid, error)` can surface the REAL error (e.g.
 * a 429 session-quota message) instead of the spawn RPC only ever seeing a
 * generic timeout once the process exits. Never load-bearing the way
 * `/session-started` is — a session that never posts here still gets caught
 * by `spawnAwaiter`'s `watchExit`-driven fast-rejection (A3) or, failing
 * that, the original flat timeout (A3's own doc comment covers the full
 * fallback chain).
 */
const SessionStartFailedBodySchema = z.object({
  /** This session process's own pid — the same correlation key `/session-started` uses. */
  pid: z.number(),
  error: z.string(),
});
const SessionStartFailedResponseSchema = z.object({ status: z.literal("ok") });

const ListResponseSchema = z.object({
  sessions: z.array(
    z.object({
      startedBy: z.string(),
      sessionId: z.string(),
      pid: z.number(),
    }),
  ),
});

// `sessionId` overlaps @kvy/wire's machine RPC contract exactly; `force`
// is accepted but unused here (this HTTP layer sends a bare stop signal —
// force semantics belong to whatever `stopSession` implementation is injected).
const StopSessionBodySchema = StopSessionParamsSchema;
const StopSessionResponseSchema = z.object({ success: z.boolean() });

const SpawnSessionBodySchema = z.object({
  directory: z.string(),
  sessionId: z.string().optional(),
  provider: ProviderIdSchema.optional(),
  permissionMode: PermissionModeSchema.optional(),
  model: z.string().optional(),
  environmentVariables: z.record(z.string(), z.string()).optional(),
});

const SpawnSuccessResponseSchema = z.object({
  success: z.boolean(),
  sessionId: z.string().optional(),
});
const SpawnConflictResponseSchema = z.object({
  success: z.boolean(),
  requiresUserApproval: z.boolean().optional(),
  actionRequired: z.string().optional(),
  directory: z.string().optional(),
});
const SpawnErrorResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const StopResponseSchema = z.object({ status: z.string() });

const ReloadAuthResponseSchema = z.object({ reloaded: z.boolean() });

export interface ControlServerDeps {
  /** Snapshot of currently tracked sessions; only `startedBy`/`sessionId`/`pid` surface over `/list`. */
  getSessions: () => TrackedSession[];
  /** Signal the session with this `sessionId` to stop; returns whether one was found and signalled. */
  stopSession: (sessionId: string) => boolean;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  /** Called once `/stop` is hit; the caller decides how the daemon process actually exits. */
  requestShutdown: () => void;
  /**
   * Re-read `~/.kvy/access.key` and restart machine integration in place —
   * the daemon only registers a machine once at startup, so a session that just
   * a caller that doesn't own machine integration (tests) can leave it unset.
   */
  reloadAuth?: () => Promise<boolean>;
  /** Invoked when a spawned session self-reports via `/session-started`. */
  onSessionStarted: (
    sessionId: string,
    metadata: unknown,
    encryption?: SessionEncryptionData,
    pid?: number,
  ) => void;
  /**
   * Invoked when a spawned session self-reports a startup failure via
   * `/session-start-failed` (A4). Optional: a caller that doesn't wire a
   * `spawnAwaiter` (e.g. a test harness) can simply omit it — the route
   * still accepts and acknowledges the POST either way, matching
   * `/session-started`'s own tolerance for an absent daemon-side consumer.
   */
  onSessionStartFailed?: (pid: number, error: string) => void;
  logger?: Logger;
}

export interface ControlServerHandle {
  port: number;
  stop: () => Promise<void>;
}

export function startControlServer(deps: ControlServerDeps): Promise<ControlServerHandle> {
  const {
    getSessions,
    stopSession,
    spawnSession,
    requestShutdown,
    onSessionStarted,
    onSessionStartFailed,
    reloadAuth,
    logger,
  } = deps;

  return new Promise((resolve, reject) => {
    const app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    app.post(
      "/session-started",
      {
        schema: { body: SessionStartedBodySchema, response: { 200: SessionStartedResponseSchema } },
      },
      async (request) => {
        const { sessionId, metadata, encryption, pid } = request.body;
        logger?.debug("[control-server] session-started", { sessionId, pid });
        onSessionStarted(sessionId, metadata, encryption, pid);
        return { status: "ok" as const };
      },
    );

    // A4: a session process's best-effort self-report that it failed to
    // start (e.g. `bootstrapSession()` hit a 429 quota rejection) — lets
    // `spawnAwaiter.reject(pid, error)` surface the real reason instead of
    // the caller only ever learning about a generic timeout once the dead
    // process's exit is (separately, more slowly) observed.
    app.post(
      "/session-start-failed",
      {
        schema: {
          body: SessionStartFailedBodySchema,
          response: { 200: SessionStartFailedResponseSchema },
        },
      },
      async (request) => {
        const { pid, error } = request.body;
        logger?.debug("[control-server] session-start-failed", { pid, error });
        onSessionStartFailed?.(pid, error);
        return { status: "ok" as const };
      },
    );

    // List all tracked sessions.
    app.post("/list", { schema: { response: { 200: ListResponseSchema } } }, async () => {
      const sessions = getSessions();
      logger?.debug("[control-server] listing sessions", { count: sessions.length });
      return {
        sessions: sessions
          .filter((s): s is TrackedSession & { sessionId: string } => s.sessionId !== undefined)
          .map((s) => ({ startedBy: s.startedBy, sessionId: s.sessionId, pid: s.pid })),
      };
    });

    // Stop a specific session.
    app.post(
      "/stop-session",
      { schema: { body: StopSessionBodySchema, response: { 200: StopSessionResponseSchema } } },
      async (request) => {
        const { sessionId } = request.body;
        logger?.debug("[control-server] stop-session request", { sessionId });
        return { success: stopSession(sessionId) };
      },
    );

    // Spawn a new session.
    app.post(
      "/spawn-session",
      {
        schema: {
          body: SpawnSessionBodySchema,
          response: {
            200: SpawnSuccessResponseSchema,
            409: SpawnConflictResponseSchema,
            500: SpawnErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { directory, sessionId, provider, permissionMode, model, environmentVariables } =
          request.body;
        logger?.debug("[control-server] spawn-session request", { directory, sessionId, provider });
        const result = await spawnSession({
          directory,
          sessionId,
          provider,
          permissionMode,
          model,
          environmentVariables,
        });

        switch (result.type) {
          case "success":
            return { success: true, sessionId: result.sessionId };
          case "requestToApproveDirectoryCreation":
            reply.code(409);
            return {
              success: false,
              requiresUserApproval: true,
              actionRequired: "CREATE_DIRECTORY",
              directory: result.directory,
            };
          case "error":
            reply.code(500);
            return { success: false, error: result.errorMessage };
        }
      },
    );

    app.post(
      "/reload-auth",
      { schema: { response: { 200: ReloadAuthResponseSchema } } },
      async () => {
        logger?.debug("[control-server] reload-auth request received");
        if (!reloadAuth) return { reloaded: false };
        return { reloaded: await reloadAuth() };
      },
    );

    // Stop the daemon.
    app.post("/stop", { schema: { response: { 200: StopResponseSchema } } }, async () => {
      logger?.debug("[control-server] stop daemon request received");
      // Give the response time to flush to the caller before this process exits.
      setTimeout(() => {
        logger?.debug("[control-server] triggering daemon shutdown");
        requestShutdown();
      }, 50);
      return { status: "stopping" };
    });

    app.listen({ port: 0, host: "127.0.0.1" }, (err, address) => {
      if (err) {
        logger?.debug("[control-server] failed to start", {
          error: err instanceof Error ? err.message : String(err),
        });
        reject(err);
        return;
      }

      const port = Number(address.split(":").pop());
      logger?.debug("[control-server] started", { port });

      resolve({
        port,
        stop: async () => {
          logger?.debug("[control-server] stopping");
          await app.close();
          logger?.debug("[control-server] stopped");
        },
      });
    });
  });
}
