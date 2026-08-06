import type { PGlite } from "@electric-sql/pglite";
import { encodeBase64, getRandomBytes } from "@kvy/crypto";
import type { EncryptedBox } from "@kvy/wire";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmitUpdateParams } from "../events/eventRouter.js";
import { buildServer } from "../server.js";
import { createTestAccount, createTestDb, RecordingEventRouter } from "./testHelpers.js";

function fakeBox(): EncryptedBox {
  return { t: "enc", v: 1, c: encodeBase64(getRandomBytes(16)) };
}

function createPayload(pathHash: string) {
  return {
    pathHash,
    metadata: fakeBox(),
    dek: encodeBase64(getRandomBytes(32)),
  };
}

describe("POST /v1/workspaces", () => {
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

  it("creates a workspace by pathHash and never echoes back a real path field", async () => {
    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));

    const response = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: authHeader },
      payload: createPayload("hash-of-a-real-path"),
    });
    unsubscribe();

    expect(response.statusCode).toBe(201);
    const body = response.json();
    // `pathHash` is fine to echo back (meaningless without `workspaceIndexKey`,
    // which only this account's own devices hold) — `path` never is.
    expect(body).not.toHaveProperty("path");
    expect(body.pathHash).toBe("hash-of-a-real-path");
    expect(typeof body.id).toBe("string");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload.body).toMatchObject({ t: "workspace-new" });
  });

  it("POSTing the same pathHash twice is idempotent: one row, second call replays 200", async () => {
    const payload = createPayload("idempotent-hash");

    const first = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: authHeader },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: authHeader },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(first.json().id).toBe(second.json().id);
  });

  it("different pathHashes for the same account create distinct workspaces", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: authHeader },
      payload: createPayload("hash-a"),
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: authHeader },
      payload: createPayload("hash-b"),
    });

    expect(first.json().id).not.toBe(second.json().id);
  });
});
