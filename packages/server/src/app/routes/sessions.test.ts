import { encodeBase64, getRandomBytes } from "@falcon/crypto";
import type { EncryptedBox } from "@falcon/wire";
import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryEventRouter, type UpdateEvent } from "../eventRouter.js";
import { buildServer } from "../server.js";
import { createTestAccount, createTestDb } from "./testHelpers.js";

function fakeBox(): EncryptedBox {
  return { t: "enc", v: 1, c: encodeBase64(getRandomBytes(16)) };
}

describe("POST/GET /v1/sessions", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let eventRouter: InMemoryEventRouter;
  let authHeader: string;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    eventRouter = new InMemoryEventRouter();
    app = await buildServer({ logger: false }, { db, eventRouter });
    const account = await createTestAccount(db);
    authHeader = account.authHeader;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("creates a session and fans out session-new exactly once", async () => {
    const updates: UpdateEvent[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));

    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload: {
        tag: "create-once",
        provider: "claude-code",
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    unsubscribe();

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.tag).toBe("create-once");
    expect(body.status).toBe("active");
    expect(body.metadata.version).toBe(0);
    expect(body.agentState).toBeNull();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update.body).toMatchObject({ t: "session-new" });
  });

  it("POSTing the same tag twice is idempotent: one row, second call replays 200", async () => {
    const payload = {
      tag: "idempotent-tag",
      provider: "claude-code" as const,
      metadata: fakeBox(),
      dek: encodeBase64(getRandomBytes(32)),
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(first.json().id).toBe(second.json().id);

    const all = await db.query.sessions.findMany();
    expect(all.filter((s: { tag: string }) => s.tag === "idempotent-tag")).toHaveLength(1);
  });

  it("lists sessions for the account, newest first, with cursor pagination", async () => {
    const { authHeader: listHeader } = await createTestAccount(db);
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: { authorization: listHeader },
        payload: {
          tag: `list-${i}`,
          provider: "claude-code",
          metadata: fakeBox(),
          dek: encodeBase64(getRandomBytes(32)),
        },
      });
    }

    const page1 = await app.inject({
      method: "GET",
      url: "/v1/sessions?limit=2",
      headers: { authorization: listHeader },
    });
    const body1 = page1.json();
    expect(body1.sessions).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await app.inject({
      method: "GET",
      url: `/v1/sessions?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
      headers: { authorization: listHeader },
    });
    const body2 = page2.json();
    expect(body2.sessions).toHaveLength(1);

    const allTags = [...body1.sessions, ...body2.sessions].map((s: { tag: string }) => s.tag).sort();
    expect(allTags).toEqual(["list-0", "list-1", "list-2"]);
  });

  it("400s on a malformed cursor", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions?cursor=not-a-real-cursor",
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(400);
  });

  it("401s without a bearer token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/sessions" });
    expect(response.statusCode).toBe(401);
  });
});
