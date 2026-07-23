import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintAccessToken } from "../../auth/tokens.js";

function mintToken(accountId: string): Promise<string> {
  return mintAccessToken({ accountId, sessionId: `sess_${accountId}`, clientKind: "web" });
}
import { buildServer } from "../server.js";

// RPC integration tests (plan.md §16 "4.4 Hardening & release gate": "RPC integration
// tests: dead-daemon fast-fail <2s, reconnect storm, double-takeover race"; falcon-
// system-design.md §13 item 5: "dead-peer fast-fail (<2s), reconnect grace, presence
// flap"). `rpcHandler.test.ts` already covers the room-registration/forwarding/
// rate-limit unit surface; this file is dedicated to the two server-side scenarios that
// need real timing and a real multi-connection storm to say anything meaningful:
//
// 1. Dead-daemon fast-fail: when the RPC target dies *during* an outstanding call, the
//    caller must be told within ~2s (Happy's own postmortem-hardened design measured
//    1.6s against a real 2-replica cluster — happy-research.md §7/§11.3), not the full
//    30s ack timeout. This is `rpcHandler.ts`'s presence-poll race.
// 2. Reconnect storm: a machine-scoped client that reconnects many times in rapid
//    succession (network flap, laptop sleep/wake, daemon restart loop) must never leave
//    stale room memberships behind or cause a caller's RPC to be delivered more than
//    once — room membership is the only source of truth (no TTLs, no registry state;
//    see rpcHandler.ts's header comment), so a leak here would silently accumulate
//    forever.
describe("rpcHandler (integration: dead-daemon fast-fail + reconnect storm)", () => {
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
    const client = ioClient(url, {
      path: "/v1/stream",
      transports: ["websocket"],
      auth,
      // This suite drives reconnection manually (storm test) or wants a clean, immediate
      // "gone" signal (dead-daemon test) — the client's own automatic-reconnection noise
      // would otherwise interfere with both.
      reconnection: false,
    });
    clients.push(client);
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    return client;
  }

  function registerTarget(client: ClientSocket, target: string): Promise<void> {
    return new Promise<void>((resolve) => {
      client.emit("rpc-register", { target });
      client.once("rpc-registered", () => resolve());
    });
  }

  it("fails a call within 2s of the target dying mid-call, instead of waiting out the 30s ack timeout", async () => {
    const token = await mintToken("acct_deadpeer");
    const target = await connect({ token, clientType: "machine-scoped", machineId: "m_dead" });
    const caller = await connect({ token });

    // Never acks — simulates a daemon process that dies mid-turn, after the room lookup
    // already succeeded but before it could respond.
    target.on("rpc-request", () => {
      /* never calls back */
    });
    await registerTarget(target, "m:m_dead:hang");

    const responsePromise = new Promise((resolve) => {
      caller.emit("rpc-call", { target: "m:m_dead:hang", method: "hang", params: {} }, resolve);
    });

    // Give the call a moment to actually start (room lookup + emitWithAck dispatched)
    // before killing the target, so this measures "died mid-call", not "was already
    // dead" (that's the separate, deliberately generous 15s reconnect-grace path).
    await new Promise((resolve) => setTimeout(resolve, 100));
    const killedAt = Date.now();
    target.close();

    const response = await responsePromise;
    const elapsedMs = Date.now() - killedAt;

    expect(response).toEqual({ ok: false, error: "RPC target disconnected" });
    expect(elapsedMs).toBeLessThan(2000);
  }, 10_000);

  it("survives 25 rapid reconnects without leaking stale room members or double-delivering a call", async () => {
    const token = await mintToken("acct_storm");
    const caller = await connect({ token });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const target = "m:m_storm:ping";
    let liveSocket: ClientSocket | null = null;
    let deliveryCount = 0;

    try {
      for (let i = 0; i < 25; i++) {
        // Tear down the previous connection *before* the new one is up, mirroring a real
        // flaky-network/daemon-restart storm rather than a clean handoff.
        liveSocket?.close();

        const machine = ioClient(url, {
          path: "/v1/stream",
          transports: ["websocket"],
          auth: { token, clientType: "machine-scoped", machineId: "m_storm" },
          reconnection: false,
        });
        clients.push(machine);
        await new Promise<void>((resolve) => machine.once("connect", () => resolve()));

        machine.on("rpc-request", (data: { params: unknown }, cb) => {
          deliveryCount++;
          cb({ echoed: data.params, iteration: i });
        });
        await registerTarget(machine, target);

        liveSocket = machine;
      }

      // Only the final connection from the storm should be a live room member — an rpc-
      // call now must reach it exactly once, not the ghost of an earlier iteration and
      // not more than one delivery.
      const response = await new Promise((resolve) => {
        caller.emit("rpc-call", { target, method: "ping", params: { n: 1 } }, resolve);
      });

      expect(response).toEqual({ ok: true, result: { echoed: { n: 1 }, iteration: 24 } });
      expect(deliveryCount).toBe(1);
      // A leaked stale socket still sitting in the room would have tripped rpcHandler's
      // "Multiple sockets in <room>" warning path at some point during the storm.
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  }, 20_000);
});
