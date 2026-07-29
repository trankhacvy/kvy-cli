import type { PGlite } from "@electric-sql/pglite";
import { encodeBase64, getRandomBytes } from "@falcon/crypto";
import type { EncryptedBox } from "@falcon/wire";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { machines, sessions } from "../../db/schema.js";
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
      workspaces: [],
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

// known-issues.md #8: `GET /v1/sync` is one of the two read paths (the
// other is `GET /v1/sessions`) that must never hand back a session claiming
// `status: "active"` once its owning machine has actually gone stale — see
// `app/staleSessions.ts`.
describe("GET /v1/sync — stale-session reconciliation", () => {
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

  it("flips a session to failed in the snapshot once its machine has gone stale, and fans out failed", async () => {
    const machineId = await registerMachine();
    const sessionId = await createSession("sync-stale", machineId);

    const staleAt = new Date(Date.now() - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    await db.update(machines).set({ lastSeenAt: staleAt }).where(eq(machines.id, machineId));
    await db.update(sessions).set({ updatedAt: staleAt }).where(eq(sessions.id, sessionId));

    const ephemerals: unknown[] = [];
    const unsubscribe = eventRouter.onEphemeral((e) => ephemerals.push(e.payload));

    const response = await app.inject({
      method: "GET",
      url: "/v1/sync?since=0",
      headers: { authorization: authHeader },
    });
    unsubscribe();

    const body = response.json();
    const row = body.sessions.find((s: { id: string }) => s.id === sessionId);
    expect(row.status).toBe("failed");
    expect(ephemerals).toContainEqual({ t: "attention", sessionId, kind: "failed" });
    expect(pushDispatcher.calls).toContainEqual({ accountId, sessionId, kind: "failed" });

    const dbRow = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
    expect(dbRow?.status).toBe("failed");
  });

  it("leaves a session active when its machine is still heartbeating recently", async () => {
    const machineId = await registerMachine();
    const sessionId = await createSession("sync-fresh", machineId);

    // Machine just registered — lastSeenAt is recent by default (not stale) —
    // but the session row itself is old, on its own not enough to flip it.
    const oldUpdatedAt = new Date(Date.now() - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    await db.update(sessions).set({ updatedAt: oldUpdatedAt }).where(eq(sessions.id, sessionId));

    const response = await app.inject({
      method: "GET",
      url: "/v1/sync?since=0",
      headers: { authorization: authHeader },
    });

    const body = response.json();
    const row = body.sessions.find((s: { id: string }) => s.id === sessionId);
    expect(row.status).toBe("active");
  });
});
