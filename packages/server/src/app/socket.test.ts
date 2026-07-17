import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintToken } from "../auth/tokens.js";
import { eventRouter } from "./events/eventRouter.js";
import { buildServer } from "./server.js";

// Integration tests for the `/v1/stream` handshake + connection lifecycle (plan.md §4.1).
// Runs a real listening server (Socket.IO needs a real HTTP server to attach to) rather
// than fastify.inject(), and connects real socket.io-client sockets against it.

describe("startSocket (/v1/stream handshake)", () => {
  let app: FastifyInstance;
  let url: string;
  const clients: ClientSocket[] = [];

  beforeEach(async () => {
    app = await buildServer({ logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await app.close();
  });

  function connect(auth: Record<string, unknown>): ClientSocket {
    const client = ioClient(url, { path: "/v1/stream", transports: ["websocket"], auth });
    clients.push(client);
    return client;
  }

  it("rejects a connection with no token", async () => {
    const client = connect({});
    const error = await new Promise<Error>((resolve) => client.once("connect_error", resolve));
    expect(error.message).toBe("Missing authentication token");
  });

  it("rejects an invalid token", async () => {
    const client = connect({ token: "not-a-real-token" });
    const error = await new Promise<Error>((resolve) => client.once("connect_error", resolve));
    expect(error.message).toBe("Invalid authentication token");
  });

  it("rejects a session-scoped client with no sessionId", async () => {
    const token = await mintToken("acct_1");
    const client = connect({ token, clientType: "session-scoped" });
    const error = await new Promise<Error>((resolve) => client.once("connect_error", resolve));
    expect(error.message).toBe("Session ID required for session-scoped clients");
  });

  it("rejects a machine-scoped client with no machineId", async () => {
    const token = await mintToken("acct_1");
    const client = connect({ token, clientType: "machine-scoped" });
    const error = await new Promise<Error>((resolve) => client.once("connect_error", resolve));
    expect(error.message).toBe("Machine ID required for machine-scoped clients");
  });

  it("accepts a valid user-scoped connection", async () => {
    const token = await mintToken("acct_1");
    const client = connect({ token });
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    expect(client.connected).toBe(true);
  });

  it("accepts a valid session-scoped connection with a sessionId", async () => {
    const token = await mintToken("acct_1");
    const client = connect({ token, clientType: "session-scoped", sessionId: "sess_1" });
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    expect(client.connected).toBe(true);
  });

  it("broadcasts machine-presence online/offline to user-scoped peers on connect/disconnect", async () => {
    const token = await mintToken("acct_2");
    const userClient = connect({ token });
    await new Promise<void>((resolve) => userClient.once("connect", () => resolve()));

    const onlineEvent = new Promise((resolve) => userClient.once("ephemeral", resolve));
    const machineClient = connect({ token, clientType: "machine-scoped", machineId: "mach_1" });
    await new Promise<void>((resolve) => machineClient.once("connect", () => resolve()));

    expect(await onlineEvent).toEqual({ t: "machine-presence", machineId: "mach_1", online: true });

    const offlineEvent = new Promise((resolve) => userClient.once("ephemeral", resolve));
    machineClient.close();
    expect(await offlineEvent).toEqual({
      t: "machine-presence",
      machineId: "mach_1",
      online: false,
    });
  });

  it("does not broadcast machine-presence to the machine's own connection", async () => {
    const token = await mintToken("acct_3");
    const machineClient = connect({ token, clientType: "machine-scoped", machineId: "mach_2" });
    let gotEcho = false;
    machineClient.on("ephemeral", () => {
      gotEcho = true;
    });
    await new Promise<void>((resolve) => machineClient.once("connect", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gotEcho).toBe(false);
  });

  it("relays a session-scoped client's 'alive' emit as an 'activity' ephemeral to session watchers", async () => {
    const token = await mintToken("acct_alive");
    const userClient = connect({ token });
    await new Promise<void>((resolve) => userClient.once("connect", () => resolve()));

    const sessionClient = connect({ token, clientType: "session-scoped", sessionId: "sess_alive" });
    await new Promise<void>((resolve) => sessionClient.once("connect", () => resolve()));

    const activityEvent = new Promise((resolve) => userClient.once("ephemeral", resolve));
    sessionClient.volatile.emit("alive", { sessionId: "sess_alive", working: true });

    expect(await activityEvent).toEqual({ t: "activity", sessionId: "sess_alive", working: true });
  });

  it("does not echo the 'activity' ephemeral back to the session client that sent 'alive'", async () => {
    const token = await mintToken("acct_alive_2");
    const sessionClient = connect({
      token,
      clientType: "session-scoped",
      sessionId: "sess_alive_2",
    });
    await new Promise<void>((resolve) => sessionClient.once("connect", () => resolve()));

    let gotEcho = false;
    sessionClient.on("ephemeral", () => {
      gotEcho = true;
    });
    sessionClient.volatile.emit("alive", { sessionId: "sess_alive_2", working: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gotEcho).toBe(false);
  });

  it("defaults app-state to background when omitted from the handshake, then updates it on the app-state event", async () => {
    const token = await mintToken("acct_appstate_1");
    const client = connect({ token });
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));

    // No `appState` was sent in the handshake auth, so socket.ts's default applies:
    // treated as backgrounded until the client explicitly reports otherwise.
    expect(await eventRouter.hasActiveNonMachineSocket("acct_appstate_1")).toBe(false);

    client.emit("app-state", { state: "active" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await eventRouter.hasActiveNonMachineSocket("acct_appstate_1")).toBe(true);

    client.emit("app-state", { state: "background" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await eventRouter.hasActiveNonMachineSocket("acct_appstate_1")).toBe(false);
  });

  it("honors an initial app-state: active sent in the handshake auth", async () => {
    const token = await mintToken("acct_appstate_2");
    const client = connect({ token, appState: "active" });
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));

    expect(await eventRouter.hasActiveNonMachineSocket("acct_appstate_2")).toBe(true);
  });

  // Prometheus ws_connections_active/ws_connections_total wiring (metrics.ts's
  // recordWsConnectionOpened/recordWsConnectionClosed, called from this file's
  // "connection"/"disconnect" handlers). Scrapes the real /metrics route via
  // app.inject() around a real socket.io-client connect + disconnect so the gauge/
  // counter assertions exercise the actual wiring rather than calling the metrics
  // functions directly.
  it("increments ws_connections_active/ws_connections_total on connect and decrements the gauge on disconnect", async () => {
    const scrape = async () => {
      const response = await app.inject({ method: "GET", url: "/metrics" });
      return response.body;
    };

    const before = await scrape();
    const activeBeforeMatch = before.match(/ws_connections_active\{scope="user-scoped"\} (\d+)/);
    const totalBeforeMatch = before.match(/ws_connections_total\{scope="user-scoped"\} (\d+)/);
    const activeBefore = activeBeforeMatch ? Number(activeBeforeMatch[1]) : 0;
    const totalBefore = totalBeforeMatch ? Number(totalBeforeMatch[1]) : 0;

    const token = await mintToken("acct_metrics_1");
    const client = connect({ token });
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));

    const afterConnect = await scrape();
    expect(afterConnect).toContain(
      `ws_connections_active{scope="user-scoped"} ${activeBefore + 1}`,
    );
    expect(afterConnect).toContain(`ws_connections_total{scope="user-scoped"} ${totalBefore + 1}`);

    const disconnected = new Promise<void>((resolve) => client.once("disconnect", () => resolve()));
    client.close();
    await disconnected;
    // socket.io's server-side "disconnect" handler (where recordWsConnectionClosed is
    // called) fires on its own tick after the client-side event above, so give it a
    // beat before scraping again.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const afterDisconnect = await scrape();
    expect(afterDisconnect).toContain(`ws_connections_active{scope="user-scoped"} ${activeBefore}`);
    // The counter is cumulative — it must never decrease.
    expect(afterDisconnect).toContain(
      `ws_connections_total{scope="user-scoped"} ${totalBefore + 1}`,
    );
  });
});
