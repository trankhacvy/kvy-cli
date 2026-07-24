import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { accounts, sessions } from "./schema.js";

/**
 * Anything that can run the Drizzle query builder: the shared pool (`db`) or
 * an open transaction (`db.transaction(async (tx) => ...)`). Both expose the
 * same `.update(...)` interface, so callers can allocate a seq either inside
 * a larger transaction (the common case — see §4.3's message-ingest flow) or
 * standalone.
 */
type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Two-level sequencing (design §4.3, §6.1 — DELTA D2 from Happy's single
 * `allocateUserSeq`/`allocateSessionSeq`): high-rate transcript messages get
 * a counter scoped to ONE session row (`sessions.msgSeq`), so two chatty
 * sessions never serialize on a shared counter. Structural account changes
 * get a separate, low-rate counter scoped to ONE account row
 * (`accounts.headerSeq`, see `allocHeaderSeq` below).
 *
 * The atomic `UPDATE ... SET msg_seq = msg_seq + 1 RETURNING msg_seq` both
 * increments and reads in one round trip: Postgres takes a row-level lock on
 * exactly the targeted `sessions` row for the statement's duration, so
 * concurrent allocations against *different* session rows never block each
 * other — only concurrent allocations against the *same* session row
 * serialize (which is the point: message order within a session is total).
 *
 * Also bumps `sessions.updatedAt` (known-issues.md #10): this is the one
 * write path every real chat message goes through, so it's where
 * "last touched" needs to become true instead of only reflecting the four
 * incidental triggers (mute, archive/restore, agentState CAS, status change).
 */
export async function allocMsgSeq(tx: Executor, sessionId: string): Promise<number> {
  const [row] = await tx
    .update(sessions)
    .set({ msgSeq: sql`${sessions.msgSeq} + 1`, updatedAt: new Date() })
    .where(eq(sessions.id, sessionId))
    .returning({ seq: sessions.msgSeq });

  if (!row) {
    throw new Error(`allocMsgSeq: no session found for id ${sessionId}`);
  }
  return row.seq;
}

/** Same atomic-increment shape as `allocMsgSeq`, scoped to `accounts.headerSeq`. */
export async function allocHeaderSeq(tx: Executor, accountId: string): Promise<number> {
  const [row] = await tx
    .update(accounts)
    .set({ headerSeq: sql`${accounts.headerSeq} + 1` })
    .where(eq(accounts.id, accountId))
    .returning({ seq: accounts.headerSeq });

  if (!row) {
    throw new Error(`allocHeaderSeq: no account found for id ${accountId}`);
  }
  return row.seq;
}
