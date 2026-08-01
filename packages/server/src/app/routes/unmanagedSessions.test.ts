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

async function registerMachine(app: FastifyInstance, authHeader: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers: { authorization: authHeader },
    payload: {
      dek: encodeBase64(getRandomBytes(32)),
      metadata: { value: fakeBox(), expectedVersion: 0 },
    },
  });
  return response.json().id;
}

describe("POST /v1/unmanaged-sessions", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let eventRouter: RecordingEventRouter;
  let authHeader: string;
  let machineId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    eventRouter = new RecordingEventRouter();
    app = await buildServer({ logger: false }, { db, eventRouter });
    const account = await createTestAccount(db);
    authHeader = account.authHeader;
    machineId = await registerMachine(app, authHeader);
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("inserts a new row and fans out unmanaged-new", async () => {
    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));

    const response = await app.inject({
      method: "POST",
      url: "/v1/unmanaged-sessions",
      headers: { authorization: authHeader },
      payload: {
        machineId,
        workspaceId: "ws-1",
        providerRef: "session-abc",
        summary: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    unsubscribe();

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.machineId).toBe(machineId);
    expect(body.workspaceId).toBe("ws-1");
    expect(body.providerRef).toBe("session-abc");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload.body).toMatchObject({ t: "unmanaged-new" });
  });

  it("upserts the same (machineId, providerRef) row and fans out unmanaged-update", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/unmanaged-sessions",
      headers: { authorization: authHeader },
      payload: {
        machineId,
        workspaceId: "ws-2",
        providerRef: "session-xyz",
        summary: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });

    const updates: EmitUpdateParams[] = [];
    const unsubscribe = eventRouter.onUpdate((e) => updates.push(e));

    const response = await app.inject({
      method: "POST",
      url: "/v1/unmanaged-sessions",
      headers: { authorization: authHeader },
      payload: {
        machineId,
        workspaceId: "ws-2-renamed",
        providerRef: "session-xyz",
        summary: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    unsubscribe();

    expect(response.statusCode).toBe(200);
    expect(response.json().workspaceId).toBe("ws-2-renamed");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload.body).toMatchObject({ t: "unmanaged-update" });

    // Still exactly one row for this (machineId, providerRef) pair.
    const rows = await db.query.unmanagedSessions.findMany();
    expect(rows.filter((r) => r.providerRef === "session-xyz")).toHaveLength(1);
  });

  it("404s when machineId doesn't belong to the caller's account", async () => {
    const { authHeader: otherHeader } = await createTestAccount(db);
    const response = await app.inject({
      method: "POST",
      url: "/v1/unmanaged-sessions",
      headers: { authorization: otherHeader },
      payload: {
        machineId,
        workspaceId: "ws-1",
        providerRef: "session-should-fail",
        summary: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    expect(response.statusCode).toBe(404);
  });
});
