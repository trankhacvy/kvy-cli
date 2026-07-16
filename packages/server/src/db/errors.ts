function pgErrorCode(err: unknown): unknown {
  if (typeof err !== "object" || err === null) return undefined;
  if ("code" in err) return (err as { code?: unknown }).code;
  return undefined;
}

/**
 * True if `err` is a Postgres unique-violation (SQLSTATE `23505`), surfaced
 * identically by both drivers this package runs against: `postgres` (prod,
 * `db/client.ts`) and `@electric-sql/pglite` (tests). Used to collapse a
 * lost create-or-get / idempotent-insert race into a replay read instead of
 * a 500 (design §4.3: "dedup on (sessionId, localId) returns the existing
 * row" — the unique index is the actual dedup mechanism under concurrency;
 * the pre-insert `findFirst` check is just the fast, uncontended path).
 *
 * Drizzle wraps the raw driver error in a `DrizzleQueryError` whose `code`
 * is `undefined` — the real Postgres SQLSTATE lives one level down, on
 * `.cause` — so this walks the cause chain (bounded, in case some future
 * wrapper nests deeper) rather than checking `err.code` directly.
 */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (pgErrorCode(current) === "23505") return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
