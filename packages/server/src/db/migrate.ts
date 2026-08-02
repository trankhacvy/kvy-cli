import { readFile } from "node:fs/promises";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { env } from "../config.js";

// docker-compose shape has no separate migration step). Idempotent: drizzle
// tracks applied migrations in its own `drizzle.__drizzle_migrations` table,
// so re-running on an already-current database is a no-op.
//
// `migrationsFolder` is resolved relative to the process cwd, which is
// `packages/server/` both for `pnpm --filter @kvy/server dev|start` and
// for the production Docker image (WORKDIR mirrors the package root, with
// `dist/` and `drizzle/` copied in as siblings).
//
// Arbitrary constant lock key, unique to Kvy's migration runner (any int8 works —
// it's just a namespace so this lock never collides with an unrelated advisory lock).
const MIGRATION_ADVISORY_LOCK_KEY = 727_106;

/**
 * How long to keep trying for the advisory lock before giving up and migrating anyway.
 * A blocking `pg_advisory_lock` is what wedged a boot against a Neon pooled endpoint
 * pooler is not reliably released by the `pg_advisory_unlock` that follows, because the
 * unlock can be routed to a different backend than the lock was. Proceeding without the
 * lock is safe to fail loudly — drizzle runs every pending migration inside ONE
 * transaction, so a loser rolls back whole and surfaces a duplicate-object error rather
 * than half-applying anything.
 */
const LOCK_ATTEMPT_TIMEOUT_MS = 10_000;
const LOCK_RETRY_INTERVAL_MS = 250;

/** Every migration the shipped `drizzle/` folder expects to be applied. */
export async function journalEntryCount(migrationsFolder: string): Promise<number> {
  const raw = await readFile(path.join(migrationsFolder, "meta", "_journal.json"), "utf8");
  const journal: unknown = JSON.parse(raw);
  const entries = (journal as { entries?: unknown[] }).entries;
  return Array.isArray(entries) ? entries.length : 0;
}

export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.resolve(process.cwd(), "drizzle");
  // Migrations run over the DIRECT endpoint when one is configured. A transaction pooler
  // (PgBouncer, Neon's `-pooler` host, Vercel's pooled URL) is the wrong transport for
  // session-scoped state and long DDL transactions; every vendor that ships a pooler also
  // ships an unpooled URL and tells you to migrate over it. Nothing else in the server
  // reads this var — the request path stays on the pool.
  const migrationUrl = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
  const migrationClient = postgres(migrationUrl, { max: 1 });
  try {
    // drizzle's migrator has no locking of its own: two concurrent callers (multiple
    // server replicas booting at once; in this repo, multiple Postgres-backed test
    // suites racing `runMigrations()` against a fresh database) can both see
    // "not yet migrated" and issue the same `CREATE TABLE` at once. A session-level
    // Postgres advisory lock — held only by this single-connection client (`max: 1`),
    // for the duration of this call — serializes them so the second caller simply
    // waits, then finds the migration already applied (the idempotency documented
    // above still holds).
    const locked = await acquireLock(migrationClient);
    await migrate(drizzle(migrationClient), { migrationsFolder });
    if (!locked) {
      // Not fatal on its own — say it out loud rather than let a concurrent-migrator
      // failure downstream look unexplained.
      console.warn("migrate: proceeded without the advisory lock (timed out waiting)");
    }

    // distinguishable from a successful one. It wasn't: a run that applied 0 of 2 pending
    // migrations exited 0 and the server booted against a schema with no `key_requests`
    const [{ count } = { count: "0" }] = await migrationClient<{ count: string }[]>`
      select count(*)::text as count from drizzle.__drizzle_migrations
    `;
    const expected = await journalEntryCount(migrationsFolder);
    if (Number(count) !== expected) {
      throw new Error(
        `migrate: expected ${expected} applied migrations, found ${count} — ` +
          `the database is not at the schema this build requires`,
      );
    }
  } finally {
    await migrationClient`select pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`.catch(
      () => {},
    );
    await migrationClient.end();
  }
}

/** Bounded, non-blocking lock acquisition — see `LOCK_ATTEMPT_TIMEOUT_MS`. */
export async function acquireLock(client: postgres.Sql): Promise<boolean> {
  const deadline = Date.now() + LOCK_ATTEMPT_TIMEOUT_MS;
  for (;;) {
    const [row] = await client<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY}) as locked
    `;
    if (row?.locked) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
  }
}
