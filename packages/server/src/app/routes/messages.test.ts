import { encodeBase64, getRandomBytes } from "@falcon/crypto";
import type { EncryptedBox } from "@falcon/wire";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionMessages } from "../../db/schema.js";
import { InMemoryEventRouter, type UpdateEvent } from "../eventRouter.js";
import { buildServer } from "../server.js";
import { createTestAccount, createTestDb } from "./testHelpers.js";

function fakeBox(): EncryptedBox {
  return { t: "enc", v: 1, c: encodeBase64(getRandomBytes(16)) };
}

describe("POST/GET /v1/sessions/:id/messages", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let eventRouter: InMemoryEventRouter;
  let authHeader: string;
  let sessionId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    eventRouter = new InMemoryEventRouter();
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
    const updates: UpdateEvent[] = [];
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
      recipientFilter: { type: "session-interested", sessionId },
      update: { body: { t: "message-new", sessionId, msgSeq: 1, localId } },
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

  it("GET paginates with the before/limit msgSeq cursor, newest first", async () => {
    const { authHeader: pageHeader } = await createTestAccount(db);
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: pageHeader },
      payload: { tag: "paging-session", provider: "claude-code", metadata: fakeBox(), dek: encodeBase64(getRandomBytes(32)) },
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
