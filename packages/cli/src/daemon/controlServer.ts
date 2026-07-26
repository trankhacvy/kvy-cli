/**
 * HTTP control server for the Falcon daemon.
 *
 * Ported verbatim from happy-cli/src/daemon/controlServer.ts (MIT) per
 * plan.md §7.1 — a Fastify server bound to `127.0.0.1:0` (an OS-assigned
 * ephemeral port, never a fixed one — the resolved port is what the caller
 * persists to `daemon.state.json`, §7.4) exposing `/session-started`,
 * `/list`, `/stop-session`, `/spawn-session`, and `/stop`.
 *
 * `/session-started` is the one endpoint whose contract is load-bearing
 * beyond this module: it's the only path by which a spawned session's
 * encryption material ever reaches the daemon, and daemon durability (§7.4,
 * a separate task) persists exactly what this handler receives so resume
 * survives a daemon restart. Keep its shape stable.
 *
 * It also carries the spawned session's own `pid` (optional — a session
 * started straight from a terminal, not by the daemon, doesn't know one),
 * which is how the `spawn` RPC's pid↔webhook awaiter (`spawnAwaiter.ts`,
 * plan.md §16 "3.1 Remote spawn") matches this webhook back to the spawn
 * call that launched the process: the daemon knows the pid it launched
 * immediately, but not the `sessionId` until the session reports it here.
 *
 * This module never spawns processes, locks a singleton, or opens a WS to
 * the machine — `getSessions`/`stopSession`/`spawnSession`/`requestShutdown`
 * are injected by the caller, which owns that state and those side effects
 * (§7.2/§7.3/§7.4, separate plan bullets).
 */

import { PermissionModeSchema, StopSessionParamsSchema } from "@falcon/wire";
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

const ListResponseSchema = z.object({
  sessions: z.array(
    z.object({
      startedBy: z.string(),
      sessionId: z.string(),
      pid: z.number(),
    }),
  ),
});

// `sessionId` overlaps @falcon/wire's machine RPC contract exactly; `force`
// is accepted but unused here (this HTTP layer sends a bare stop signal —
// force semantics belong to whatever `stopSession` implementation is injected).
const StopSessionBodySchema = StopSessionParamsSchema;
const StopSessionResponseSchema = z.object({ success: z.boolean() });

const SpawnSessionBodySchema = z.object({
  directory: z.string(),
  sessionId: z.string().optional(),
  provider: z.enum(["claude-code", "codex"]).optional(),
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
  /** Actual process spawning (tmux, detached fallback — §7.3) is the caller's job. */
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  /** Called once `/stop` is hit; the caller decides how the daemon process actually exits. */
  requestShutdown: () => void;
  /**
   * Re-read `~/.falcon/access.key` and restart machine integration in place —
   * the daemon only registers a machine once at startup, so a session that just
   * re-paired needs this rather than a full daemon restart (AX-1.6). Optional:
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
    reloadAuth,
    logger,
  } = deps;

  return new Promise((resolve, reject) => {
    const app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Session reports itself after creation — the resume-durability contract (§7.4).
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

    // Re-read credentials and restart machine integration in place (AX-1.6).
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
