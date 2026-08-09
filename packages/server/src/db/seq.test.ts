import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "./client.js";
import { runMigrations } from "./migrate.js";
import { accounts, sessions } from "./schema.js";
import { allocHeaderSeq, allocMsgSeq } from "./seq.js";
import { isDatabaseAvailable } from "./testDbAvailable.js";

// Integration test: exercises the real atomic `UPDATE ... RETURNING` against
// Postgres (drizzle-orm's query builder can't be faithfully mocked for
// row-level lock behavior). Skips itself — rather than failing the suite —
// when no reachable Postgres is configured via DATABASE_URL, matching
// schema.test.ts's note that DB-backed behavior isn't wired into the
// no-infra default test run. Point DATABASE_URL at a real postgres:16 (e.g.
// `docker-compose.dev.yml`) to exercise it.
//
// `describe.skipIf` is evaluated at collection time, before any hook runs —
// so the availability probe has to happen at module load (top-level await),
// not inside `beforeAll`.
const dbAvailable = await isDatabaseAvailable(db);
if (dbAvailable) {
  await runMigrations();
}

afterAll(async () => {
  if (dbAvailable) {
    await db.$client.end();
  }
});

async function insertAccount() {
  const [account] = await db
    .insert(accounts)
    .values({
      signPublicKey: `seq-test-${randomUUID()}`,
      contentPubKey: "seq-test-content-pub-key",
    })
    .returning();
  if (!account) throw new Error("insertAccount: insert returned no row");
  return account;
}

async function insertSession(accountId: string) {
  const [session] = await db
    .insert(sessions)
    .values({
      accountId,
      tag: `seq-test-${randomUUID()}`,
      provider: "claude-code",
      metadata: new Uint8Array([1]),
      dek: new Uint8Array([1]),
    })
    .returning();
  if (!session) throw new Error("insertSession: insert returned no row");
  return session;
}

describe.skipIf(!dbAvailable)("allocMsgSeq / allocHeaderSeq (requires Postgres)", () => {
  // 30s, not vitest's 5s default: this serializes N real round trips to a
  // remote (Neon) Postgres instance shared with every other concurrently
  // running test file, not an in-memory operation — observed timing out at
  // 5s under normal contention from the rest of the suite, then again at 20s.
  it("allocates a gapless, unique sequence for N concurrent callers on the same session", async () => {
    const account = await insertAccount();
    const session = await insertSession(account.id);

    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, () => db.transaction((tx) => allocMsgSeq(tx, session.id))),
    );

    expect(new Set(results).size).toBe(N); // no duplicates
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // 1..N, no gaps

    await db.delete(accounts).where(sql`${accounts.id} = ${account.id}`);
  }, 30_000);

  // Same 30s reasoning as above.
  it("allocates a gapless, unique sequence for N concurrent callers on the same account (headerSeq)", async () => {
    const account = await insertAccount();

    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, () => db.transaction((tx) => allocHeaderSeq(tx, account.id))),
    );

    expect(new Set(results).size).toBe(N);
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    await db.delete(accounts).where(sql`${accounts.id} = ${account.id}`);
  }, 30_000);

  it("does NOT contend across two different session rows (row-scoped lock, not table-scoped)", async () => {
    const account = await insertAccount();
    const sessionA = await insertSession(account.id);
    const sessionB = await insertSession(account.id);

    // HOLD_MS and the fast-path ceiling below are deliberately far apart (2s
    // vs. 1.2s), not the tight margins this test originally shipped with
    // (400ms vs. 350ms): a single round trip to a remote (Neon) Postgres
    // instance can itself take several hundred ms, which ate almost the
    // entire old margin and made this test flaky on nothing but ordinary
    // network variance, not a real contention bug.
    const HOLD_MS = 2000;
    const UNCONTENDED_CEILING_MS = 1200;
    let heldTxFinished = false;

    // Open a transaction against session A and hold its row lock for HOLD_MS
    // by not returning (and thus not committing) right away.
    const heldTx = db.transaction(async (tx) => {
      const seq = await allocMsgSeq(tx, sessionA.id);
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      heldTxFinished = true;
      return seq;
    });

    // Give the held transaction a moment to acquire its row lock before racing it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const start = Date.now();
    const seqB = await db.transaction((tx) => allocMsgSeq(tx, sessionB.id));
    const elapsedMs = Date.now() - start;

    // Session B's allocation must complete well before session A's lock is
    // released — proof the lock is scoped to session A's row only.
    expect(seqB).toBe(1);
    expect(heldTxFinished).toBe(false);
    expect(elapsedMs).toBeLessThan(UNCONTENDED_CEILING_MS);

    const seqA = await heldTx;
    expect(seqA).toBe(1);

    await db.delete(accounts).where(sql`${accounts.id} = ${account.id}`);
  });

  it("DOES serialize two concurrent callers on the SAME session row", async () => {
    const account = await insertAccount();
    const session = await insertSession(account.id);

    const HOLD_MS = 300;
    let heldTxFinished = false;

    const heldTx = db.transaction(async (tx) => {
      const seq = await allocMsgSeq(tx, session.id);
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      heldTxFinished = true;
      return seq;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const start = Date.now();
    const seqSecond = await db.transaction((tx) => allocMsgSeq(tx, session.id));
    const elapsedMs = Date.now() - start;

    // The second allocation had to wait for the first transaction on the
    // same row to release its lock.
    expect(heldTxFinished).toBe(true);
    expect(elapsedMs).toBeGreaterThanOrEqual(HOLD_MS - 100);
    expect(seqSecond).toBe(2);

    const seqFirst = await heldTx;
    expect(seqFirst).toBe(1);

    await db.delete(accounts).where(sql`${accounts.id} = ${account.id}`);
  });

  it("throws for an unknown session/account id instead of silently returning undefined", async () => {
    await expect(
      db.transaction((tx) => allocMsgSeq(tx, "nonexistent-session-id")),
    ).rejects.toThrow();
    await expect(
      db.transaction((tx) => allocHeaderSeq(tx, "nonexistent-account-id")),
    ).rejects.toThrow();
  });
});
