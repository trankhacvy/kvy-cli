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

describe("PUT /v1/sessions/:id/metadata and /state", () => {
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
        tag: "cas-session",
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

  it("updates metadata when expectedVersion matches and fans out session-update", async () => {
    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));

    const response = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/metadata`,
      headers: { authorization: authHeader },
      payload: { expectedVersion: 0, value: fakeBox() },
    });
    unsubscribe();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: 1 });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload.body).toMatchObject({ t: "session-update", id: sessionId });
  });

  it("returns 409 with the current version on a stale expectedVersion", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/metadata`,
      headers: { authorization: authHeader },
      payload: { expectedVersion: 0, value: fakeBox() }, // version is now 1, not 0
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().current.version).toBe(1);
  });

  it("state (agentState) starts null and CASes independently of metadata", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/state`,
      headers: { authorization: authHeader },
      payload: { expectedVersion: 0, value: fakeBox() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: 1 });
  });

  it("404s for a session that doesn't belong to the caller", async () => {
    const { authHeader: otherHeader } = await createTestAccount(db);
    const response = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/metadata`,
      headers: { authorization: otherHeader },
      payload: { expectedVersion: 1, value: fakeBox() },
    });
    expect(response.statusCode).toBe(404);
  });
});
