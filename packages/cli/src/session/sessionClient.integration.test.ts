import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as IoServer } from "socket.io";
import { io as ioClient } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenProvider } from "../auth/tokenProvider.js";
import type { Logger } from "../logger.js";
import { startSessionClient } from "./sessionClient.js";

 * token — this suite exercises the transport/reconnect behavior, not token renewal
 * (see `sessionClient.test.ts` for the renew-token unit tests), so a fixed token with
 * a `renewIntervalMs` well outside each test's runtime keeps it out of the way. */
function fakeTokenProvider(accessToken = "test-token"): TokenProvider {
  return {
    async getAccessToken() {
      return accessToken;
    },
    async forceRefresh() {
      return accessToken;
    },
    isDead: false,
  };
}

/**
 * Integration test proving the `alive` keepalive and reconnect-after-drop
 * line 688), not just a mocked `Socket`. Runs `sessionClient.ts` against a
 * real `socket.io` server on `/v1/stream` standing in for `packages/server`'s
 * already-merged `startSocket` (exercised end to end in
 * `packages/server/src/app/socket.test.ts`).
 */

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

describe("sessionClient (integration: real socket.io server)", () => {
  let httpServer: HttpServer;
  let io: IoServer;
  let url: string;
  const connectedSessionIds: string[] = [];
  const receivedAlives: { sessionId: string; working: boolean }[] = [];

  beforeEach(async () => {
    connectedSessionIds.length = 0;
    receivedAlives.length = 0;

    httpServer = createServer();
    io = new IoServer(httpServer, { path: "/v1/stream", transports: ["websocket"] });
    io.on("connection", (socket) => {
      connectedSessionIds.push(socket.handshake.auth.sessionId as string);
      socket.on("alive", (payload: { sessionId: string; working: boolean }) => {
        receivedAlives.push(payload);
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("connects with clientType session-scoped and delivers alive keepalives with the live working flag", async () => {
    let working = false;
    const handle = startSessionClient({
      serverUrl: url,
      tokenProvider: fakeTokenProvider(),
      sessionId: "sess_int_1",
      ioFactory: (u, opts) =>
        ioClient(u, { ...opts, reconnectionDelay: 20, reconnectionDelayMax: 40 }),
      logger: silentLogger(),
      aliveIntervalMs: 50,
      renewIntervalMs: 999_000,
      getWorking: () => working,
    });

    await vi.waitFor(() => expect(connectedSessionIds).toEqual(["sess_int_1"]));
    await vi.waitFor(() => expect(receivedAlives.length).toBeGreaterThan(0));
    expect(receivedAlives[0]).toEqual({ sessionId: "sess_int_1", working: false });

    working = true;
    await vi.waitFor(() => expect(receivedAlives.some((a) => a.working === true)).toBe(true));

    handle.stop();
  }, 10_000);

  it("reconnect-after-drop resumes the alive stream under the same sessionId", async () => {
    const handle = startSessionClient({
      serverUrl: url,
      tokenProvider: fakeTokenProvider(),
      sessionId: "sess_int_2",
      ioFactory: (u, opts) =>
        ioClient(u, { ...opts, reconnectionDelay: 20, reconnectionDelayMax: 40 }),
      logger: silentLogger(),
      aliveIntervalMs: 50,
      renewIntervalMs: 999_000,
      getWorking: () => false,
    });

    await vi.waitFor(() => expect(connectedSessionIds).toHaveLength(1));

    // Simulate a dropped connection: force-disconnect every server-side socket.
    for (const socket of await io.fetchSockets()) socket.disconnect(true);

    await vi.waitFor(() => expect(connectedSessionIds).toHaveLength(2), { timeout: 5000 });
    expect(connectedSessionIds).toEqual(["sess_int_2", "sess_int_2"]);

    // Alive keepalives must resume after the reconnect, not just the initial connect.
    const countBeforeWait = receivedAlives.length;
    await vi.waitFor(() => expect(receivedAlives.length).toBeGreaterThan(countBeforeWait));

    handle.stop();
  }, 10_000);
});
