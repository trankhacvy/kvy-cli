import type { PgDatabase } from "drizzle-orm/pg-core";
import type * as schema from "./schema.js";

/**
 * The query-result HKT (first type param) is erased to `any` on purpose:
 * it's the one thing that genuinely differs between `PostgresJsDatabase`
 * (production, `db/client.ts`) and `PgliteDatabase` (tests — an in-memory
 * Postgres so route tests exercise real SQL without a Docker/network
 * dependency) and no route in `app/routes/` inspects raw driver results
 * (`rowCount`, etc.) — every route goes through `.query.<table>.findFirst/
 * findMany`, `.insert(...).returning()`, `.update(...).returning()`, and
 * `.transaction`. The schema type param IS pinned (`typeof schema`, not
 * `any`) so `db.query.sessions`/`.messages`/etc. stay fully typed. `db` is
 * injected into each route factory (rather than importing the
 * `db/client.ts` singleton) so tests can bind an in-memory Postgres instead
 * of touching `DATABASE_URL`.
 */
export type Database = PgDatabase<any, typeof schema>;
