import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { mintToken } from "../../auth/index.js";
import * as schema from "../../db/schema.js";
import { accounts } from "../../db/schema.js";

// In-memory Postgres (WASM, `@electric-sql/pglite`) migrated with the same
// SQL `drizzle-kit generate` produced for production (`packages/server/
// drizzle/`) — a real integration test against a real Postgres dialect,
// without a Docker/network dependency (same rationale as auth.test.ts,
// task 0.4).
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

/** Fresh in-memory Postgres + Drizzle instance, migrated and ready to use. */
export async function createTestDb() {
  const pglite = new PGlite();
  const db = drizzle(pglite, { schema });
  await migrate(db, { migrationsFolder });
  return { db, pglite };
}

/** Inserts a bare account row and mints a bearer token for it. */
export async function createTestAccount(db: ReturnType<typeof drizzle>) {
  const [account] = await db
    .insert(accounts)
    .values({
      signPublicKey: `test-${randomUUID()}`,
      contentPubKey: "test-content-pub-key",
    })
    .returning();
  if (!account) throw new Error("createTestAccount: insert returned no row");
  const token = await mintToken(account.id);
  return { account, token, authHeader: `Bearer ${token}` };
}
