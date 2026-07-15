import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { env } from "../config.js";

// Run on every boot (design §6.5: "migrate runs on boot" — the self-host
// docker-compose shape has no separate migration step). Idempotent: drizzle
// tracks applied migrations in its own `drizzle.__drizzle_migrations` table,
// so re-running on an already-current database is a no-op.
//
// `migrationsFolder` is resolved relative to the process cwd, which is
// `packages/server/` both for `pnpm --filter @falcon/server dev|start` and
// for the production Docker image (WORKDIR mirrors the package root, with
// `dist/` and `drizzle/` copied in as siblings).
//
// Arbitrary constant lock key, unique to Falcon's migration runner (any int8 works —
// it's just a namespace so this lock never collides with an unrelated advisory lock).
const MIGRATION_ADVISORY_LOCK_KEY = 727_106;

export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.resolve(process.cwd(), "drizzle");
  const migrationClient = postgres(env.DATABASE_URL, { max: 1 });
  try {
    // drizzle's migrator has no locking of its own: two concurrent callers (multiple
    // server replicas booting at once; in this repo, multiple Postgres-backed test
    // suites racing `runMigrations()` against a fresh database) can both see
    // "not yet migrated" and issue the same `CREATE TABLE` at once. A session-level
    // Postgres advisory lock — held only by this single-connection client (`max: 1`),
    // for the duration of this call — serializes them so the second caller simply
    // waits, then finds the migration already applied (the idempotency documented
    // above still holds).
    await migrationClient`select pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`;
    await migrate(drizzle(migrationClient), { migrationsFolder });
  } finally {
    await migrationClient`select pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`.catch(
      () => {},
    );
    await migrationClient.end();
  }
}
