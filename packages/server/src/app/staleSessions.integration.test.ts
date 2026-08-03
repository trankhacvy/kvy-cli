import { EventEmitter } from "node:events";
import type { PGlite } from "@electric-sql/pglite";
import { getRandomBytes } from "@kvy/crypto";
import type { EncryptedBox } from "@kvy/wire";
import { eq } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeBox } from "../db/box.js";
import { machines, sessions } from "../db/schema.js";
import {
  createTestAccount,
  createTestDb,
  RecordingEventRouter,
  RecordingPushDispatcher,
} from "./routes/testHelpers.js";
import { reconcileStaleSessions, STALE_SESSION_MACHINE_WINDOW_MS } from "./staleSessions.js";

function fakeBox(): EncryptedBox {
  return { t: "enc", v: 1, c: Buffer.from(getRandomBytes(16)).toString("base64") };
}

/** Minimal FastifyReply double: only `.raw` (a real EventEmitter) is ever
 * touched by `reconcileStaleSessions`' `reply.raw.once("finish", ...)`
 * post-commit fan-out hook — the same hook every other write route in
 * `app/routes/*` uses. Real routes get this from Fastify/light-my-request
 * for free; this direct unit test constructs it manually and fires
 * `finish` itself once `reconcileStaleSessions` resolves, mirroring what
 * Fastify does after the response is actually sent. */
function fakeReply(): FastifyReply {
  return { raw: new EventEmitter() } as unknown as FastifyReply;
}

describe("reconcileStaleSessions", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let accountId: string;

  beforeEach(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    const account = await createTestAccount(db);
    accountId = account.account.id;
  });

  afterEach(async () => {
    await pglite.close();
  });

  async function insertMachine(lastSeenAt: Date | null) {
    const [machine] = await db
      .insert(machines)
      .values({
        accountId,
        metadata: encodeBox(fakeBox()),
        dek: getRandomBytes(32),
        lastSeenAt,
      })
      .returning();
    if (!machine) throw new Error("insertMachine: no row returned");
    return machine;
  }

  async function insertSession(params: { machineId: string | null; updatedAt: Date }) {
    const [session] = await db
      .insert(sessions)
      .values({
        accountId,
        machineId: params.machineId,
        tag: `stale-test-${Math.random()}`,
        provider: "claude-code",
        metadata: encodeBox(fakeBox()),
        dek: getRandomBytes(32),
        updatedAt: params.updatedAt,
      })
      .returning();
    if (!session) throw new Error("insertSession: no row returned");
    return session;
  }

  it("flips a session to failed when its machine is stale and the session is quiet, fanning out session-update + attention + push", async () => {
    const staleAt = new Date(Date.now() - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    const machine = await insertMachine(staleAt);
    const session = await insertSession({ machineId: machine.id, updatedAt: staleAt });

    const eventRouter = new RecordingEventRouter();
    const pushDispatcher = new RecordingPushDispatcher();
    const reply = fakeReply();

    const [result] = await reconcileStaleSessions(
      db,
      eventRouter,
      pushDispatcher,
      reply,
      accountId,
      [session],
      new Map([[machine.id, machine.lastSeenAt]]),
    );
    reply.raw.emit("finish");

    expect(result?.status).toBe("failed");

    const dbRow = await db.query.sessions.findFirst({ where: eq(sessions.id, session.id) });
    expect(dbRow?.status).toBe("failed");

    expect(pushDispatcher.calls).toEqual([{ accountId, sessionId: session.id, kind: "failed" }]);
  });

  it("emits session-update and an attention ephemeral for the flipped session, same shape as POST .../status", async () => {
    const staleAt = new Date(Date.now() - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    const machine = await insertMachine(staleAt);
    const session = await insertSession({ machineId: machine.id, updatedAt: staleAt });

    const eventRouter = new RecordingEventRouter();
    const pushDispatcher = new RecordingPushDispatcher();
    const reply = fakeReply();

    const updates: unknown[] = [];
    const ephemerals: unknown[] = [];
    eventRouter.onUpdate((e) => updates.push(e.payload.body));
    eventRouter.onEphemeral((e) => ephemerals.push(e.payload));

    await reconcileStaleSessions(
      db,
      eventRouter,
      pushDispatcher,
      reply,
      accountId,
      [session],
      new Map([[machine.id, machine.lastSeenAt]]),
    );
    reply.raw.emit("finish");

    expect(updates).toEqual([{ t: "session-update", id: session.id, status: "failed" }]);
    expect(ephemerals).toEqual([{ t: "attention", sessionId: session.id, kind: "failed" }]);
  });

  it("does NOT flip a session whose machine has heartbeated recently", async () => {
    const recentlyAt = new Date(Date.now() - 30_000);
    const staleUpdatedAt = new Date(Date.now() - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    const machine = await insertMachine(recentlyAt);
    const session = await insertSession({ machineId: machine.id, updatedAt: staleUpdatedAt });

    const eventRouter = new RecordingEventRouter();
    const pushDispatcher = new RecordingPushDispatcher();
    const reply = fakeReply();

    const [result] = await reconcileStaleSessions(
      db,
      eventRouter,
      pushDispatcher,
      reply,
      accountId,
      [session],
      new Map([[machine.id, machine.lastSeenAt]]),
    );
    reply.raw.emit("finish");

    expect(result?.status).toBe("active");
    const dbRow = await db.query.sessions.findFirst({ where: eq(sessions.id, session.id) });
    expect(dbRow?.status).toBe("active");
    expect(pushDispatcher.calls).toHaveLength(0);
  });

  it("does NOT flip a session that's been touched recently, even if its machine looks stale", async () => {
    const staleAt = new Date(Date.now() - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    const recentlyAt = new Date(Date.now() - 1_000);
    const machine = await insertMachine(staleAt);
    const session = await insertSession({ machineId: machine.id, updatedAt: recentlyAt });

    const eventRouter = new RecordingEventRouter();
    const pushDispatcher = new RecordingPushDispatcher();
    const reply = fakeReply();

    const [result] = await reconcileStaleSessions(
      db,
      eventRouter,
      pushDispatcher,
      reply,
      accountId,
      [session],
      new Map([[machine.id, machine.lastSeenAt]]),
    );

    expect(result?.status).toBe("active");
    expect(pushDispatcher.calls).toHaveLength(0);
  });

  it("is race-safe: does not clobber a genuine concurrent CLI status report that already landed", async () => {
    const staleAt = new Date(Date.now() - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    const machine = await insertMachine(staleAt);
    const session = await insertSession({ machineId: machine.id, updatedAt: staleAt });

    // Simulate the race: between the caller fetching this batch (`session`,
    // still snapshotted as "active" below) and `reconcileStaleSessions`
    // running, the CLI's own best-effort exit report
    // (`POST /v1/sessions/:id/status`) actually landed first and moved the
    // real row to "ended". The guard inside `failOrphanedSession` re-reads
    // the row inside its own transaction and must see "ended", not the
    // stale "active" snapshot passed in.
    await db.update(sessions).set({ status: "ended" }).where(eq(sessions.id, session.id));

    const eventRouter = new RecordingEventRouter();
    const pushDispatcher = new RecordingPushDispatcher();
    const reply = fakeReply();

    const updates: unknown[] = [];
    eventRouter.onUpdate((e) => updates.push(e.payload.body));

    const [result] = await reconcileStaleSessions(
      db,
      eventRouter,
      pushDispatcher,
      reply,
      accountId,
      [session], // stale snapshot: still says status "active"
      new Map([[machine.id, machine.lastSeenAt]]),
    );
    reply.raw.emit("finish");

    // The real row stays "ended" — not overwritten to "failed".
    const dbRow = await db.query.sessions.findFirst({ where: eq(sessions.id, session.id) });
    expect(dbRow?.status).toBe("ended");
    // No fan-out for a flip that never actually happened.
    expect(updates).toHaveLength(0);
    expect(pushDispatcher.calls).toHaveLength(0);
    // The returned row reflects "not our doing" rather than a fabricated status.
    expect(result?.status).not.toBe("failed");
  });

  it("does not flip a session with no machineId", async () => {
    const staleAt = new Date(Date.now() - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    const session = await insertSession({ machineId: null, updatedAt: staleAt });

    const eventRouter = new RecordingEventRouter();
    const pushDispatcher = new RecordingPushDispatcher();
    const reply = fakeReply();

    const [result] = await reconcileStaleSessions(
      db,
      eventRouter,
      pushDispatcher,
      reply,
      accountId,
      [session],
      new Map(),
    );

    expect(result?.status).toBe("active");
  });

  it("does not flip a session whose machine has never heartbeated (null lastSeenAt)", async () => {
    const staleAt = new Date(Date.now() - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    const machine = await insertMachine(null);
    const session = await insertSession({ machineId: machine.id, updatedAt: staleAt });

    const eventRouter = new RecordingEventRouter();
    const pushDispatcher = new RecordingPushDispatcher();
    const reply = fakeReply();

    const [result] = await reconcileStaleSessions(
      db,
      eventRouter,
      pushDispatcher,
      reply,
      accountId,
      [session],
      new Map([[machine.id, null]]),
    );

    expect(result?.status).toBe("active");
  });
});
