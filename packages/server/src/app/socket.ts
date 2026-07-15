import type { FastifyInstance } from "fastify";
import { Server, type Socket } from "socket.io";
import { verifyToken } from "../auth/tokens.js";
import {
  buildMachinePresenceEphemeral,
  type ClientConnection,
  eventRouter,
} from "./events/eventRouter.js";
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
export function startSocket(app: FastifyInstance): Server {
  const io = new Server(app.server, {
    cors: {
      origin: "*",
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

    socket.data.accountId = verified.accountId;
    socket.data.clientType = clientType ?? "user-scoped";
    socket.data.sessionId = sessionId;
    socket.data.machineId = machineId;
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

    socket.on("disconnect", () => {
      eventRouter.removeConnection(accountId, connection);
      app.log.info({ module: "websocket" }, `socket disconnected: account=${accountId}`);

      if (connection.connectionType === "machine-scoped") {
        eventRouter.emitEphemeral({
          accountId,
          payload: buildMachinePresenceEphemeral(connection.machineId, false),
          recipientFilter: { type: "user-scoped-only" },
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
