import type { PGlite } from "@electric-sql/pglite";
import { encodeBase64, getRandomBytes } from "@kvy/crypto";
import type { EncryptedBox } from "@kvy/wire";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionMessages, sessions } from "../../db/schema.js";
import type { EmitUpdateParams } from "../events/eventRouter.js";
import { buildServer } from "../server.js";
import { createTestAccount, createTestDb, RecordingEventRouter } from "./testHelpers.js";

function fakeBox(): EncryptedBox {
  return { t: "enc", v: 1, c: encodeBase64(getRandomBytes(16)) };
}

describe("POST/GET /v1/sessions/:id/messages", () => {
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

    const { authHeader: header } = await createTestAccount(db);
    authHeader = header;

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload: {
        tag: "messages-test-session",
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

  it("POSTing the same localId twice produces exactly one row and one fan-out event", async () => {
    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((event) => updates.push(event));

    const localId = "local-msg-1";
    const content = fakeBox();

    const first = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: { authorization: authHeader },
      payload: { localId, content },
    });
    const second = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: { authorization: authHeader },
      payload: { localId, content },
    });
    unsubscribe();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual({ seq: 1 });
    expect(second.json()).toEqual({ seq: 1 }); // 200-replay, same seq

    const rows = await db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId));
    expect(rows).toHaveLength(1); // exactly one row despite two POSTs

    expect(updates).toHaveLength(1); // exactly one fan-out event
    expect(updates[0]).toMatchObject({
      recipientFilter: { type: "all-interested-in-session", sessionId },
      payload: { body: { t: "message-new", sessionId, msgSeq: 1, localId } },
    });
  });

  it("allocates increasing seq numbers for distinct localIds, in order", async () => {
    const r1 = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: { authorization: authHeader },
      payload: { localId: "seq-a", content: fakeBox() },
    });
    const r2 = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: { authorization: authHeader },
      payload: { localId: "seq-b", content: fakeBox() },
    });

    expect(r2.json().seq).toBe(r1.json().seq + 1);
  });

  it("bumps sessions.updatedAt on a real chat message", async () => {
    const { authHeader: freshHeader } = await createTestAccount(db);
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: freshHeader },
      payload: {
        tag: "updated-at-test-session",
        provider: "claude-code",
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    const freshSessionId = createResponse.json().id;

    const [before] = await db.select().from(sessions).where(eq(sessions.id, freshSessionId));
    if (!before) throw new Error("session row missing after create");

    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${freshSessionId}/messages`,
      headers: { authorization: freshHeader },
      payload: { localId: "updated-at-msg", content: fakeBox() },
    });
    expect(response.statusCode).toBe(200);

    const [after] = await db.select().from(sessions).where(eq(sessions.id, freshSessionId));
    if (!after) throw new Error("session row missing after message post");
    // Not a `toBeGreaterThan`: `before` comes from the DB's own
    // `defaultNow()` and `after` from this write path's `new Date()` — under
    // the PGlite driver these two clock sources land in different timezones
    // (a driver-level quirk distinct from the postgres-js driver's UTC-safe
    // parsing), so only inequality is a safe cross-driver assertion that the
    // column changed at all — which is what the bug was: it never changed.
    expect(after.updatedAt.getTime()).not.toEqual(before.updatedAt.getTime());
  });

  it("404s posting to a session that doesn't belong to the caller", async () => {
    const { authHeader: otherHeader } = await createTestAccount(db);
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: { authorization: otherHeader },
      payload: { localId: "cross-account", content: fakeBox() },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s posting to an unknown session id", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/nonexistent-session-id/messages",
      headers: { authorization: authHeader },
      payload: { localId: "whatever", content: fakeBox() },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s GETing messages for a session that doesn't belong to the caller", async () => {
    const { authHeader: otherHeader } = await createTestAccount(db);
    const response = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: { authorization: otherHeader },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s GETing messages for an unknown session id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions/nonexistent-session-id/messages",
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(404);
  });

  it("GET paginates with the before/limit msgSeq cursor, newest first", async () => {
    const { authHeader: pageHeader } = await createTestAccount(db);
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: pageHeader },
      payload: {
        tag: "paging-session",
        provider: "claude-code",
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    const pagingSessionId = createResponse.json().id;

    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: `/v1/sessions/${pagingSessionId}/messages`,
        headers: { authorization: pageHeader },
        payload: { localId: `page-${i}`, content: fakeBox() },
      });
    }

    const firstPage = await app.inject({
      method: "GET",
      url: `/v1/sessions/${pagingSessionId}/messages?limit=2`,
      headers: { authorization: pageHeader },
    });
    const firstBody = firstPage.json();
    expect(firstBody.messages).toHaveLength(2);
    expect(firstBody.messages.map((m: { seq: number }) => m.seq)).toEqual([5, 4]);
    expect(firstBody.nextBefore).toBe(4);

    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/sessions/${pagingSessionId}/messages?limit=2&before=${firstBody.nextBefore}`,
      headers: { authorization: pageHeader },
    });
    const secondBody = secondPage.json();
    expect(secondBody.messages.map((m: { seq: number }) => m.seq)).toEqual([3, 2]);
  });
});
