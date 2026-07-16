/**
 * True if `err` is a Postgres unique-violation (SQLSTATE `23505`), surfaced
 * identically by both drivers this package runs against: `postgres` (prod,
 * `db/client.ts`) and `@electric-sql/pglite` (tests). Used to collapse a
 * lost create-or-get / idempotent-insert race into a replay read instead of
 * a 500 (design §4.3: "dedup on (sessionId, localId) returns the existing
 * row" — the unique index is the actual dedup mechanism under concurrency;
 * the pre-insert `findFirst` check is just the fast, uncontended path).
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}
