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

describe("notification quiet controls (mute-all + per-session mute)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let eventRouter: RecordingEventRouter;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    eventRouter = new RecordingEventRouter();
    app = await buildServer({ logger: false }, { db, eventRouter });
  });

  afterAll(async () => {
    await app.close();
  });

  it("mute-all defaults to false and can be toggled on and off", async () => {
    const { authHeader } = await createTestAccount(db);

    const initial = await app.inject({
      method: "GET",
      url: "/v1/account/notifications-mute",
      headers: { authorization: authHeader },
    });
    expect(initial.json()).toEqual({ mutedAll: false });

    const enabled = await app.inject({
      method: "PUT",
      url: "/v1/account/notifications-mute",
      headers: { authorization: authHeader },
      payload: { mutedAll: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({ mutedAll: true });

    const readBack = await app.inject({
      method: "GET",
      url: "/v1/account/notifications-mute",
      headers: { authorization: authHeader },
    });
    expect(readBack.json()).toEqual({ mutedAll: true });

    const disabled = await app.inject({
      method: "PUT",
      url: "/v1/account/notifications-mute",
      headers: { authorization: authHeader },
      payload: { mutedAll: false },
    });
    expect(disabled.json()).toEqual({ mutedAll: false });
  });

  it("401s on both account routes without a bearer token", async () => {
    const getResponse = await app.inject({ method: "GET", url: "/v1/account/notifications-mute" });
    expect(getResponse.statusCode).toBe(401);

    const putResponse = await app.inject({
      method: "PUT",
      url: "/v1/account/notifications-mute",
      payload: { mutedAll: true },
    });
    expect(putResponse.statusCode).toBe(401);
  });

  it("mutes/unmutes a specific session and fans out a session-update", async () => {
    const { authHeader } = await createTestAccount(db);
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload: {
        tag: "mute-target",
        provider: "claude-code",
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    const sessionId = createResponse.json().id;
    expect(createResponse.json().notificationsMuted).toBe(false);

    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));

    const muteResponse = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/notifications-mute`,
      headers: { authorization: authHeader },
      payload: { muted: true },
    });
    unsubscribe();

    expect(muteResponse.statusCode).toBe(200);
    expect(muteResponse.json()).toEqual({ muted: true });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload.body).toMatchObject({
      t: "session-update",
      id: sessionId,
      notificationsMuted: true,
    });

    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
    });
    const listed = listResponse.json().sessions.find((s: { id: string }) => s.id === sessionId);
    expect(listed.notificationsMuted).toBe(true);
  });

  it("is idempotent: muting an already-muted session doesn't fan out again", async () => {
    const { authHeader } = await createTestAccount(db);
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload: {
        tag: "mute-idempotent",
        provider: "claude-code",
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    const sessionId = createResponse.json().id;

    await app.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/notifications-mute`,
      headers: { authorization: authHeader },
      payload: { muted: true },
    });

    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));

    const second = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/notifications-mute`,
      headers: { authorization: authHeader },
      payload: { muted: true },
    });
    unsubscribe();

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ muted: true });
    expect(updates).toHaveLength(0);
  });

  it("404s muting a session that doesn't belong to the caller", async () => {
    const { authHeader } = await createTestAccount(db);
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload: {
        tag: "mute-other-account",
        provider: "claude-code",
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    const sessionId = createResponse.json().id;

    const { authHeader: otherHeader } = await createTestAccount(db);
    const response = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/notifications-mute`,
      headers: { authorization: otherHeader },
      payload: { muted: true },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s muting a nonexistent session id", async () => {
    const { authHeader } = await createTestAccount(db);
    const response = await app.inject({
      method: "PUT",
      url: "/v1/sessions/does-not-exist/notifications-mute",
      headers: { authorization: authHeader },
      payload: { muted: true },
    });
    expect(response.statusCode).toBe(404);
  });

  it("401s without a bearer token", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/sessions/whatever/notifications-mute",
      payload: { muted: true },
    });
    expect(response.statusCode).toBe(401);
  });
});
