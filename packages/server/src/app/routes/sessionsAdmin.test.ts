import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { issueSession as issueSessionRaw } from "../../auth/index.js";
import * as schema from "../../db/schema.js";
import { accounts, authIdentities } from "../../db/schema.js";
import { buildServer } from "../server.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

/**
 * Exercises the sessions-admin routes end-to-end against a REAL Socket.IO server + real
 * not just asserting a disconnect closure was called with the right arguments.
 */
describe("sessions-admin routes", () => {
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: FastifyInstance;
  let url: string;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    pglite = new PGlite();
    db = drizzle(pglite, { schema });
    await migrate(db, { migrationsFolder });
    app = await buildServer({ logger: false }, { db });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  // `issueSession` FK's `device_sessions.accountId` to a real `accounts` row —
  // this wrapper ensures one exists (idempotent) for whatever literal account id a
  // test wants to use, then issues a session for it exactly like the real routes do.
  async function issueSession(params: Parameters<typeof issueSessionRaw>[1]) {
    await db.insert(accounts).values({ id: params.accountId }).onConflictDoNothing();
    return issueSessionRaw(db, params);
  }

  function connectSocket(token: string): ClientSocket {
    const client = ioClient(url, {
      path: "/v1/stream",
      transports: ["websocket"],
      auth: { token },
    });
    clients.push(client);
    return client;
  }

  it("GET /v1/auth/sessions lists this account's active sessions, marking the caller's own", async () => {
    const accountId = "acct_sessions_list";
    const first = await issueSession({ accountId, clientKind: "web", label: "Browser A" });
    await issueSession({ accountId, clientKind: "cli-daemon", label: "Daemon on laptop" });

    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: { authorization: `Bearer ${first.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { sessions: Array<{ id: string; isCurrent: boolean }> };
    expect(body.sessions).toHaveLength(2);
    const current = body.sessions.find((s) => s.id === first.sessionId);
    expect(current?.isCurrent).toBe(true);
    expect(body.sessions.filter((s) => s.isCurrent)).toHaveLength(1);
  });

  it("GET /v1/auth/sessions returns null email for an account with no auth_identities row", async () => {
    const accountId = "acct_sessions_no_identity";
    const session = await issueSession({ accountId, clientKind: "web" });

    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().email).toBeNull();
  });

  it("GET /v1/auth/sessions surfaces the account's captured email (issue-6 read path)", async () => {
    const accountId = "acct_sessions_with_email";
    const session = await issueSession({ accountId, clientKind: "web" });
    await db.insert(authIdentities).values({
      accountId,
      kind: "google",
      identifier: "google-sub-1",
      email: "user@example.com",
      emailVerified: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().email).toBe("user@example.com");
  });

  it("GET /v1/auth/sessions surfaces the identity kind and account creation date", async () => {
    const accountId = "acct_sessions_identity_kind";
    const session = await issueSession({ accountId, clientKind: "web" });
    await db.insert(authIdentities).values({
      accountId,
      kind: "github",
      identifier: "github-sub-1",
      email: "dev@example.com",
      emailVerified: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    const body = response.json();
    expect(body.identityKind).toBe("github");
    expect(typeof body.accountCreatedAt).toBe("string");
  });

  it("GET /v1/auth/sessions surfaces the identity's avatar image", async () => {
    const accountId = "acct_sessions_with_image";
    const session = await issueSession({ accountId, clientKind: "web" });
    await db.insert(authIdentities).values({
      accountId,
      kind: "google",
      identifier: "google-sub-2",
      email: "img@example.com",
      emailVerified: true,
      image: "https://example.com/avatar.png",
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    expect(response.json().image).toBe("https://example.com/avatar.png");
  });

  it("GET /v1/auth/sessions returns null identityKind for an account with no auth_identities row", async () => {
    const accountId = "acct_sessions_no_identity_kind";
    const session = await issueSession({ accountId, clientKind: "web" });

    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    expect(response.json().identityKind).toBeNull();
  });

  it("POST /v1/auth/sessions/:id/revoke revokes the row AND disconnects its live socket immediately", async () => {
    const accountId = "acct_sessions_revoke";
    const caller = await issueSession({ accountId, clientKind: "web" });
    const target = await issueSession({ accountId, clientKind: "cli-daemon" });

    const targetSocket = connectSocket(target.accessToken);
    await new Promise<void>((resolve) => targetSocket.once("connect", () => resolve()));
    expect(targetSocket.connected).toBe(true);

    const disconnected = new Promise<void>((resolve) =>
      targetSocket.once("disconnect", () => resolve()),
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/auth/sessions/${target.sessionId}/revoke`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    await disconnected; // proves immediacy — not bounded by the access token's own TTL

    // The revoked session's refresh token is dead too.
    const refreshResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: target.refreshToken },
    });
    expect(refreshResponse.statusCode).toBe(401);
  });

  it("PATCH /v1/auth/sessions/:id renames a session's label", async () => {
    const accountId = "acct_sessions_rename";
    const caller = await issueSession({ accountId, clientKind: "web" });
    const target = await issueSession({ accountId, clientKind: "cli-daemon" });

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/auth/sessions/${target.sessionId}`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
      payload: { label: "My laptop" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, label: "My laptop" });

    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });
    const renamed = listResponse
      .json()
      .sessions.find((s: { id: string }) => s.id === target.sessionId);
    expect(renamed?.label).toBe("My laptop");
  });

  it("PATCH /v1/auth/sessions/:id trims whitespace and rejects a blank label", async () => {
    const accountId = "acct_sessions_rename_blank";
    const caller = await issueSession({ accountId, clientKind: "web" });

    const padded = await app.inject({
      method: "PATCH",
      url: `/v1/auth/sessions/${caller.sessionId}`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
      payload: { label: "  Padded  " },
    });
    expect(padded.statusCode).toBe(200);
    expect(padded.json().label).toBe("Padded");

    const blank = await app.inject({
      method: "PATCH",
      url: `/v1/auth/sessions/${caller.sessionId}`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
      payload: { label: "   " },
    });
    expect(blank.statusCode).toBe(400);
  });

  it("404s renaming a session that doesn't belong to the caller", async () => {
    const caller = await issueSession({ accountId: "acct_rename_caller", clientKind: "web" });
    const other = await issueSession({ accountId: "acct_rename_other", clientKind: "web" });

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/auth/sessions/${other.sessionId}`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
      payload: { label: "Not mine" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("POST /v1/auth/sessions/current/revoke revokes the caller's own session and disconnects it", async () => {
    const accountId = "acct_sessions_current_revoke";
    const caller = await issueSession({ accountId, clientKind: "web" });

    const callerSocket = connectSocket(caller.accessToken);
    await new Promise<void>((resolve) => callerSocket.once("connect", () => resolve()));

    const disconnected = new Promise<void>((resolve) =>
      callerSocket.once("disconnect", () => resolve()),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/sessions/current/revoke",
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    await disconnected;

    const refreshResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: caller.refreshToken },
    });
    expect(refreshResponse.statusCode).toBe(401);
  });

  it("404s revoking a session that doesn't belong to the caller", async () => {
    const caller = await issueSession({ accountId: "acct_revoke_caller", clientKind: "web" });
    const other = await issueSession({ accountId: "acct_revoke_other", clientKind: "web" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/auth/sessions/${other.sessionId}/revoke`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it("POST /v1/auth/sessions/revoke-others revokes every OTHER session and disconnects them, leaving the caller's own alone", async () => {
    const accountId = "acct_revoke_others";
    const caller = await issueSession({ accountId, clientKind: "web" });
    const otherA = await issueSession({ accountId, clientKind: "cli-daemon" });
    const otherB = await issueSession({ accountId, clientKind: "cli-session" });

    const callerSocket = connectSocket(caller.accessToken);
    const otherASocket = connectSocket(otherA.accessToken);
    await Promise.all([
      new Promise<void>((resolve) => callerSocket.once("connect", () => resolve())),
      new Promise<void>((resolve) => otherASocket.once("connect", () => resolve())),
    ]);

    const otherADisconnected = new Promise<void>((resolve) =>
      otherASocket.once("disconnect", () => resolve()),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/sessions/revoke-others",
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, revoked: 2 });
    await otherADisconnected;

    // otherB (never connected) is also revoked at the DB/refresh level.
    const otherBRefresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: otherB.refreshToken },
    });
    expect(otherBRefresh.statusCode).toBe(401);

    // The caller's own session is untouched — still connected, still refreshable.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callerSocket.connected).toBe(true);
    const callerRefresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: caller.refreshToken },
    });
    expect(callerRefresh.statusCode).toBe(200);
  });
});
