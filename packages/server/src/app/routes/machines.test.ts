import type { PGlite } from "@electric-sql/pglite";
import { encodeBase64, getRandomBytes } from "@kvy/crypto";
import type { EncryptedBox } from "@kvy/wire";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueSession } from "../../auth/index.js";
import { deviceSessions } from "../../db/schema.js";
import type { EmitUpdateParams } from "../events/eventRouter.js";
import { buildServer } from "../server.js";
import { createTestAccount, createTestDb, RecordingEventRouter } from "./testHelpers.js";

function fakeBox(): EncryptedBox {
  return { t: "enc", v: 1, c: encodeBase64(getRandomBytes(16)) };
}

describe("POST /v1/machines", () => {
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

  it("registers a new machine and fans out machine-new", async () => {
    const updates: EmitUpdateParams[] = [];
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
    expect(updates[0]?.payload.body).toMatchObject({ t: "machine-new" });
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
      payload: {
        dek: encodeBase64(getRandomBytes(32)),
        metadata: { value: fakeBox(), expectedVersion: 0 },
      },
    });
    const machineId = registerResponse.json().id;

    const updates: EmitUpdateParams[] = [];
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
    expect(updates[0]?.payload.body).toMatchObject({ t: "machine-update" });
  });

  it("409s on a stale expectedVersion", async () => {
    const registerResponse = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: {
        dek: encodeBase64(getRandomBytes(32)),
        metadata: { value: fakeBox(), expectedVersion: 0 },
      },
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

  it("409s on a stale daemonState expectedVersion", async () => {
    const registerResponse = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: {
        dek: encodeBase64(getRandomBytes(32)),
        metadata: { value: fakeBox(), expectedVersion: 0 },
        daemonState: { value: fakeBox(), expectedVersion: 0 },
      },
    });
    const machineId = registerResponse.json().id;

    // Bump daemonStateVersion to 1 via a legitimate update.
    await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: {
        machineId,
        metadata: { value: fakeBox(), expectedVersion: 0 },
        daemonState: { value: fakeBox(), expectedVersion: 0 },
      },
    });

    // metadataVersion is now correctly 1, but we send a stale daemonState
    // expectedVersion (0, when the current value is 1) — this must still
    // 409 and must not silently overwrite the daemonState.
    const staleResponse = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: {
        machineId,
        metadata: { value: fakeBox(), expectedVersion: 1 },
        daemonState: { value: fakeBox(), expectedVersion: 0 },
      },
    });

    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.json().current.daemonState.version).toBe(1);
    // metadataVersion must not have been bumped by the rejected update either.
    expect(staleResponse.json().current.metadata.version).toBe(1);
  });

  it("404s updating a machine that doesn't belong to the caller", async () => {
    const registerResponse = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: authHeader },
      payload: {
        dek: encodeBase64(getRandomBytes(32)),
        metadata: { value: fakeBox(), expectedVersion: 0 },
      },
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

  describe("needsReauth", () => {
    it("registers false for a fresh machine, and backfills device_sessions.machineId onto the registering cli-daemon session", async () => {
      const { account } = await createTestAccount(db);
      const daemon = await issueSession(db, { accountId: account.id, clientKind: "cli-daemon" });

      const response = await app.inject({
        method: "POST",
        url: "/v1/machines",
        headers: { authorization: `Bearer ${daemon.accessToken}` },
        payload: {
          dek: encodeBase64(getRandomBytes(32)),
          metadata: { value: fakeBox(), expectedVersion: 0 },
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.needsReauth).toBe(false);

      const [session] = await db
        .select()
        .from(deviceSessions)
        .where(eq(deviceSessions.id, daemon.sessionId));
      expect(session?.machineId).toBe(body.id);
    });

    it("reports needsReauth:true once the registering cli-daemon session is revoked", async () => {
      const { account } = await createTestAccount(db);
      const daemon = await issueSession(db, { accountId: account.id, clientKind: "cli-daemon" });

      const registerResponse = await app.inject({
        method: "POST",
        url: "/v1/machines",
        headers: { authorization: `Bearer ${daemon.accessToken}` },
        payload: {
          dek: encodeBase64(getRandomBytes(32)),
          metadata: { value: fakeBox(), expectedVersion: 0 },
        },
      });
      const machineId = registerResponse.json().id;

      await db
        .update(deviceSessions)
        .set({ revokedAt: new Date() })
        .where(eq(deviceSessions.id, daemon.sessionId));

      // A subsequent update (still authenticated — the access token itself is
      // now reports the machine as needing re-auth.
      const updateResponse = await app.inject({
        method: "POST",
        url: "/v1/machines",
        headers: { authorization: `Bearer ${daemon.accessToken}` },
        payload: { machineId, metadata: { value: fakeBox(), expectedVersion: 0 } },
      });

      expect(updateResponse.statusCode).toBe(200);
      expect(updateResponse.json().needsReauth).toBe(true);
    });
  });
});
