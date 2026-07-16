import type { PGlite } from "@electric-sql/pglite";
import { encodeBase64, getRandomBytes } from "@falcon/crypto";
import type { EncryptedBox } from "@falcon/wire";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmitEphemeralParams, EmitUpdateParams } from "../events/eventRouter.js";
import { buildServer } from "../server.js";
import { createTestAccount, createTestDb, RecordingEventRouter } from "./testHelpers.js";

function fakeBox(): EncryptedBox {
  return { t: "enc", v: 1, c: encodeBase64(getRandomBytes(16)) };
}

describe("POST /v1/sessions/:id/status", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let eventRouter: RecordingEventRouter;
  let authHeader: string;
  let sessionId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    eventRouter = new RecordingEventRouter();
    app = await buildServer({ logger: false }, { db, eventRouter });

    const account = await createTestAccount(db);
    authHeader = account.authHeader;

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload: {
        tag: "status-session",
        provider: "claude-code",
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    sessionId = createResponse.json().id;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("marks a fresh session failed and fans out session-update + attention", async () => {
    const updates: EmitUpdateParams[] = [];
    const ephemerals: EmitEphemeralParams[] = [];
    const unsubUpdate = eventRouter.onUpdate((e) => updates.push(e));
    const unsubEphemeral = eventRouter.onEphemeral((e) => ephemerals.push(e));

    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/status`,
      headers: { authorization: authHeader },
      payload: { status: "failed", error: "uncaught exception: boom" },
    });
    unsubUpdate();
    unsubEphemeral();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "failed" });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload.body).toEqual({
      t: "session-update",
      id: sessionId,
      status: "failed",
    });

    expect(ephemerals).toHaveLength(1);
    expect(ephemerals[0]?.payload).toEqual({ t: "attention", sessionId, kind: "failed" });

    const getResponse = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
    });
    const row = getResponse.json().sessions.find((s: { id: string }) => s.id === sessionId);
    expect(row.status).toBe("failed");
  });

  it("is idempotent: a second POST for an already-failed session doesn't fan out again", async () => {
    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));

    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/status`,
      headers: { authorization: authHeader },
      payload: { status: "failed" },
    });
    unsubscribe();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "failed" });
    expect(updates).toHaveLength(0);
  });

  it("404s for a session that doesn't belong to the caller", async () => {
    const { authHeader: otherHeader } = await createTestAccount(db);
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/status`,
      headers: { authorization: otherHeader },
      payload: { status: "failed" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s for a nonexistent session id", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/does-not-exist/status",
      headers: { authorization: authHeader },
      payload: { status: "failed" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("401s without an Authorization header", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/status`,
      payload: { status: "failed" },
    });
    expect(response.statusCode).toBe(401);
  });
});
