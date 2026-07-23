import type { PGlite } from "@electric-sql/pglite";
import { encodeBase64, getRandomBytes } from "@falcon/crypto";
import type { EncryptedBox } from "@falcon/wire";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmitUpdateParams } from "../events/eventRouter.js";
import { buildServer } from "../server.js";
import { createTestAccount, createTestDb, RecordingEventRouter } from "./testHelpers.js";

function fakeBox(): EncryptedBox {
  return { t: "enc", v: 1, c: encodeBase64(getRandomBytes(16)) };
}

async function createSession(
  app: FastifyInstance,
  authHeader: string,
  tag: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { authorization: authHeader },
    payload: {
      tag,
      provider: "claude-code",
      metadata: fakeBox(),
      dek: encodeBase64(getRandomBytes(32)),
    },
  });
  return response.json().id;
}

describe("POST /v1/sessions/:id/archive", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let eventRouter: RecordingEventRouter;
  let authHeader: string;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    eventRouter = new RecordingEventRouter();
    app = await buildServer({ logger: false }, { db, eventRouter });
    const account = await createTestAccount(db);
    authHeader = account.authHeader;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("archives a session and fans out session-update", async () => {
    const sessionId = await createSession(app, authHeader, "archive-session");
    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));

    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/archive`,
      headers: { authorization: authHeader },
    });
    unsubscribe();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "archived" });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload.body).toEqual({
      t: "session-update",
      id: sessionId,
      status: "archived",
    });

    const getResponse = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
    });
    const row = getResponse.json().sessions.find((s: { id: string }) => s.id === sessionId);
    expect(row.status).toBe("archived");
  });

  it("is idempotent: a second archive doesn't fan out again", async () => {
    const sessionId = await createSession(app, authHeader, "archive-session-2");
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/archive`,
      headers: { authorization: authHeader },
    });

    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/archive`,
      headers: { authorization: authHeader },
    });
    unsubscribe();

    expect(response.statusCode).toBe(200);
    expect(updates).toHaveLength(0);
  });

  it("404s for a session that doesn't belong to the caller", async () => {
    const sessionId = await createSession(app, authHeader, "archive-session-3");
    const { authHeader: otherHeader } = await createTestAccount(db);
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/archive`,
      headers: { authorization: otherHeader },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s for a nonexistent session id", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/does-not-exist/archive",
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(404);
  });

  it("401s without an Authorization header", async () => {
    const sessionId = await createSession(app, authHeader, "archive-session-4");
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/archive`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /v1/sessions/:id/unarchive", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let eventRouter: RecordingEventRouter;
  let authHeader: string;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    eventRouter = new RecordingEventRouter();
    app = await buildServer({ logger: false }, { db, eventRouter });
    const account = await createTestAccount(db);
    authHeader = account.authHeader;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("restores an archived session to active and fans out session-update", async () => {
    const sessionId = await createSession(app, authHeader, "unarchive-session");
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/archive`,
      headers: { authorization: authHeader },
    });

    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/unarchive`,
      headers: { authorization: authHeader },
    });
    unsubscribe();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "active" });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload.body).toEqual({
      t: "session-update",
      id: sessionId,
      status: "active",
    });

    const getResponse = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
    });
    const row = getResponse.json().sessions.find((s: { id: string }) => s.id === sessionId);
    expect(row.status).toBe("active");
  });

  it("is idempotent: a second unarchive doesn't fan out again", async () => {
    const sessionId = await createSession(app, authHeader, "unarchive-session-2");
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/archive`,
      headers: { authorization: authHeader },
    });
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/unarchive`,
      headers: { authorization: authHeader },
    });

    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/unarchive`,
      headers: { authorization: authHeader },
    });
    unsubscribe();

    expect(response.statusCode).toBe(200);
    expect(updates).toHaveLength(0);
  });

  it("leaves a non-archived row untouched and reports its honest status", async () => {
    const sessionId = await createSession(app, authHeader, "unarchive-session-3");
    // Never archived — status is "active" already.
    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/unarchive`,
      headers: { authorization: authHeader },
    });
    unsubscribe();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "active" });
    expect(updates).toHaveLength(0);
  });

  it("404s for a session that doesn't belong to the caller", async () => {
    const sessionId = await createSession(app, authHeader, "unarchive-session-4");
    const { authHeader: otherHeader } = await createTestAccount(db);
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/unarchive`,
      headers: { authorization: otherHeader },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s for a nonexistent session id", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/does-not-exist/unarchive",
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(404);
  });

  it("401s without an Authorization header", async () => {
    const sessionId = await createSession(app, authHeader, "unarchive-session-5");
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/unarchive`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("DELETE /v1/sessions/:id", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let eventRouter: RecordingEventRouter;
  let authHeader: string;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    eventRouter = new RecordingEventRouter();
    app = await buildServer({ logger: false }, { db, eventRouter });
    const account = await createTestAccount(db);
    authHeader = account.authHeader;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("deletes a session and fans out session-delete", async () => {
    const sessionId = await createSession(app, authHeader, "delete-session");
    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));

    const response = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${sessionId}`,
      headers: { authorization: authHeader },
    });
    unsubscribe();

    expect(response.statusCode).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload.body).toEqual({ t: "session-delete", id: sessionId });

    const getResponse = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
    });
    expect(getResponse.json().sessions.some((s: { id: string }) => s.id === sessionId)).toBe(false);
  });

  it("404s for a session that doesn't belong to the caller", async () => {
    const sessionId = await createSession(app, authHeader, "delete-session-2");
    const { authHeader: otherHeader } = await createTestAccount(db);
    const response = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${sessionId}`,
      headers: { authorization: otherHeader },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s for a nonexistent session id", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/v1/sessions/does-not-exist",
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(404);
  });

  it("401s without an Authorization header", async () => {
    const sessionId = await createSession(app, authHeader, "delete-session-3");
    const response = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${sessionId}`,
    });
    expect(response.statusCode).toBe(401);
  });
});
