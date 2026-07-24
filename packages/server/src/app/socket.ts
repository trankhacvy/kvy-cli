import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { Server, type Socket } from "socket.io";
import { verifyToken } from "../auth/tokens.js";
import { env } from "../config.js";
import { deviceSessions, machines } from "../db/schema.js";
import type { Database } from "../db/types.js";
import {
  buildMachinePresenceEphemeral,
  buildSessionActivityEphemeral,
  type ClientConnection,
  eventRouter,
} from "./events/eventRouter.js";
import { computeMachineNeedsReauth } from "./machineReauth.js";
import { recordWsConnectionClosed, recordWsConnectionOpened } from "./routes/metrics.js";
import { buildCorsOriginValidator } from "./security/cors.js";
import { rpcHandler } from "./socket/rpcHandler.js";

type ClientType = "session-scoped" | "machine-scoped" | "user-scoped";

// Ported from Happy's `happy-server/sources/app/api/socket.ts` (plan.md §4.1: "port
// verbatim") — READ-ONLY WS path (design ⚠ DELTA D1: writes are HTTP, see the sibling
// 1.2 task). Keeps: auth-in-middleware (so events can't race the connection), the three
// client scopes, room joins via `eventRouter`, machine online/offline ephemeral
// broadcast, and `app-state` tracking for push suppression. Dropped from Happy's version:
// the Redis streams adapter wiring (falcon-system-design.md §6.4 defers multi-process to
// behind an env flag; single process at MVP) and the non-read-path handlers
// (sessionUpdateHandler/usageHandler/machineUpdateHandler/etc. — out of scope for this task).
export function startSocket(app: FastifyInstance, db: Database): Server {
  const io = new Server(app.server, {
    // Explicit allowlist, not a wildcard (falcon-system-design.md §12, plan.md §16 "4.4
    // Hardening": "wildcard-CORS removal"). `origin: "*"` combined with
    // `credentials: true` is a standing vuln class — no real browser honors that
    // combination for credentialed requests, so it only ever gave a false sense of
    // protection. See `security/cors.ts` for the allowlist semantics.
    cors: {
      origin: buildCorsOriginValidator(env.CORS_ALLOWED_ORIGINS),
      methods: ["GET", "POST", "OPTIONS"],
      credentials: true,
      allowedHeaders: ["*"],
    },
    transports: ["websocket", "polling"],
    pingTimeout: 45_000,
    pingInterval: 15_000,
    path: "/v1/stream",
    allowUpgrades: true,
    upgradeTimeout: 10_000,
    connectTimeout: 20_000,
    serveClient: false,
  });

  eventRouter.init(io);

  // Auth runs in middleware so it completes BEFORE the client's `connect` event fires.
  // Without this, the async verifyToken call in the connection callback would create a
  // window where client events (rpc-register, rpc-call) arrive before handlers are
  // attached — and get silently dropped.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token as string | undefined;
    const clientType = socket.handshake.auth.clientType as ClientType | undefined;
    const sessionId = socket.handshake.auth.sessionId as string | undefined;
    const machineId = socket.handshake.auth.machineId as string | undefined;
    const appState = socket.handshake.auth.appState as string | undefined;

    if (!token) {
      app.log.warn({ module: "websocket" }, "socket connect rejected: no token provided");
      next(new Error("Missing authentication token"));
      return;
    }

    if (clientType === "session-scoped" && !sessionId) {
      app.log.warn({ module: "websocket" }, "session-scoped client missing sessionId");
      next(new Error("Session ID required for session-scoped clients"));
      return;
    }

    if (clientType === "machine-scoped" && !machineId) {
      app.log.warn({ module: "websocket" }, "machine-scoped client missing machineId");
      next(new Error("Machine ID required for machine-scoped clients"));
      return;
    }

    const verified = await verifyToken(token);
    if (!verified) {
      app.log.warn({ module: "websocket" }, "socket connect rejected: invalid token");
      next(new Error("Invalid authentication token"));
      return;
    }

    // issue-4-plan.md §4.5a: a stateless access token can't itself carry revocation, so
    // the one place this server ever hits the DB for it is right here, at connect —
    // a single cheap row lookup, not a per-request cost, and the reason revocation is
    // "immediate on live WebSockets" per §9 rather than bounded only by the access
    // token's own (now 15m) TTL.
    const deviceSession = await db.query.deviceSessions.findFirst({
      where: eq(deviceSessions.id, verified.sessionId),
    });
    if (
      !deviceSession ||
      deviceSession.revokedAt ||
      deviceSession.expiresAt.getTime() < Date.now()
    ) {
      app.log.warn({ module: "websocket" }, "socket connect rejected: session revoked or expired");
      next(new Error("Session revoked"));
      return;
    }

    socket.data.accountId = verified.accountId;
    socket.data.clientType = clientType ?? "user-scoped";
    socket.data.sessionId = sessionId;
    socket.data.machineId = machineId;
    // The access token's own claimed `device_sessions.id` — deliberately a DIFFERENT
    // field from `sessionId` above, which names the session-*scoped* client's own
    // provider session (unrelated to auth) and must not be clobbered. `authSessionId` is
    // what the revoke routes' `disconnectSession` matches against to find this exact
    // live connection, and what the expiry timer below re-arms on `renew-token` (§4.5b).
    socket.data.authSessionId = verified.sessionId;
    socket.data.tokenExpiresAt = verified.expiresAt;
    // Read the initial app-state from the handshake to close the race window between
    // connect and the first async `app-state` event; the `app-state` listener below
    // keeps it current for the rest of the connection's lifetime.
    socket.data.appState = appState === "active" ? "active" : "background";

    next();
  });

  io.on("connection", (socket: Socket) => {
    const accountId = socket.data.accountId as string;
    const clientType = socket.data.clientType as ClientType;
    const sessionId = socket.data.sessionId as string | undefined;
    const machineId = socket.data.machineId as string | undefined;

    app.log.info(
      { module: "websocket" },
      `socket connected: account=${accountId} clientType=${clientType} sessionId=${sessionId ?? "none"} machineId=${machineId ?? "none"}`,
    );

    let connection: ClientConnection;
    if (clientType === "session-scoped" && sessionId) {
      connection = { connectionType: "session-scoped", socket, accountId, sessionId };
    } else if (clientType === "machine-scoped" && machineId) {
      connection = { connectionType: "machine-scoped", socket, accountId, machineId };
    } else {
      connection = { connectionType: "user-scoped", socket, accountId };
    }

    eventRouter.addConnection(accountId, connection);
    recordWsConnectionOpened(connection.connectionType);

    // Machine online broadcast (plan.md §4.1 item 4): only user-scoped/session-scoped
    // clients (e.g. the web app) care — the machine's own socket doesn't need to hear
    // about itself.
    if (connection.connectionType === "machine-scoped") {
      eventRouter.emitEphemeral({
        accountId,
        payload: buildMachinePresenceEphemeral(connection.machineId, true),
        recipientFilter: { type: "user-scoped-only" },
      });
    }

    socket.on("app-state", (data: { state?: string }) => {
      socket.data.appState = data?.state === "active" ? "active" : "background";
    });

    // In-band renewal (§4.5b): a hard disconnect timed to the access token's own `exp`
    // would flap the connection every 15 minutes for every client — exactly the
    // "disconnect storm" (and, for the daemon, the machine-presence flap) issue #4
    // reported. Instead: arm a timer for the CURRENT token's expiry; a client that
    // refreshes and emits `renew-token` before it fires gets a fresh deadline and the
    // socket never drops. One that doesn't (dead refresh token, client bug, or a
    // genuinely revoked session) is disconnected exactly once, at expiry — no earlier.
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const armExpiryTimer = (expiresAtEpochSeconds: number): void => {
      clearTimeout(expiryTimer);
      const delayMs = Math.max(0, expiresAtEpochSeconds * 1000 - Date.now());
      expiryTimer = setTimeout(() => socket.disconnect(true), delayMs);
    };
    armExpiryTimer(socket.data.tokenExpiresAt as number);

    socket.on("renew-token", async (rawToken: string, ack?: (ok: boolean) => void) => {
      const verified = await verifyToken(rawToken);
      const stillSameAccount = verified && verified.accountId === accountId;
      const deviceSession =
        stillSameAccount &&
        (await db.query.deviceSessions.findFirst({
          where: eq(deviceSessions.id, verified.sessionId),
        }));
      if (!stillSameAccount || !deviceSession || deviceSession.revokedAt) {
        ack?.(false);
        socket.disconnect(true);
        return;
      }
      socket.data.authSessionId = verified.sessionId;
      socket.data.tokenExpiresAt = verified.expiresAt;
      armExpiryTimer(verified.expiresAt);
      ack?.(true);
    });

    // Session-scoped keepalive (`packages/cli/src/session/sessionClient.ts`'s
    // `alive` volatile emit, design §4.3 `ClientEmit` `{ e: 'alive'; sessionId;
    // working }`). Relayed as an `activity` ephemeral to whoever's watching this
    // session — a pure live relay, deliberately with no durable cache behind it:
    // "is this turn actively working" is already sourced from persisted
    // turn-start/turn-end envelopes (`deriveSessionStatus`'s `isTurnOpen`), so
    // there's no "was it recently active" state worth persisting here the way
    // machine presence needs below. `sessionId` is taken from the authenticated
    // connection, never trusted from the payload, so a session-scoped client
    // can't spoof activity for a session it isn't connected as.
    if (connection.connectionType === "session-scoped") {
      const sessionConnection = connection;
      socket.on("alive", (data: { working?: boolean } | undefined) => {
        eventRouter.emitEphemeral({
          accountId,
          payload: buildSessionActivityEphemeral(
            sessionConnection.sessionId,
            Boolean(data?.working),
          ),
          recipientFilter: {
            type: "all-interested-in-session",
            sessionId: sessionConnection.sessionId,
          },
          skipSenderConnection: connection,
        });
      });
    }

    // Machine-scoped heartbeat (`packages/cli/src/daemon/machineClient.ts`'s
    // `machine-alive` volatile emit, every `heartbeatIntervalMs` — 60s by
    // default). Design §6.3's write-behind `lastSeenAt` presence cache: until
    // this handler existed, the event had no listener at all (dropped
    // silently), so `machines.lastSeenAt` only ever got set once at
    // registration/`POST /v1/machines` and went stale for the rest of a long
    // daemon session — the exact gap the web's `deriveMachineOnline` heuristic
    // (`use-machine-presence.ts`) was already built to tolerate via a 3-minute
    // (three-missed-beats) recency window, but which only works if this write
    // actually happens. `machineId`/`accountId` come from the authenticated
    // connection, never the payload, same non-spoofable pattern as the
    // session-scoped `alive` handler above. Update failures are logged, not
    // thrown — a missed heartbeat write should never take down the socket.
    if (connection.connectionType === "machine-scoped") {
      const machineConnection = connection;
      socket.on("machine-alive", () => {
        db.update(machines)
          .set({ lastSeenAt: new Date() })
          .where(
            and(eq(machines.id, machineConnection.machineId), eq(machines.accountId, accountId)),
          )
          .catch((error: unknown) => {
            app.log.warn(
              { module: "websocket", error },
              "failed to persist machine-alive heartbeat",
            );
          });
      });
    }

    socket.on("disconnect", () => {
      clearTimeout(expiryTimer);
      eventRouter.removeConnection(accountId, connection);
      recordWsConnectionClosed(connection.connectionType);
      app.log.info({ module: "websocket" }, `socket disconnected: account=${accountId}`);

      if (connection.connectionType === "machine-scoped") {
        const disconnectedMachineId = connection.machineId;
        // AH8 "machine-status-reauth": a dead-refresh-token daemon can't
        // tell the server anything over its own (now-dead) socket, so the
        // server infers "needs re-auth" itself, right here at disconnect —
        // the one place a machine-scoped socket going away and the server
        // already knowing whether its `cli-daemon` device session is
        // revoked naturally meet. Never blocks emitting the plain
        // offline signal a genuinely-asleep/powered-off machine still needs.
        computeMachineNeedsReauth(db, accountId, disconnectedMachineId)
          .catch((error: unknown) => {
            app.log.warn(
              { module: "websocket", error },
              "failed to compute machine reauth status on disconnect",
            );
            return false;
          })
          .then((needsReauth) => {
            eventRouter.emitEphemeral({
              accountId,
              payload: buildMachinePresenceEphemeral(disconnectedMachineId, false, needsReauth),
              recipientFilter: { type: "user-scoped-only" },
            });
          });
      }
    });

    rpcHandler(accountId, socket, io);
  });

  app.addHook("onClose", async () => {
    await io.close();
  });

  return io;
}
