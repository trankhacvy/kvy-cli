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

describe("POST /v1/machines", () => {
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

  it("registers a new machine and fans out machine-new", async () => {
    const updates: UpdateEvent[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));

    const response = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: {
        dek: encodeBase64(getRandomBytes(32)),
        metadata: { value: fakeBox(), expectedVersion: 0 },
      },
    });
    unsubscribe();

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.metadata.version).toBe(0);
    expect(body.daemonState).toBeNull();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update.body).toMatchObject({ t: "machine-new" });
  });

  it("registering without a dek is rejected with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: { metadata: { value: fakeBox(), expectedVersion: 0 } },
    });
    expect(response.statusCode).toBe(400);
  });

  it("updates metadata via CAS and fans out machine-update", async () => {
    const registerResponse = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: { dek: encodeBase64(getRandomBytes(32)), metadata: { value: fakeBox(), expectedVersion: 0 } },
    });
    const machineId = registerResponse.json().id;

    const updates: UpdateEvent[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));

    const updateResponse = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: { machineId, metadata: { value: fakeBox(), expectedVersion: 0 } },
    });
    unsubscribe();

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().metadata.version).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update.body).toMatchObject({ t: "machine-update" });
  });

  it("409s on a stale expectedVersion", async () => {
    const registerResponse = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: { dek: encodeBase64(getRandomBytes(32)), metadata: { value: fakeBox(), expectedVersion: 0 } },
    });
    const machineId = registerResponse.json().id;

    await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: { machineId, metadata: { value: fakeBox(), expectedVersion: 0 } },
    });

    const staleResponse = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: { machineId, metadata: { value: fakeBox(), expectedVersion: 0 } }, // now version 1
    });

    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.json().current.metadata.version).toBe(1);
  });

  it("404s updating a machine that doesn't belong to the caller", async () => {
    const registerResponse = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: { dek: encodeBase64(getRandomBytes(32)), metadata: { value: fakeBox(), expectedVersion: 0 } },
    });
    const machineId = registerResponse.json().id;

    const { authHeader: otherHeader } = await createTestAccount(db);
    const response = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: otherHeader },
      payload: { machineId, metadata: { value: fakeBox(), expectedVersion: 0 } },
    });
    expect(response.statusCode).toBe(404);
  });
});
