import type { PGlite } from "@electric-sql/pglite";
import { encodeBase64, getRandomBytes } from "@kvy/crypto";
import type { EncryptedBox } from "@kvy/wire";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { machines, sessions } from "../../db/schema.js";
import type { EmitUpdateParams } from "../events/eventRouter.js";
import { buildServer } from "../server.js";
import { STALE_SESSION_MACHINE_WINDOW_MS } from "../staleSessions.js";
import {
  createTestAccount,
  createTestDb,
  RecordingEventRouter,
  RecordingPushDispatcher,
} from "./testHelpers.js";

function fakeBox(): EncryptedBox {
  return { t: "enc", v: 1, c: encodeBase64(getRandomBytes(16)) };
}

describe("POST/GET /v1/sessions", () => {
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

  it("creates a session and fans out session-new exactly once", async () => {
    const updates: EmitUpdateParams[] = [];
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
    expect(updates[0]?.payload.body).toMatchObject({ t: "session-new" });
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

  it("400s when workspaceId doesn't reference an existing workspace for this account", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload: {
        tag: "bad-workspace-id",
        provider: "claude-code",
        // Never a raw filesystem path — must be an opaque `workspaces.id` this
        // account owns. A path (or any other account's workspace id) is rejected.
        workspaceId: "/Users/someone/some-real-project",
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("accepts a workspaceId that references a real workspace owned by this account", async () => {
    const workspaceResponse = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: authHeader },
      payload: {
        pathHash: "session-workspace-hash",
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    const workspaceId = workspaceResponse.json().id;

    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload: {
        tag: "good-workspace-id",
        provider: "claude-code",
        workspaceId,
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().workspaceId).toBe(workspaceId);
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

    const allTags = [...body1.sessions, ...body2.sessions]
      .map((s: { tag: string }) => s.tag)
      .sort();
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

// `GET /v1/sessions` is the paginated list read path — same reconciliation
// contract as `GET /v1/sync`, but this is where it's
// wired up (`app/staleSessions.ts`'s `reconcileStaleSessions`, called from
// `sessions.ts` with a machine-lastSeenAt map it queries itself for just
// the machine ids referenced on the returned page).
describe("GET /v1/sessions — stale-session reconciliation", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let eventRouter: RecordingEventRouter;
  let pushDispatcher: RecordingPushDispatcher;
  let authHeader: string;
  let accountId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    eventRouter = new RecordingEventRouter();
    pushDispatcher = new RecordingPushDispatcher();
    app = await buildServer({ logger: false }, { db, eventRouter, pushDispatcher });
    const account = await createTestAccount(db);
    authHeader = account.authHeader;
    accountId = account.account.id;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  async function registerMachine(): Promise<string> {
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

  async function createSession(tag: string, machineId: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload: {
        tag,
        provider: "claude-code",
        machineId,
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    return response.json().id;
  }

  it("flips a stale-machine, quiet session to failed and fans out session-update + attention + push", async () => {
    const machineId = await registerMachine();
    const sessionId = await createSession("list-stale", machineId);

    const staleAt = new Date(Date.now() - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    await db.update(machines).set({ lastSeenAt: staleAt }).where(eq(machines.id, machineId));
    await db.update(sessions).set({ updatedAt: staleAt }).where(eq(sessions.id, sessionId));

    const updates: EmitUpdateParams[] = [];
    const ephemerals: unknown[] = [];
    const unsubUpdate = eventRouter.onUpdate((e) => updates.push(e));
    const unsubEphemeral = eventRouter.onEphemeral((e) => ephemerals.push(e.payload));

    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
    });
    unsubUpdate();
    unsubEphemeral();

    const row = response.json().sessions.find((s: { id: string }) => s.id === sessionId);
    expect(row.status).toBe("failed");

    expect(updates).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          body: { t: "session-update", id: sessionId, status: "failed" },
        }),
      }),
    );
    expect(ephemerals).toContainEqual({ t: "attention", sessionId, kind: "failed" });
    expect(pushDispatcher.calls).toContainEqual({ accountId, sessionId, kind: "failed" });

    const dbRow = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
    expect(dbRow?.status).toBe("failed");
  });

  it("does not flip a session whose machine is still heartbeating recently", async () => {
    pushDispatcher.calls.length = 0; // reset — a prior test in this describe already dispatched one

    const machineId = await registerMachine();
    const sessionId = await createSession("list-fresh-machine", machineId);

    const oldUpdatedAt = new Date(Date.now() - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    await db.update(sessions).set({ updatedAt: oldUpdatedAt }).where(eq(sessions.id, sessionId));
    // machine.lastSeenAt stays at its just-registered (recent) default.

    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
    });

    const row = response.json().sessions.find((s: { id: string }) => s.id === sessionId);
    expect(row.status).toBe("active");
    expect(pushDispatcher.calls).toHaveLength(0);
  });

  it("does not flip a session with no machine assigned, even if it's very old", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload: {
        tag: "list-no-machine",
        provider: "claude-code",
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    const sessionId = createResponse.json().id;
    const oldUpdatedAt = new Date(Date.now() - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    await db.update(sessions).set({ updatedAt: oldUpdatedAt }).where(eq(sessions.id, sessionId));

    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
    });

    const row = response.json().sessions.find((s: { id: string }) => s.id === sessionId);
    expect(row.status).toBe("active");
  });
});
