import type { AddressInfo } from "node:net";
import type { PGlite } from "@electric-sql/pglite";
import { encodeBase64, getRandomBytes } from "@kvy/crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { issueSession } from "../auth/index.js";
import { encodeBox } from "../db/box.js";
import { accounts, deviceSessions, machines } from "../db/schema.js";

import { eventRouter } from "./events/eventRouter.js";
import { createTestAccount, createTestDb } from "./routes/testHelpers.js";
import { buildServer } from "./server.js";

function fakeBox() {
  return { t: "enc" as const, v: 1 as const, c: encodeBase64(getRandomBytes(16)) };
}

// Runs a real listening server (Socket.IO needs a real HTTP server to attach to) rather
// than fastify.inject(), and connects real socket.io-client sockets against it.

describe("startSocket (/v1/stream handshake)", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let url: string;
  const clients: ClientSocket[] = [];

  // to check `revokedAt`/`expiresAt`, so a token minted here needs a real account +
  // issued session behind it, not just a well-formed JWT — a bare `mintAccessToken` call
  // `id` on the insert lets every existing call site's literal `"acct_1"`-style id keep
  // working unchanged.
  async function mintToken(accountId: string): Promise<string> {
    await db.insert(accounts).values({ id: accountId }).onConflictDoNothing();
    const { accessToken } = await issueSession(db, { accountId, clientKind: "web" });
    return accessToken;
  }

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
  });

  afterAll(async () => {
    await pglite.close();
  });

  beforeEach(async () => {
    app = await buildServer({ logger: false }, { db });
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

  // Without this, `MachineRow.lastSeenAt` in the web's `['sync']` snapshot
  // (fetched once, `staleTime: Infinity`) never advances for a machine that
  // was already connected when the web client loaded — the client's
  // `deriveMachineOnline` heuristic then always reports it offline exactly
  // `MACHINE_ONLINE_WINDOW_MS` after that stale snapshot, regardless of how
  // often the daemon actually heartbeats.
  it("re-broadcasts machine-presence online on every machine-alive heartbeat, not just connect", async () => {
    const token = await mintToken("acct_heartbeat_presence");
    const userClient = connect({ token });
    await new Promise<void>((resolve) => userClient.once("connect", () => resolve()));

    const onlineEvent = new Promise((resolve) => userClient.once("ephemeral", resolve));
    const machineClient = connect({
      token,
      clientType: "machine-scoped",
      machineId: "mach_heartbeat",
    });
    await new Promise<void>((resolve) => machineClient.once("connect", () => resolve()));
    expect(await onlineEvent).toEqual({
      t: "machine-presence",
      machineId: "mach_heartbeat",
      online: true,
    });

    const heartbeatEvent = new Promise((resolve) => userClient.once("ephemeral", resolve));
    machineClient.volatile.emit("machine-alive", { machineId: "mach_heartbeat", time: Date.now() });
    expect(await heartbeatEvent).toEqual({
      t: "machine-presence",
      machineId: "mach_heartbeat",
      online: true,
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

  it("sends an initial machine-presence snapshot to a freshly-connected web client for machines already online", async () => {
    const accountId = "acct_snapshot";
    const token = await mintToken(accountId);
    const [machine] = await db
      .insert(machines)
      .values({ accountId, metadata: encodeBox(fakeBox()), dek: getRandomBytes(32) })
      .returning();
    if (!machine) throw new Error("insert returned no row");

    const machineClient = connect({ token, clientType: "machine-scoped", machineId: machine.id });
    await new Promise<void>((resolve) => machineClient.once("connect", () => resolve()));

    // A SECOND, later-connecting user-scoped client — never saw the
    // machine's own connect-time broadcast above, so without the initial
    // snapshot it would have no live signal for this machine at all until
    // the next heartbeat.
    const userClient = connect({ token });
    const snapshotEvent = new Promise((resolve) => userClient.once("ephemeral", resolve));
    await new Promise<void>((resolve) => userClient.once("connect", () => resolve()));

    expect(await snapshotEvent).toEqual({
      t: "machine-presence",
      machineId: machine.id,
      online: true,
    });
  });

  it("does not send a snapshot entry for a machine that is registered but not currently connected", async () => {
    const accountId = "acct_snapshot_offline";
    const token = await mintToken(accountId);
    await db
      .insert(machines)
      .values({ accountId, metadata: encodeBox(fakeBox()), dek: getRandomBytes(32) })
      .returning();

    const userClient = connect({ token });
    let gotSnapshot = false;
    userClient.on("ephemeral", () => {
      gotSnapshot = true;
    });
    await new Promise<void>((resolve) => userClient.once("connect", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gotSnapshot).toBe(false);
  });

  // AH8 "machine-status-reauth" (docs/auth-ux-hardening-plan.md item 8): a daemon whose
  // `cli-daemon` device session was revoked (e.g. Settings → Devices "log out other
  // devices") can't tell the server anything over its own dead socket — the server infers
  // "needs re-auth" itself, at disconnect, from the revocation it already performed.
  it("a revoked cli-daemon device session's disconnect reports needsReauth:true, distinct from a plain offline", async () => {
    const accountId = "acct_reauth_revoked";
    await db.insert(accounts).values({ id: accountId }).onConflictDoNothing();
    const daemon = await issueSession(db, {
      accountId,
      clientKind: "cli-daemon",
      machineId: "mach_reauth_revoked",
    });

    const userToken = await mintToken(accountId);
    const userClient = connect({ token: userToken });
    await new Promise<void>((resolve) => userClient.once("connect", () => resolve()));

    // Consume the connect-time "online" ephemeral first (same as the plain
    // online/offline test above) — otherwise it's a race whether the `once`
    // below catches this still-undelivered event instead of the real
    // disconnect one.
    const onlineEvent = new Promise((resolve) => userClient.once("ephemeral", resolve));
    const machineClient = connect({
      token: daemon.accessToken,
      clientType: "machine-scoped",
      machineId: "mach_reauth_revoked",
    });
    await new Promise<void>((resolve) => machineClient.once("connect", () => resolve()));
    await onlineEvent;

    // Revoke while the machine is otherwise up — mirrors Settings → Devices revoke.
    await db
      .update(deviceSessions)
      .set({ revokedAt: new Date() })
      .where(eq(deviceSessions.id, daemon.sessionId));

    const offlineEvent = new Promise((resolve) => userClient.once("ephemeral", resolve));
    machineClient.close();
    expect(await offlineEvent).toEqual({
      t: "machine-presence",
      machineId: "mach_reauth_revoked",
      online: false,
      needsReauth: true,
    });
  });

  it("a merely-asleep machine (clean disconnect, no revocation) still shows plain Offline, not needs-reauth", async () => {
    const accountId = "acct_reauth_asleep";
    await db.insert(accounts).values({ id: accountId }).onConflictDoNothing();
    const daemon = await issueSession(db, {
      accountId,
      clientKind: "cli-daemon",
      machineId: "mach_reauth_asleep",
    });

    const userToken = await mintToken(accountId);
    const userClient = connect({ token: userToken });
    await new Promise<void>((resolve) => userClient.once("connect", () => resolve()));

    // Consume the connect-time "online" ephemeral first — see the sibling
    // "revoked" test above for why this matters.
    const onlineEvent = new Promise((resolve) => userClient.once("ephemeral", resolve));
    const machineClient = connect({
      token: daemon.accessToken,
      clientType: "machine-scoped",
      machineId: "mach_reauth_asleep",
    });
    await new Promise<void>((resolve) => machineClient.once("connect", () => resolve()));
    await onlineEvent;

    const offlineEvent = new Promise((resolve) => userClient.once("ephemeral", resolve));
    machineClient.close(); // no revocation — just a dropped connection, e.g. sleep/power-off
    expect(await offlineEvent).toEqual({
      t: "machine-presence",
      machineId: "mach_reauth_asleep",
      online: false,
    });
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

// handler) — a real DB round-trip, so this needs the pglite-backed `db` (unlike the
// describe block above, whose tests never touch persisted state).
describe("machine-alive heartbeat persists machines.lastSeenAt", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let url: string;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    app = await buildServer({ logger: false }, { db });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("bumps the machine row's lastSeenAt to the current time on a machine-alive emit", async () => {
    const account = await createTestAccount(db);
    const staleLastSeenAt = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    const [machine] = await db
      .insert(machines)
      .values({
        accountId: account.account.id,
        metadata: encodeBox(fakeBox()),
        dek: getRandomBytes(32),
        lastSeenAt: staleLastSeenAt,
      })
      .returning();
    if (!machine) throw new Error("insert returned no row");

    const client = ioClient(url, {
      path: "/v1/stream",
      transports: ["websocket"],
      auth: { token: account.token, clientType: "machine-scoped", machineId: machine.id },
    });
    clients.push(client);
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));

    const beforeEmit = Date.now();
    client.volatile.emit("machine-alive", { machineId: machine.id, time: Date.now() });

    // The handler's DB write is async (fire-and-forget from the socket handler's
    // perspective) — poll briefly rather than a fixed sleep, since the write should
    // land almost immediately against an in-memory pglite instance.
    let updated = await db.query.machines.findFirst({ where: eq(machines.id, machine.id) });
    for (let i = 0; i < 20 && updated?.lastSeenAt?.getTime() === staleLastSeenAt.getTime(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      updated = await db.query.machines.findFirst({ where: eq(machines.id, machine.id) });
    }

    expect(updated?.lastSeenAt).not.toBeNull();
    // `lastSeenAt` must be a real `Date`, stored/round-tripped in genuine
    // millisecond epoch time (not seconds, not a raw string) — the exact "correct
    // time unit" this fix has to get right, since a unit mismatch here would silently
    // make every machine look either always-online or always-offline.
    expect(updated?.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(beforeEmit);
    expect(updated?.lastSeenAt?.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("does not update lastSeenAt for a different machine than the authenticated connection's", async () => {
    const account = await createTestAccount(db);
    const staleLastSeenAt = new Date(Date.now() - 60 * 60 * 1000);
    const [ownMachine] = await db
      .insert(machines)
      .values({
        accountId: account.account.id,
        metadata: encodeBox(fakeBox()),
        dek: getRandomBytes(32),
        lastSeenAt: staleLastSeenAt,
      })
      .returning();
    const [otherMachine] = await db
      .insert(machines)
      .values({
        accountId: account.account.id,
        metadata: encodeBox(fakeBox()),
        dek: getRandomBytes(32),
        lastSeenAt: staleLastSeenAt,
      })
      .returning();
    if (!ownMachine || !otherMachine) throw new Error("insert returned no row");

    const client = ioClient(url, {
      path: "/v1/stream",
      transports: ["websocket"],
      auth: { token: account.token, clientType: "machine-scoped", machineId: ownMachine.id },
    });
    clients.push(client);
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));

    // Spoofing a different machineId in the payload must not move the other
    // machine's lastSeenAt — only the authenticated connection's own machineId
    // (`socket.data.machineId`, set at handshake) is ever trusted.
    client.volatile.emit("machine-alive", { machineId: otherMachine.id, time: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const stillStale = await db.query.machines.findFirst({
      where: eq(machines.id, otherMachine.id),
    });
    expect(stillStale?.lastSeenAt?.getTime()).toBe(staleLastSeenAt.getTime());
  });

  // by the (now 15m) access token TTL.
  describe("revocation", () => {
    it("rejects connect for a revoked session, even with an otherwise-valid access token", async () => {
      const accountId = "acct_revoke_connect";
      await db.insert(accounts).values({ id: accountId }).onConflictDoNothing();
      const { accessToken, sessionId } = await issueSession(db, {
        accountId,
        clientKind: "web",
      });
      await db
        .update(deviceSessions)
        .set({ revokedAt: new Date() })
        .where(eq(deviceSessions.id, sessionId));

      const client = ioClient(url, {
        path: "/v1/stream",
        transports: ["websocket"],
        auth: { token: accessToken },
      });
      clients.push(client);
      const error = await new Promise<Error>((resolve) => client.once("connect_error", resolve));
      expect(error.message).toBe("Session revoked");
    });

    it("renew-token keeps a live socket connected with a fresh, non-revoked session", async () => {
      const accountId = "acct_renew_ok";
      await db.insert(accounts).values({ id: accountId }).onConflictDoNothing();
      const first = await issueSession(db, { accountId, clientKind: "web" });
      const client = ioClient(url, {
        path: "/v1/stream",
        transports: ["websocket"],
        auth: { token: first.accessToken },
      });
      clients.push(client);
      await new Promise<void>((resolve) => client.once("connect", () => resolve()));

      const second = await issueSession(db, { accountId, clientKind: "web" });
      const ack = await new Promise<boolean>((resolve) => {
        client.emit("renew-token", second.accessToken, (ok: boolean) => resolve(ok));
      });

      expect(ack).toBe(true);
      // The socket is still the SAME live connection, not a reconnect.
      expect(client.connected).toBe(true);
    });

    it("renew-token rejects (and disconnects) when the new token belongs to a revoked session", async () => {
      const accountId = "acct_renew_revoked";
      await db.insert(accounts).values({ id: accountId }).onConflictDoNothing();
      const first = await issueSession(db, { accountId, clientKind: "web" });
      const client = ioClient(url, {
        path: "/v1/stream",
        transports: ["websocket"],
        auth: { token: first.accessToken },
      });
      clients.push(client);
      await new Promise<void>((resolve) => client.once("connect", () => resolve()));

      const second = await issueSession(db, { accountId, clientKind: "web" });
      await db
        .update(deviceSessions)
        .set({ revokedAt: new Date() })
        .where(eq(deviceSessions.id, second.sessionId));

      const disconnectPromise = new Promise<void>((resolve) =>
        client.once("disconnect", () => resolve()),
      );
      const ack = await new Promise<boolean>((resolve) => {
        client.emit("renew-token", second.accessToken, (ok: boolean) => resolve(ok));
      });

      expect(ack).toBe(false);
      await disconnectPromise;
    });
  });
});
