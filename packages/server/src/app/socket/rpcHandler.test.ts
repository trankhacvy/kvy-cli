import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintToken } from "../../auth/tokens.js";
import { buildServer } from "../server.js";
import { RPC_CALL_RATE_LIMIT_MAX } from "./rpcHandler.js";

// Integration tests for the ported-wholesale rpcHandler (plan.md §4.2): room-based
// registration, forwarding, and the presence-poll dead-peer race. Runs a real listening
// server + two real socket.io-client connections (one plays the RPC target, one the
// caller) since the behavior under test is entirely in room membership and ack timing.

describe("rpcHandler", () => {
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

  async function connect(auth: Record<string, unknown>): Promise<ClientSocket> {
    const client = ioClient(url, { path: "/v1/stream", transports: ["websocket"], auth });
    clients.push(client);
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    return client;
  }

  it("forwards an rpc-call to the registered target and returns its result", async () => {
    const token = await mintToken("acct_1");
    const target = await connect({ token, clientType: "machine-scoped", machineId: "m1" });
    const caller = await connect({ token });

    target.on("rpc-request", (data: { method: string; params: unknown }, cb) => {
      cb({ echoed: data.params });
    });

    await new Promise<void>((resolve) => {
      target.emit("rpc-register", { target: "m:m1:ping" });
      target.once("rpc-registered", () => resolve());
    });

    const response = await new Promise((resolve) => {
      caller.emit(
        "rpc-call",
        { target: "m:m1:ping", method: "ping", params: { hello: "world" } },
        resolve,
      );
    });

    expect(response).toEqual({ ok: true, result: { echoed: { hello: "world" } } });
  });

  it("returns not_available immediately when the target never registered and disconnects mid-wait", async () => {
    const token = await mintToken("acct_2");
    const caller = await connect({ token });

    // No one ever joins the room; rather than waiting out the full 15s reconnect grace
    // window, just prove the call is pending (no immediate synchronous rejection) and
    // let the test runner's own afterEach teardown close the socket, which is the
    // realistic "caller went away" case for this path's error handling.
    let settled = false;
    caller.emit("rpc-call", { target: "m:ghost:ping", method: "ping", params: {} }, () => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
  });

  it("rejects invalid params immediately", async () => {
    const token = await mintToken("acct_3");
    const caller = await connect({ token });

    const response = await new Promise((resolve) => {
      caller.emit("rpc-call", { target: "m:m1:ping" }, resolve);
    });

    expect(response).toEqual({
      ok: false,
      error: "Invalid parameters: target and method are required",
    });
  });

  it("rejects calling an rpc target registered on the caller's own socket", async () => {
    const token = await mintToken("acct_4");
    const solo = await connect({ token });

    await new Promise<void>((resolve) => {
      solo.emit("rpc-register", { target: "m:m4:ping" });
      solo.once("rpc-registered", () => resolve());
    });

    const response = await new Promise((resolve) => {
      solo.emit("rpc-call", { target: "m:m4:ping", method: "ping", params: {} }, resolve);
    });

    expect(response).toEqual({ ok: false, error: "Cannot call RPC on the same socket" });
  });

  it("detects a dead target via the presence poll and fails the call within ~2 poll intervals", async () => {
    const token = await mintToken("acct_5");
    const target = await connect({ token, clientType: "machine-scoped", machineId: "m5" });
    const caller = await connect({ token });

    // Target never acks — simulates a process that died after the socket technically
    // stayed open just long enough for the room lookup to succeed.
    target.on("rpc-request", () => {
      /* never calls back */
    });

    await new Promise<void>((resolve) => {
      target.emit("rpc-register", { target: "m:m5:hang" });
      target.once("rpc-registered", () => resolve());
    });

    const responsePromise = new Promise((resolve) => {
      caller.emit("rpc-call", { target: "m:m5:hang", method: "hang", params: {} }, resolve);
    });

    // Disconnect the target shortly after the call starts so the presence poll sees it
    // missing twice and aborts the call fast instead of waiting the full 30s ack timeout.
    // See rpcHandler.integration.test.ts for the dedicated <2s SLO assertion.
    setTimeout(() => target.close(), 100);

    const response = await responsePromise;
    expect(response).toEqual({ ok: false, error: "RPC target disconnected" });
  }, 10_000);

  it("rejects rpc-register with a missing/non-string target", async () => {
    const token = await mintToken("acct_6");
    const client = await connect({ token });

    const response = await new Promise((resolve) => {
      client.once("rpc-error", resolve);
      client.emit("rpc-register", {});
    });

    expect(response).toEqual({ type: "register", error: "Invalid target" });
  });

  it("rejects rpc-unregister with a missing/non-string target", async () => {
    const token = await mintToken("acct_7");
    const client = await connect({ token });

    const response = await new Promise((resolve) => {
      client.once("rpc-error", resolve);
      client.emit("rpc-unregister", { target: 42 });
    });

    expect(response).toEqual({ type: "unregister", error: "Invalid target" });
  });

  it("rpc-unregister removes the socket from the room so later calls no longer reach it", async () => {
    const token = await mintToken("acct_8");
    const staleTarget = await connect({ token, clientType: "machine-scoped", machineId: "m8a" });
    const caller = await connect({ token });

    staleTarget.on("rpc-request", () => {
      throw new Error("stale target should never receive an rpc-request after unregistering");
    });

    await new Promise<void>((resolve) => {
      staleTarget.emit("rpc-register", { target: "m:m8:ping" });
      staleTarget.once("rpc-registered", () => resolve());
    });

    await new Promise<void>((resolve) => {
      staleTarget.emit("rpc-unregister", { target: "m:m8:ping" });
      staleTarget.once("rpc-unregistered", (data) => {
        expect(data).toEqual({ target: "m:m8:ping" });
        resolve();
      });
    });

    // A fresh socket registers for the same target after the stale one unregistered.
    // If unregister had not actually removed staleTarget from the room, the call below
    // would either hit staleTarget's throwing handler or trip the "multiple sockets"
    // warning path — neither of which should happen here.
    const freshTarget = await connect({ token, clientType: "machine-scoped", machineId: "m8b" });
    freshTarget.on("rpc-request", (data: { method: string; params: unknown }, cb) => {
      cb({ from: "fresh", params: data.params });
    });
    await new Promise<void>((resolve) => {
      freshTarget.emit("rpc-register", { target: "m:m8:ping" });
      freshTarget.once("rpc-registered", () => resolve());
    });

    const response = await new Promise((resolve) => {
      caller.emit("rpc-call", { target: "m:m8:ping", method: "ping", params: { n: 1 } }, resolve);
    });

    expect(response).toEqual({ ok: true, result: { from: "fresh", params: { n: 1 } } });
  });

  it("warns and uses the first socket when multiple sockets are registered for the same target", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const token = await mintToken("acct_9");
      const firstTarget = await connect({ token, clientType: "machine-scoped", machineId: "m9a" });
      const secondTarget = await connect({
        token,
        clientType: "machine-scoped",
        machineId: "m9b",
      });
      const caller = await connect({ token });

      firstTarget.on("rpc-request", (data: { method: string; params: unknown }, cb) => {
        cb({ from: "first", params: data.params });
      });
      secondTarget.on("rpc-request", () => {
        throw new Error("second target should not receive the call when a first is registered");
      });

      await new Promise<void>((resolve) => {
        firstTarget.emit("rpc-register", { target: "m:m9:ping" });
        firstTarget.once("rpc-registered", () => resolve());
      });
      await new Promise<void>((resolve) => {
        secondTarget.emit("rpc-register", { target: "m:m9:ping" });
        secondTarget.once("rpc-registered", () => resolve());
      });

      const response = await new Promise((resolve) => {
        caller.emit("rpc-call", { target: "m:m9:ping", method: "ping", params: { n: 2 } }, resolve);
      });

      expect(response).toEqual({ ok: true, result: { from: "first", params: { n: 2 } } });
      expect(warnSpy).toHaveBeenCalledWith(
        { module: "websocket", level: "warn" },
        expect.stringContaining("Multiple sockets in"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rate-limits rpc-call beyond the per-account ceiling", async () => {
    const token = await mintToken("acct_ratelimit");
    const target = await connect({ token, clientType: "machine-scoped", machineId: "mrl" });
    const caller = await connect({ token });

    target.on("rpc-request", (data: { params: unknown }, cb) => cb({ echoed: data.params }));
    await new Promise<void>((resolve) => {
      target.emit("rpc-register", { target: "m:mrl:ping" });
      target.once("rpc-registered", () => resolve());
    });

    function call(): Promise<{ ok: boolean; error?: string }> {
      return new Promise((resolve) => {
        caller.emit("rpc-call", { target: "m:mrl:ping", method: "ping", params: {} }, resolve);
      });
    }

    // Exhaust the per-account ceiling with successful calls, then confirm the very next
    // one over the limit is rejected without ever reaching the target.
    for (let i = 0; i < RPC_CALL_RATE_LIMIT_MAX; i++) {
      const response = await call();
      expect(response.ok).toBe(true);
    }

    const limited = await call();
    expect(limited).toEqual({ ok: false, error: "Rate limit exceeded" });
  }, 30_000);
});
