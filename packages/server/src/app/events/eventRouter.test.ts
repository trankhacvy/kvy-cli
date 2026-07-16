import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMachinePresenceEphemeral,
  buildSessionActivityEphemeral,
  eventRouter,
} from "./eventRouter.js";

// Exercises the eventRouter's room scheme, recipient filters, and ephemeral backpressure
// coalescing against a real Socket.IO server/client pair — the room-join behavior lives
// entirely in socket.io's adapter, so a fake Socket isn't a faithful substitute.

function waitForEvent<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

describe("eventRouter", () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let port: number;
  const clients: ClientSocket[] = [];

  beforeEach(async () => {
    httpServer = createServer();
    io = new Server(httpServer);
    eventRouter.init(io);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function connectClient(): Promise<ClientSocket> {
    const client = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });
    clients.push(client);
    return new Promise((resolve) => client.once("connect", () => resolve(client)));
  }

  it("routes 'all-interested-in-session' to the session-scoped and user-scoped rooms only", async () => {
    const sessionClient = await connectClient();
    const userScopedClient = await connectClient();
    const machineClient = await connectClient();
    const otherSessionClient = await connectClient();

    // addConnection is normally called from socket.ts's connection handler; here we
    // drive it directly against each server-side socket to isolate the room scheme.
    // fetchSockets() returns sockets in connection order, matching connectClient() calls.
    const serverSockets = await io.fetchSockets();
    const [sSock, uSock, mSock, oSock] = serverSockets;
    if (!sSock || !uSock || !mSock || !oSock) throw new Error("expected 4 connected sockets");
    eventRouter.addConnection("acct_1", {
      connectionType: "session-scoped",
      // biome-ignore lint/suspicious/noExplicitAny: fetchSockets returns RemoteSocket, addConnection wants a full Socket
      socket: sSock as any,
      accountId: "acct_1",
      sessionId: "sess_1",
    });
    eventRouter.addConnection("acct_1", {
      connectionType: "user-scoped",
      // biome-ignore lint/suspicious/noExplicitAny: see above
      socket: uSock as any,
      accountId: "acct_1",
    });
    eventRouter.addConnection("acct_1", {
      connectionType: "machine-scoped",
      // biome-ignore lint/suspicious/noExplicitAny: see above
      socket: mSock as any,
      accountId: "acct_1",
      machineId: "mach_1",
    });
    eventRouter.addConnection("acct_1", {
      connectionType: "session-scoped",
      // biome-ignore lint/suspicious/noExplicitAny: see above
      socket: oSock as any,
      accountId: "acct_1",
      sessionId: "sess_2",
    });

    const sessionMsg = waitForEvent(sessionClient, "update");
    const userScopedMsg = waitForEvent(userScopedClient, "update");
    let machineGotIt = false;
    let otherSessionGotIt = false;
    machineClient.once("update", () => {
      machineGotIt = true;
    });
    otherSessionClient.once("update", () => {
      otherSessionGotIt = true;
    });

    eventRouter.emitUpdate({
      accountId: "acct_1",
      payload: { ts: Date.now(), body: { t: "session-delete", id: "sess_1" } },
      recipientFilter: { type: "all-interested-in-session", sessionId: "sess_1" },
    });

    await Promise.all([sessionMsg, userScopedMsg]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(machineGotIt).toBe(false);
    expect(otherSessionGotIt).toBe(false);
  });

  it("emitEphemeral delivers to sockets in the target room", async () => {
    const client = await connectClient();
    const [serverSocket] = await io.fetchSockets();
    eventRouter.addConnection("acct_2", {
      connectionType: "user-scoped",
      // biome-ignore lint/suspicious/noExplicitAny: fetchSockets returns RemoteSocket
      socket: serverSocket as any,
      accountId: "acct_2",
    });

    const received = waitForEvent(client, "ephemeral");
    eventRouter.emitEphemeral({
      accountId: "acct_2",
      payload: buildMachinePresenceEphemeral("mach_9", true),
      recipientFilter: { type: "user-scoped-only" },
    });

    expect(await received).toEqual({ t: "machine-presence", machineId: "mach_9", online: true });
  });

  it("buildSessionActivityEphemeral shapes an 'activity' ephemeral and emitEphemeral delivers it to session watchers", async () => {
    const client = await connectClient();
    const [serverSocket] = await io.fetchSockets();
    eventRouter.addConnection("acct_activity", {
      connectionType: "user-scoped",
      // biome-ignore lint/suspicious/noExplicitAny: fetchSockets returns RemoteSocket
      socket: serverSocket as any,
      accountId: "acct_activity",
    });

    const received = waitForEvent(client, "ephemeral");
    eventRouter.emitEphemeral({
      accountId: "acct_activity",
      payload: buildSessionActivityEphemeral("sess_activity", true),
      recipientFilter: { type: "all-interested-in-session", sessionId: "sess_activity" },
    });

    expect(await received).toEqual({ t: "activity", sessionId: "sess_activity", working: true });
  });

  it("coalesces backpressured 'activity' ephemerals to the latest value per session, flushed on drain", async () => {
    const client = await connectClient();
    const [serverSocket] = io.sockets.sockets.values();
    if (!serverSocket) throw new Error("expected a connected server socket");

    eventRouter.addConnection("acct_3", {
      connectionType: "user-scoped",
      socket: serverSocket,
      accountId: "acct_3",
    });

    // Simulate a backed-up outbound buffer: the coalescing check only inspects
    // `writeBuffer.length`, so pushing placeholder entries reproduces the "over
    // threshold" branch without needing to actually saturate the real transport.
    const conn = serverSocket.conn as unknown as { writeBuffer: unknown[] };
    for (let i = 0; i < 20; i++) conn.writeBuffer.push({});

    const receivedEvents: unknown[] = [];
    client.on("ephemeral", (payload) => receivedEvents.push(payload));

    eventRouter.emitEphemeral({
      accountId: "acct_3",
      payload: { t: "activity", sessionId: "sess_5", working: true },
    });
    eventRouter.emitEphemeral({
      accountId: "acct_3",
      payload: { t: "activity", sessionId: "sess_5", working: false },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    // Both coalesced away — nothing flushed yet since no drain has fired.
    expect(receivedEvents).toEqual([]);

    // Simulate the buffer draining.
    conn.writeBuffer.length = 0;
    (serverSocket.conn as unknown as { emit: (event: string) => void }).emit("drain");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(receivedEvents).toEqual([{ t: "activity", sessionId: "sess_5", working: false }]);
  });

  describe("hasActiveNonMachineSocket", () => {
    // addConnection only joins rooms — it never touches socket.data (that's socket.ts's
    // job, via the auth middleware + app-state handler). Set clientType/appState directly
    // here to isolate the presence-query semantics from that wiring.

    it("treats a connected socket that never reported app-state as active", async () => {
      const client = await connectClient();
      const [serverSocket] = await io.fetchSockets();
      if (!serverSocket) throw new Error("expected a connected server socket");
      eventRouter.addConnection("acct_10", {
        connectionType: "user-scoped",
        // biome-ignore lint/suspicious/noExplicitAny: fetchSockets returns RemoteSocket
        socket: serverSocket as any,
        accountId: "acct_10",
      });

      expect(await eventRouter.hasActiveNonMachineSocket("acct_10")).toBe(true);
      client.close();
    });

    it("returns false once the only connected socket reports app-state: background", async () => {
      await connectClient();
      const [serverSocket] = await io.fetchSockets();
      if (!serverSocket) throw new Error("expected a connected server socket");
      serverSocket.data.appState = "background";
      eventRouter.addConnection("acct_11", {
        connectionType: "user-scoped",
        // biome-ignore lint/suspicious/noExplicitAny: fetchSockets returns RemoteSocket
        socket: serverSocket as any,
        accountId: "acct_11",
      });

      expect(await eventRouter.hasActiveNonMachineSocket("acct_11")).toBe(false);
    });

    it("returns true if at least one of several sockets is active", async () => {
      await connectClient();
      await connectClient();
      const [backgroundSocket, activeSocket] = await io.fetchSockets();
      if (!backgroundSocket || !activeSocket) throw new Error("expected 2 connected sockets");
      backgroundSocket.data.appState = "background";
      activeSocket.data.appState = "active";

      eventRouter.addConnection("acct_12", {
        connectionType: "user-scoped",
        // biome-ignore lint/suspicious/noExplicitAny: fetchSockets returns RemoteSocket
        socket: backgroundSocket as any,
        accountId: "acct_12",
      });
      eventRouter.addConnection("acct_12", {
        connectionType: "session-scoped",
        // biome-ignore lint/suspicious/noExplicitAny: fetchSockets returns RemoteSocket
        socket: activeSocket as any,
        accountId: "acct_12",
        sessionId: "sess_9",
      });

      expect(await eventRouter.hasActiveNonMachineSocket("acct_12")).toBe(true);
    });

    it("ignores machine-scoped sockets even when they report app-state: active", async () => {
      await connectClient();
      const [machineSocket] = await io.fetchSockets();
      if (!machineSocket) throw new Error("expected a connected server socket");
      machineSocket.data.clientType = "machine-scoped";
      machineSocket.data.appState = "active";

      eventRouter.addConnection("acct_13", {
        connectionType: "machine-scoped",
        // biome-ignore lint/suspicious/noExplicitAny: fetchSockets returns RemoteSocket
        socket: machineSocket as any,
        accountId: "acct_13",
        machineId: "mach_active",
      });

      // The only connection for this account is machine-scoped, so despite reporting
      // app-state: active, it must not count as an "active non-machine socket".
      expect(await eventRouter.hasActiveNonMachineSocket("acct_13")).toBe(false);
    });

    it("returns false when the account has no connected sockets at all", async () => {
      expect(await eventRouter.hasActiveNonMachineSocket("acct_never_connected")).toBe(false);
    });
  });
});
