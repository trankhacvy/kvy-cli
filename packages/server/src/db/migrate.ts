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
export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.resolve(process.cwd(), "drizzle");
  const migrationClient = postgres(env.DATABASE_URL, { max: 1 });
  try {
    await migrate(drizzle(migrationClient), { migrationsFolder });
  } finally {
    await migrationClient.end();
  }
}
