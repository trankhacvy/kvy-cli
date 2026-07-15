import type { PGlite } from "@electric-sql/pglite";
import { encodeBase64, getRandomBytes } from "@falcon/crypto";
import type { EncryptedBox } from "@falcon/wire";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { createTestAccount, createTestDb } from "./testHelpers.js";

function fakeBox(): EncryptedBox {
  return { t: "enc", v: 1, c: encodeBase64(getRandomBytes(16)) };
}

describe("GET /v1/sync", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let authHeader: string;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    app = await buildServer({ logger: false }, { db });
    const account = await createTestAccount(db);
    authHeader = account.authHeader;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("returns an empty snapshot with headerSeq 0 for a fresh account", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/sync?since=0",
      headers: { authorization: authHeader },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      headerSeq: 0,
      sessions: [],
      machines: [],
      unmanagedSessions: [],
    });
  });

  it("reflects sessions/machines created after headerSeq bumps", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload: {
        tag: "sync-session",
        provider: "claude-code",
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: {
        dek: encodeBase64(getRandomBytes(32)),
        metadata: { value: fakeBox(), expectedVersion: 0 },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/sync?since=0",
      headers: { authorization: authHeader },
    });

    const body = response.json();
    expect(body.headerSeq).toBe(2); // one bump per structural create
    expect(body.sessions).toHaveLength(1);
    expect(body.machines).toHaveLength(1);
  });

  it("401s without a bearer token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/sync?since=0" });
    expect(response.statusCode).toBe(401);
  });
});
