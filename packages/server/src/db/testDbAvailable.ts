import { sql } from "drizzle-orm";
import type { db as dbClient } from "./client.js";

/**
 * Probes whether a real, reachable Postgres is configured via `DATABASE_URL`
 * — used by `describe.skipIf(!dbAvailable)` in DB-backed integration tests
 * (`seq.test.ts`, `pair.test.ts`) to skip themselves rather than fail when no
 * database is wired up (matching `schema.test.ts`'s note that DB-backed
 * behavior isn't part of the no-infra default test run).
 *
 * Retries a few times with a short delay before giving up: a single `docker
 * compose up` right before the test run (or several test files/workers
 * dialing in at once) can leave Postgres accepting TCP connections but not
 * yet ready to serve queries for the first tens/hundreds of ms. A one-shot
 * probe races that warm-up window and — because a failed attempt tears down
 * the shared connection pool below — turns a purely transient hiccup into
 * the entire suite silently skipping itself for the rest of the process,
 * producing nondeterministic skip counts across otherwise-identical runs.
 * Only the *last* failure tears the pool down; earlier failures just wait
 * and retry on the same client.
 */
export async function isDatabaseAvailable(
  db: typeof dbClient,
  { retries = 5, delayMs = 200 }: { retries?: number; delayMs?: number } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await db.execute(sql`select 1`);
      return true;
    } catch {
      const isLastAttempt = attempt === retries;
      if (isLastAttempt) {
        await db.$client.end({ timeout: 1 }).catch(() => {});
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}
