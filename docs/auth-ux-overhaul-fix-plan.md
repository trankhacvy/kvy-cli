# Auth UX Overhaul — Fix Plan for the E2E Findings

> **Revision history**
> - **rev 1** — first draft, from a full re-verification of the E2E findings against source.
> - **rev 2** — corrective pass after an independent review
>   ([`auth-ux-overhaul-fix-plan-review.md`](./auth-ux-overhaul-fix-plan-review.md)), which
>   graded the plan 5 SOUND · 5 MOSTLY SOUND · 1 PROBLEMATIC. Six corrections, all
>   re-verified against source before being applied — the reasoning is kept inline rather than
>   quietly edited away, matching this repo's convention:
>   1. **Fix 8 shipped a build-breaking diff on a false premise.** `peekPendingPair` has no
>      `typeof window` guard, so the proposed `useState` lazy initialiser would throw
>      `ReferenceError` during the static-export prerender. Replaced with the effect pattern
>      `signin/page.tsx` already uses.
>   2. **Fix 4 missed the production sign-in path.** `complete-oauth-sign-in.ts:56-63` has the
>      same bug; `/password/` 404s in production, so rev 1 protected only the dev-only path.
>      Added as [Part A2](#part-a2--the-oauth-path-has-the-same-bug-and-is-not-deletable), with
>      the ordering constraint that makes it different from the password fix.
>   3. **Fix 2 undercounted `silentRefresh()` call sites** (two → four, plus a dep type).
>      Blast radius redone as a table.
>   4. **Fix 2's `OfflineBanner` mitigation claim was false** — it mounts *inside* `RequireAuth`
>      and cannot render in the state that needs it. Added Part C, a real unreachable state.
>   5. **Fix 6 asserted away a PRD scenario** it quotes; added a first-registration grace window.
>   6. **Fix 11's hypothesis 2 was contradicted by its own hypothesis 3**; demoted.
>
> **Companion to:** [`auth-ux-overhaul-e2e-results.md`](./auth-ux-overhaul-e2e-results.md) — the
> live end-to-end pass (2026-07-25/26, tmux CLI + Chrome MCP web) that produced these findings,
> and [`auth-ux-overhaul-plan.md`](./auth-ux-overhaul-plan.md), the plan whose Phases 0–7 the
> E2E pass was verifying.
>
> **Scope:** the 11 confirmed defects from that pass. Not a re-plan of the overhaul — every fix
> below is a repair to shipped code, sized to the defect.
>
> **Method note:** every file cited here was read in full and every line number re-verified
> against the working tree before this document was written. Where the E2E report's stated
> root cause turned out to be wrong, the section says so explicitly and describes what was
> actually found. **Three of the eleven had a materially different root cause than reported**
> — Fix 2, Fix 4, and (partly) Fix 10 — and one, Fix 10, turned out to contain a functional
> dead-end that the report classified as a copy problem.

---

## Table of contents

| # | Fix | Severity | E2E id | Files |
|---|---|---|---|---|
| 1 | [Migrations must apply on boot, or fail loudly](#fix-1--migrations-must-apply-on-boot-or-fail-loudly) | CRITICAL | S1 | 3 |
| 2 | [The crypto worker's `API_URL` is empty, so silent refresh never reaches the API](#fix-2--the-crypto-workers-api_url-is-empty-so-silent-refresh-never-reaches-the-api) | CRITICAL | E2E-4.1 / 6.1 | 5 |
| 3 | [A dead refresh token must trigger a real re-pair](#fix-3--a-dead-refresh-token-must-trigger-a-real-re-pair) | CRITICAL | E2E-6.4 | 6 |
| 4 | [Key material must be bound to the account it belongs to](#fix-4--key-material-must-be-bound-to-the-account-it-belongs-to) | CRITICAL | — | 8 |
| 5 | [Logout must delete the databases, not just empty them](#fix-5--logout-must-delete-the-databases-not-just-empty-them) | MEDIUM | E2E-5.5 | 6 |
| 6 | [Stop backfilling transcripts that predate Kvy](#fix-6--stop-backfilling-transcripts-that-predate-kvy) | HIGH | — | 4 |
| 7 | [A key request must reach the person at the terminal](#fix-7--a-key-request-must-reach-the-person-at-the-terminal) | MEDIUM | — | 5 |
| 8 | [`/password/` must not default to sign-up on a pairing continuation](#fix-8--password-must-not-default-to-sign-up-on-a-pairing-continuation) | LOW | — | 3 |
| 9 | ["One more step" must say what will happen next](#fix-9--one-more-step-must-say-what-will-happen-next) | LOW | — | 3 |
| 10 | [The `/pair/` key-fetch detour is a dead end](#fix-10--the-pair-key-fetch-detour-is-a-dead-end) | LOW→MEDIUM | — | 3 |
| 11 | [First click after load is swallowed — diagnosis plan](#fix-11--first-click-after-load-is-swallowed--diagnosis-plan) | LOW | — | 2–4 |

Ordering is dependency-first, not severity-first. Rationale in
[Implementation and PR sequencing](#implementation-and-pr-sequencing) at the end.

---

## Fix 1 — Migrations must apply on boot, or fail loudly

**Status: ✅ Implemented — `migrate.ts` now migrates over `DATABASE_URL_UNPOOLED` when set,
acquires the advisory lock with a bounded `pg_try_advisory_lock` retry loop instead of a
blocking one, and throws if the post-migrate applied count doesn't match
`drizzle/meta/_journal.json`'s entry count. `config.ts` gained the optional
`DATABASE_URL_UNPOOLED` env var (added to `OPTIONAL_ENV_KEYS` too). New
`packages/server/src/db/migrate.test.ts` covers `journalEntryCount`, `acquireLock`'s bounded
timeout, and `runMigrations()`'s throw-on-mismatch — both `acquireLock` and `journalEntryCount`
were exported (not just `acquireLock` as literally shown in the diff) since the test needs
both. `config.test.ts` and `deploy/README.md` / `docs/PROD_DEPLOYMENT_RUNBOOK.md` updated per
the plan. No deviation from the plan's intent; implemented exactly as specified.**

### Root cause

`runMigrations()` wraps drizzle's `migrate()` in a **session-scoped** `pg_advisory_lock` held on
a `postgres-js` client, and the deployment's `DATABASE_URL` points at a Neon **pooled** endpoint
(`-pooler` in the hostname, PgBouncer transaction pooling). Under transaction pooling a
session-scoped lock is not reliably bound to the backend that runs the subsequent statements,
and the `pg_advisory_unlock` in the `finally` can land on a different backend entirely — so the
lock leaks and later runs either block on it or silently no-op. Compounding it: `runMigrations()`
never checks its own result, so a run that applied zero of two pending migrations exits `0` and
the server boots against a schema that is missing `key_requests`.

### What was verified vs. the report

- **Confirmed:** `packages/server/src/db/migrate.ts` is 41 lines and does exactly what the report
  describes. The lock lines are **33 and 36**, not `20-31` as cited in
  `auth-ux-overhaul-e2e-results.md:32` — line 19 is the `MIGRATION_ADVISORY_LOCK_KEY` constant
  and 21–41 is `runMigrations()`.
- **Confirmed:** `packages/server/drizzle/meta/_journal.json` has **8** entries
  (`0000_thin_synch` … `0007_safe_glorian`); the DB had 6.
- **Confirmed:** `db:migrate` is the identical code path —
  `tsx -e "import('./src/db/migrate.ts').then(m => m.runMigrations())"` (`package.json`).
- **Confirmed:** `main.ts:9` awaits `runMigrations()` before `buildServer()`, with a top-level
  `.catch` (`main.ts:32-37`) — so a *thrown* failure is a hard exit, but a *silent* one is not.
- **Read but not confirmable statically:** the exact pooler interaction. Reading
  `drizzle-orm@0.45.2`'s `pg-core/dialect.js:44-71` shows `migrate()` issues `CREATE SCHEMA`
  and `CREATE TABLE IF NOT EXISTS` outside any transaction, then a single
  `session.transaction(...)` containing every pending migration. Nothing in that shape is
  inherently pooler-hostile; the *lock* is. Per guiding principle 7, this plan does not claim
  the mechanism it could not verify — it removes the dependency on it and makes the failure
  loud either way.

### Affected files

- `packages/server/src/db/migrate.ts`
- `packages/server/src/config.ts` (one new optional env var)
- `packages/server/src/db/migrate.test.ts` (**new**)
- `deploy/README.md` + `docs/PROD_DEPLOYMENT_RUNBOOK.md` (documentation of the new var)

### Proposed fix

Three changes, in order of importance:

1. **Run migrations over a direct (non-pooled) connection.** Add an optional
   `DATABASE_URL_UNPOOLED` env var; when set, `runMigrations()` uses it and nothing else does.
   This is the vendor-documented shape for exactly this problem — Neon exposes both endpoints,
   Vercel Postgres calls it `POSTGRES_URL_NON_POOLING`, and drizzle-kit's own docs tell you to
   migrate over the unpooled URL. It is explicit configuration, not inference.
2. **Bound the lock so it can never hang a boot.** Replace the blocking `pg_advisory_lock` with
   `pg_try_advisory_lock` in a short bounded retry loop. A migrator that cannot get the lock
   within the window proceeds anyway rather than wedging the deployment — the loser's
   transaction fails cleanly on a duplicate object (drizzle runs all pending migrations in one
   transaction, so it rolls back whole), which is a loud, recoverable failure instead of a
   silent hang.
3. **Verify and report.** After `migrate()` returns, read back
   `drizzle.__drizzle_migrations` and compare the applied count against the journal's entry
   count. Mismatch → throw. This is the change that actually converts S1 from "CRITICAL, silent"
   to "the server refuses to start and says why", and it is the one that would have caught the
   original bug on day one regardless of which theory about the pooler is right.

**Alternatives considered and rejected:**

- *Just delete the advisory lock.* It was added for a real reason (documented at
  `migrate.ts:25-32`: concurrent replicas and racing Postgres-backed test suites). Removing the
  guard to fix a pooling bug trades one silent failure for another. The retry-bounded
  `pg_try_advisory_lock` keeps the guard and removes the wedge.
- *Use `pg_advisory_xact_lock` inside the migration transaction.* Correct in principle and
  pooler-safe, but drizzle owns that transaction (`dialect.js:60`) and gives no hook to inject a
  statement into it. Wrapping `migrate()` in our own outer transaction makes drizzle's inner
  `session.transaction` a savepoint and changes the rollback semantics of a partially-applied
  migration set. Not worth it.
- *Derive the direct host by stripping `-pooler`.* Magic string surgery on a user's connection
  URL, and wrong for every non-Neon pooler. An explicit env var is honest and portable.

### Code

```diff
--- a/packages/server/src/db/migrate.ts
+++ b/packages/server/src/db/migrate.ts
@@
-import path from "node:path";
-import { drizzle } from "drizzle-orm/postgres-js";
-import { migrate } from "drizzle-orm/postgres-js/migrator";
-import postgres from "postgres";
-import { env } from "../config.js";
+import { readFile } from "node:fs/promises";
+import path from "node:path";
+import { drizzle } from "drizzle-orm/postgres-js";
+import { migrate } from "drizzle-orm/postgres-js/migrator";
+import postgres from "postgres";
+import { env } from "../config.js";
@@
 const MIGRATION_ADVISORY_LOCK_KEY = 727_106;
+
+/**
+ * How long to keep trying for the advisory lock before giving up and migrating anyway.
+ * A blocking `pg_advisory_lock` is what wedged a boot against a Neon pooled endpoint
+ * (auth-ux-overhaul-e2e-results.md S1): a session-scoped lock taken through a transaction
+ * pooler is not reliably released by the `pg_advisory_unlock` that follows, because the
+ * unlock can be routed to a different backend than the lock was. Proceeding without the
+ * lock is safe to fail loudly — drizzle runs every pending migration inside ONE
+ * transaction, so a loser rolls back whole and surfaces a duplicate-object error rather
+ * than half-applying anything.
+ */
+const LOCK_ATTEMPT_TIMEOUT_MS = 10_000;
+const LOCK_RETRY_INTERVAL_MS = 250;
+
+/** Every migration the shipped `drizzle/` folder expects to be applied. */
+async function journalEntryCount(migrationsFolder: string): Promise<number> {
+  const raw = await readFile(path.join(migrationsFolder, "meta", "_journal.json"), "utf8");
+  const journal: unknown = JSON.parse(raw);
+  const entries = (journal as { entries?: unknown[] }).entries;
+  return Array.isArray(entries) ? entries.length : 0;
+}
 
 export async function runMigrations(): Promise<void> {
   const migrationsFolder = path.resolve(process.cwd(), "drizzle");
-  const migrationClient = postgres(env.DATABASE_URL, { max: 1 });
+  // Migrations run over the DIRECT endpoint when one is configured. A transaction pooler
+  // (PgBouncer, Neon's `-pooler` host, Vercel's pooled URL) is the wrong transport for
+  // session-scoped state and long DDL transactions; every vendor that ships a pooler also
+  // ships an unpooled URL and tells you to migrate over it. Nothing else in the server
+  // reads this var — the request path stays on the pool.
+  const migrationUrl = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
+  const migrationClient = postgres(migrationUrl, { max: 1 });
   try {
-    await migrationClient`select pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`;
-    await migrate(drizzle(migrationClient), { migrationsFolder });
+    const locked = await acquireLock(migrationClient);
+    await migrate(drizzle(migrationClient), { migrationsFolder });
+    if (!locked) {
+      // Not fatal on its own — say it out loud rather than let a concurrent-migrator
+      // failure downstream look unexplained.
+      console.warn("migrate: proceeded without the advisory lock (timed out waiting)");
+    }
+
+    // "migrate runs on boot" (design §6.5) is only a guarantee if a no-op run is
+    // distinguishable from a successful one. It wasn't: a run that applied 0 of 2 pending
+    // migrations exited 0 and the server booted against a schema with no `key_requests`
+    // table at all (auth-ux-overhaul-e2e-results.md S1). Verify, then fail hard.
+    const [{ count } = { count: "0" }] = await migrationClient<{ count: string }[]>`
+      select count(*)::text as count from drizzle.__drizzle_migrations
+    `;
+    const expected = await journalEntryCount(migrationsFolder);
+    if (Number(count) !== expected) {
+      throw new Error(
+        `migrate: expected ${expected} applied migrations, found ${count} — ` +
+          `the database is not at the schema this build requires`,
+      );
+    }
   } finally {
     await migrationClient`select pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`.catch(
       () => {},
     );
     await migrationClient.end();
   }
 }
+
+/** Bounded, non-blocking lock acquisition — see `LOCK_ATTEMPT_TIMEOUT_MS`. */
+async function acquireLock(client: postgres.Sql): Promise<boolean> {
+  const deadline = Date.now() + LOCK_ATTEMPT_TIMEOUT_MS;
+  for (;;) {
+    const [row] = await client<{ locked: boolean }[]>`
+      select pg_try_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY}) as locked
+    `;
+    if (row?.locked) return true;
+    if (Date.now() >= deadline) return false;
+    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
+  }
+}
```

`config.ts` gains one line in `EnvSchema` (alongside `DATABASE_URL` at line 34):

```diff
     DATABASE_URL: z.string().min(1).default("postgres://kvy:kvy@localhost:5432/kvy"),
+    /** Direct (non-pooled) connection used ONLY by the boot-time migration runner — see
+     *  `db/migrate.ts`. Unset is fine when `DATABASE_URL` already points at a direct
+     *  endpoint (local Postgres, self-host docker-compose). */
+    DATABASE_URL_UNPOOLED: z.string().min(1).optional(),
```

`DATABASE_URL_UNPOOLED` must be added to `OPTIONAL_ENV_KEYS` (`config.ts:198`) so Docker
Compose's empty-string interpolation is treated as unset, matching every other optional field.

### Testing

- **New** `packages/server/src/db/migrate.test.ts`. There is currently **no test at all** for
  this module (`find src -name "*migrate*"` returns only `db/migrate.ts`). Assert:
  - `journalEntryCount()` reads the real shipped `drizzle/meta/_journal.json` and returns 8.
  - `acquireLock()` returns `false` (not `throw`, not hang) when `pg_try_advisory_lock` keeps
    answering `false`, within the timeout — drive it with a fake `postgres.Sql` and a fake
    clock.
  - `runMigrations()` **throws** when the post-migrate count is below the journal count. This
    is the regression test for S1; it is the assertion that would have failed on 2026-07-25.
- `packages/server/src/config.test.ts` already asserts that core infra fields hard-fail on an
  explicit empty string (see the comment at `config.ts:192-197`) — add a case confirming
  `DATABASE_URL_UNPOOLED=""` is treated as unset, matching the other optional keys.
- Integration: point `DATABASE_URL` at the Neon **pooled** host with `DATABASE_URL_UNPOOLED`
  set to the direct host, drop the two rows from `drizzle.__drizzle_migrations`, and confirm
  boot reapplies both and `to_regclass('public.key_requests')` is non-null.

### Risk / blast radius

`runMigrations()` runs on every boot of every deployment, and this change makes it *stricter*
— a database that is ahead of the code (a rollback deploy) now fails to boot instead of
starting quietly. That is deliberate and correct for a migrate-on-boot design, but it means
**the count check must be `!==`, not `<`**, only if you want rollbacks blocked; use `<` if you
want a newer DB tolerated. This plan proposes `!==` (strict) because the self-host story in
`deploy/README.md` ships schema and code as one image. Call this out in the runbook.

Second-order: `postgres-js` opens the migration client lazily, so an unreachable
`DATABASE_URL_UNPOOLED` now fails at boot with a connection error instead of falling back.
That is the intended behaviour (no silent fallback to a broken transport), but it is a new way
for a misconfigured deploy to fail, so it belongs in `deploy/README.md` next to the existing
"Rebuild `web` whenever the API origin changes" note.

---

## Fix 2 — The crypto worker's `API_URL` is empty, so silent refresh never reaches the API

**Status: ✅ Implemented — Part A (build-worker.mjs define + build-time assertion), Part B
(tri-state `RefreshOutcome` through worker-handler.ts → protocol.ts → client.ts →
`silentRefresh()`), and Part C (`RequireAuth`'s `unreachable` state with a retry button,
copy in `copy.ts`'s new `session` block) all implemented as specified. All four
`silentRefresh` call sites fixed per the plan's table (`pair/page.tsx:66/109`,
`sync/index.ts:36`, `pair-gate.ts`'s dep type + its four test fakes). New
`packages/web/scripts/__tests__/build-worker.test.ts` spawns the real script as a
subprocess (top-level `await` means re-importing in-process can't re-run it) — required
widening `vitest.config.ts`'s `include` to also match `scripts/**/*.test.ts`, since it only
covered `src/**` before. `worker-handler.test.ts` gained the never-implemented
`refreshSession` coverage (6 new cases). One deviation from the plan's literal diff: since
nothing in `require-auth.tsx` already defined an `ensureSessionNow()` the retry button could
call, added a `retryCount` state bumped by the button and included in the effect's deps,
rather than inventing an unused symbol.**

### Root cause

**The reported hypothesis (a React effect-ordering race) is wrong, and this section replaces
it.** The crypto worker is built as a standalone esbuild bundle by
`packages/web/scripts/build-worker.mjs`, which inlines `NEXT_PUBLIC_API_URL` itself. Its
`define` uses `process.env.NEXT_PUBLIC_API_URL ?? ""`, and the script is a bare `node` process
that does **not** load `.env.local` the way Next does. So the var is `undefined`, the `??`
substitutes `""`, and `lib/config.ts`'s own fallback — `?? "http://localhost:3005"` — never
fires, because `??` triggers on `null`/`undefined`, not on the empty string. `API_URL` is baked
as `""`, and the worker's `refreshSession()` fetches the **relative** URL `/v1/auth/refresh`,
which resolves against the *web* origin (`:3000`), 404s, and returns `null`.

`silentRefresh()` cannot distinguish that from "the server rejected your refresh token", so
`RequireAuth` redirects to `/signin/?reason=expired`. Every observed symptom follows exactly:
100% reproducible on any cold load, zero requests to `:3005`, valid records in both IndexedDB
stores, and — critically — a *fresh sign-in* still works, because sign-in's network calls are
made from the main thread, where Next's own inlining is correct.

### Evidence

The proof is mechanical, not inferential:

```
$ grep -o 'DC="[^"]*"' packages/web/public/crypto-worker.js
DC=""

$ grep -o '.\{60\}v1/auth/refresh' packages/web/public/crypto-worker.js
urn{id:D.id,ok:!0,result:null};try{let f=await fetch(`${DC}/v1/auth/refresh`

$ NEXT_PUBLIC_API_URL=http://localhost:3005 node scripts/build-worker.mjs && \
  grep -o 'var DC="[^"]*"' public/crypto-worker.js
var DC="http://localhost:3005"

$ node scripts/build-worker.mjs && grep -o 'var DC="[^"]*"' public/crypto-worker.js
var DC=""
```

`DC` is the minified `API_URL` from `lib/config.ts:15-18`. `packages/web/.env*` does not exist,
so Next's own bundle correctly uses the `http://localhost:3005` default (which is why every
main-thread call works); only the worker bundle is wrong. `packages/web/public/crypto-worker.js`
is gitignored (`.gitignore:26`) and rebuilt by `pnpm --filter @kvy/web dev`
(`"dev": "node scripts/build-worker.mjs && next dev"`), so every dev run reproduces it.

**Why production is not affected today, and why that is not comfort:**
`deploy/web.Dockerfile:47` sets `ENV NEXT_PUBLIC_API_URL=$API_ORIGIN` before the build, and
Vercel injects it from project settings. So this is currently a dev-only outage — but it is a
one-typo-away production outage with no build-time signal at all, which is why the fix below
adds an assertion rather than only correcting the `??`.

### Affected files

- `packages/web/scripts/build-worker.mjs` — the root cause
- `packages/web/src/crypto/worker-handler.ts` — `refreshSession` result shape
- `packages/web/src/crypto/protocol.ts` — the RPC result type
- `packages/web/src/crypto/client.ts` — `refreshSession()` signature
- `packages/web/src/lib/session.ts` — `silentRefresh()`
- `packages/web/src/features/auth/require-auth.tsx` — what a failure means
- Tests: `packages/web/src/lib/__tests__/session.test.ts`,
  `packages/web/src/crypto/__tests__/worker-handler.test.ts`,
  `packages/web/src/features/auth/__tests__/require-auth.test.ts`

### Proposed fix

**Part A — stop breaking the fallback, and assert.**

```diff
--- a/packages/web/scripts/build-worker.mjs
+++ b/packages/web/scripts/build-worker.mjs
@@
-  define: {
-    "process.env": "{}",
-    "process.env.NEXT_PUBLIC_API_URL": JSON.stringify(process.env.NEXT_PUBLIC_API_URL ?? ""),
-  },
+  // `?? ""` here used to DEFEAT `lib/config.ts`'s own `?? "http://localhost:3005"` fallback:
+  // `??` triggers on undefined, not on an empty string, so an unset var baked API_URL as ""
+  // and every worker-side fetch became a same-origin relative URL against the WEB origin.
+  // That is the whole of auth-ux-overhaul-e2e-results.md E2E-4.1/6.1 — a reload signed the
+  // user out because the refresh call went to :3000 and 404'd. Emit the define only when the
+  // var is actually set; otherwise let `process.env` -> `{}` yield `undefined` and config.ts
+  // apply its own default, exactly as the main bundle does.
+  define: {
+    "process.env": "{}",
+    ...(process.env.NEXT_PUBLIC_API_URL
+      ? {
+          "process.env.NEXT_PUBLIC_API_URL": JSON.stringify(process.env.NEXT_PUBLIC_API_URL),
+        }
+      : {}),
+  },
   plugins: [localImportPlugin],
 });
+
+// Fail the build rather than ship a worker that silently talks to the wrong origin. The
+// bundle is minified and the URL is concatenated at runtime (`fetch(`${API_URL}/v1/auth/…`)`),
+// so don't pattern-match the final URL — assert the exact base string this build should have
+// inlined is present verbatim.
+const expectedBase = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3005").replace(
+  /\/+$/,
+  "",
+);
+const emitted = await readFile(path.join(root, "public/crypto-worker.js"), "utf8");
+if (!emitted.includes(JSON.stringify(expectedBase))) {
+  throw new Error(
+    `build-worker: expected the bundle to inline ${expectedBase} as its API base — ` +
+      "check NEXT_PUBLIC_API_URL",
+  );
+}
```

The exact-string check matters: an earlier draft of this assertion used a regex
(`/["'`]https?:\/\//`) that passes if *any* absolute-URL literal appears anywhere in a
993 KB bundle — for any reason at all, including an unrelated libsodium comment — and whose
other alternation could never match a good build, because the URL is built at runtime. It
would have been a no-op guard. The script already knows the expected value; assert on it.

*(the assertion needs `import { existsSync, readFile }` widened to
`import { existsSync } from "node:fs"; import { readFile } from "node:fs/promises";` — the
script currently imports only `existsSync`.)*

**Part B — make a failed refresh distinguishable, so a transport fault can never masquerade
as a revoked session.** This is the defence that would have contained the bug: today
`refreshSession()` collapses "no credential stored", "server said no", and "the request never
got anywhere" into a single `null`, and `RequireAuth` treats all three as *sign the user out*.

```diff
--- a/packages/web/src/crypto/worker-handler.ts
+++ b/packages/web/src/crypto/worker-handler.ts
@@ case "refreshSession": {
         case "refreshSession": {
           refreshToken ??= await sessionStorage.load();
           if (!refreshToken) {
-            return { id: request.id, ok: true, result: null };
+            return { id: request.id, ok: true, result: { kind: "no-credential" } };
           }
           try {
             const res = await fetch(`${API_URL}/v1/auth/refresh`, {
               method: "POST",
               headers: { "content-type": "application/json" },
               body: JSON.stringify({ refreshToken }),
             });
-            if (!res.ok) return { id: request.id, ok: true, result: null };
+            // 401/403 is the server genuinely rejecting the credential — the only answer
+            // that should ever sign a user out. Anything else (404 from a misconfigured
+            // API base, 5xx, a proxy error) is a transport fault: keep the session and let
+            // the caller retry, per "never claim a security property you have not verified".
+            if (res.status === 401 || res.status === 403) {
+              return { id: request.id, ok: true, result: { kind: "rejected" } };
+            }
+            if (!res.ok) return { id: request.id, ok: true, result: { kind: "unreachable" } };
             const body: unknown = await res.json();
-            if (!isRefreshResponse(body)) return { id: request.id, ok: true, result: null };
+            if (!isRefreshResponse(body)) {
+              return { id: request.id, ok: true, result: { kind: "unreachable" } };
+            }
             refreshToken = body.refreshToken;
             await sessionStorage.save(refreshToken);
-            return { id: request.id, ok: true, result: body.accessToken };
+            return { id: request.id, ok: true, result: { kind: "ok", accessToken: body.accessToken } };
           } catch {
-            return { id: request.id, ok: true, result: null };
+            return { id: request.id, ok: true, result: { kind: "unreachable" } };
           }
         }
```

`protocol.ts` gains the result type alongside `StorageDescription` (line 208) and changes one
line of `CryptoWorkerResults` (line 233):

```ts
/**
 * Why a refresh did or didn't produce a token. Deliberately NOT a bare `string | null`:
 * collapsing "the server rejected this credential" into the same value as "the request
 * never arrived" is what turned a bundler misconfiguration into a total sign-out for every
 * user on every reload (auth-ux-overhaul-e2e-results.md E2E-4.1).
 */
export type RefreshOutcome =
  | { kind: "ok"; accessToken: string }
  /** Nothing stored to refresh with — a genuinely signed-out browser. */
  | { kind: "no-credential" }
  /** The server answered 401/403: dead, revoked, or replayed. Sign out. */
  | { kind: "rejected" }
  /** The request failed or answered something unusable. Keep the session; retry. */
  | { kind: "unreachable" };
```

`client.ts:74` / `:159` change `refreshSession(): Promise<string | null>` to
`Promise<RefreshOutcome>`.

`lib/session.ts` then makes the distinction the caller's business:

```diff
-export async function silentRefresh(): Promise<boolean> {
-  const bridge = getSharedCryptoBridge();
-  if (!bridge) return false;
-
-  const accessToken = await bridge.refreshSession();
-  if (!accessToken) {
-    clearToken();
-    return false;
-  }
-  setToken(accessToken);
-  return true;
-}
+export type SilentRefreshResult = "ok" | "signed-out" | "unreachable";
+
+export async function silentRefresh(): Promise<SilentRefreshResult> {
+  const bridge = getSharedCryptoBridge();
+  // No live worker to ask. Not evidence of a dead session — leave the token alone, same
+  // as this function always has (`lib/__tests__/session.test.ts` pins that behaviour).
+  if (!bridge) return "unreachable";
+
+  const outcome = await bridge.refreshSession();
+  switch (outcome.kind) {
+    case "ok":
+      setToken(outcome.accessToken);
+      return "ok";
+    case "no-credential":
+    case "rejected":
+      clearToken();
+      return "signed-out";
+    case "unreachable":
+      return "unreachable";
+  }
+}
```

and `require-auth.tsx`'s effect only bounces to `/signin/` on `"signed-out"`:

```diff
     async function ensureSession(): Promise<void> {
       if (isSignedIn()) {
         if (!cancelled) setSessionReady(true);
         return;
       }
-      const refreshed = await silentRefresh();
-      if (cancelled) return;
-      if (refreshed) setSessionReady(true);
-      else router.replace(SIGNIN_EXPIRED_PATH);
+      const result = await silentRefresh();
+      if (cancelled) return;
+      if (result === "ok") setSessionReady(true);
+      // Only a server-side rejection means "sign in again". A transport fault leaves the
+      // gate on its own 60s re-check (`EXPIRY_CHECK_INTERVAL_MS`) instead of throwing away
+      // a session that is probably fine — the offline case is a wait, not a logout.
+      else if (result === "signed-out") router.replace(SIGNIN_EXPIRED_PATH);
     }
```

**Alternatives considered and rejected:**

- *Only fix `build-worker.mjs`.* It fixes the outage but leaves the amplifier in place: any
  future API-origin misconfiguration, CORS failure, or 502 still logs every user out of a valid
  session. Part B is the reason this bug had a 100%-of-users blast radius instead of an
  error toast.
- *Have the worker import `API_URL` at call time from a `postMessage`-supplied value.* Removes
  the build-time inlining problem entirely, and was tempting. Rejected: it adds a
  main-thread→worker configuration handshake with its own ordering hazard, to solve a problem a
  three-line `define` fix and a build assertion solve outright. The worker's self-containment
  is deliberate (`factory.ts:7-13`).
- *Show a blocking "reconnecting" screen on `"unreachable"`.* Rev 1 rejected this on the
  grounds that `OfflineBanner` already covers it. **That was wrong — see the sub-fix below.**

**Part C (added in rev 2) — `"unreachable"` must render *something*.**

Rev 1 claimed `OfflineBanner` mitigates the unreachable case. Re-verified, it cannot:

```tsx
// app/(protected)/layout.tsx:17-22
  return (
    <RequireAuth>
      <OfflineBanner />
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
```

`OfflineBanner` mounts **inside** `RequireAuth`'s children, and `require-auth.tsx:70` is
`if (!sessionReady) return null;`. In the `"unreachable"` state `sessionReady` never flips, so
the gate renders `null` and the banner is never mounted at all. It is doubly unreachable:
`OfflineBanner` reads `useConnectivity()`, whose `wsConnected`/`authExpired` come from
`apiSocket`, and `apiSocket.connect()` is only called from `use-sync-snapshot.ts` — which also
mounts inside the gate. So without this addition, Fix 2 turns "an unexplained sign-out" into
"an indefinite blank page with a silent 60-second retry", which is better but still a silent
failure.

The smallest honest fix is a third branch in `RequireAuth`, alongside the `locked-out` one it
already has (`:80-93`) and in the same visual language:

```diff
   const [sessionReady, setSessionReady] = useState(false);
+  /** Set when a refresh could not reach the server at all — distinct from signed-out, which
+   *  redirects. Without this the gate renders `null` forever and the user sees a blank page
+   *  with no explanation: `OfflineBanner` mounts INSIDE this gate and can never help here. */
+  const [unreachable, setUnreachable] = useState(false);
@@
       const result = await silentRefresh();
       if (cancelled) return;
-      if (result === "ok") setSessionReady(true);
-      else if (result === "signed-out") router.replace(SIGNIN_EXPIRED_PATH);
+      if (result === "ok") {
+        setUnreachable(false);
+        setSessionReady(true);
+      } else if (result === "signed-out") {
+        router.replace(SIGNIN_EXPIRED_PATH);
+      } else {
+        setUnreachable(true);
+      }
     }
@@
+  if (!sessionReady && unreachable) {
+    return (
+      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
+        <p className="max-w-sm text-sm text-muted-foreground">{copy.session.cantReachServer}</p>
+        <Button type="button" onClick={() => void ensureSessionNow()}>
+          {copy.session.retryCta}
+        </Button>
+      </main>
+    );
+  }
   if (!sessionReady) return null;
```

with copy that says what is happening and does not blame the user, e.g.
`cantReachServer: "Can't reach Kvy right now. We'll keep trying."` and `retryCta: "Try
again"`. Note it must go **before** the bare `if (!sessionReady) return null;`, and that the
existing test *"never renders children on the pre-effect pass"* still passes because
`unreachable` starts `false`.

*Alternative considered:* move `OfflineBanner` outside `RequireAuth` in
`(protected)/layout.tsx`. Rejected — its own docblock records that it was deliberately moved
*into* the gate because on routes where no socket is attempted its signals "never reflect
anything real" (known-issues.md, quoted at `OfflineBanner.tsx:6-17`). Hoisting it would
reintroduce that bug to fix a different one. A dedicated gate state is the correct shape.

### Testing

- `packages/web/src/lib/__tests__/session.test.ts` — its three `silentRefresh` cases
  (`"resolves false without touching the token when no unlocked bridge is available"`,
  `"mints a fresh access token…"`, `"clears the token and resolves false when the bridge has
  nothing to refresh with"`) all assert `toBe(false)`/`toBe(true)` and **must be rewritten** for
  the tri-state. Add a fourth: an `{kind:"unreachable"}` outcome must **not** clear the token.
- `packages/web/src/crypto/__tests__/worker-handler.test.ts` — add cases for 401 → `rejected`,
  404 → `unreachable`, network throw → `unreachable`, and no stored credential →
  `no-credential`. **Correction to rev 1:** these are *new*, not updates. There is **no
  existing `refreshSession` test at all** (`grep -c refreshSession` on that file → 0); the
  Phase-4a matrix entry at `auth-ux-overhaul-plan.md:2432` ("works in a fresh worker with no key
  material") was specified and never implemented. The file only exercises `setRefreshToken`
  (:218). Worth adding the never-implemented case too while the fixtures are open.
- `packages/web/src/features/auth/__tests__/require-auth.test.ts` — the source-text test at
  `"a failed silentRefresh() redirects to SIGNIN_EXPIRED_PATH, not plain SIGNIN_PATH"` greps for
  `router.replace(SIGNIN_EXPIRED_PATH)` after `const refreshed = await silentRefresh();`. That
  exact literal changes; update the grep anchor to `const result = await silentRefresh();` and
  add an assertion that the redirect is guarded by `=== "signed-out"`.
- **New, and the important one:** a build-script test asserting `build-worker.mjs` emits an
  absolute API base. Cheapest form: run the script in a temp dir with the env var unset and
  assert the output contains `http://localhost:3005`. Put it in
  `packages/web/scripts/__tests__/build-worker.test.ts`.
- Live re-verification of E2E-4.1: reload `/dashboard/` with both IndexedDB stores populated
  and confirm exactly one `POST http://localhost:3005/v1/auth/refresh` fires and returns 200.

### Risk / blast radius

`refreshSession()`'s return type is a **wire-protocol change between the main thread and the
worker**. Both halves ship in the same bundle pair, so there is no skew risk in production, but
a stale `public/crypto-worker.js` left over from a previous build in a developer's working tree
*will* mismatch — `pnpm --filter @kvy/web dev` rebuilds it every start, so this is a
"delete `public/crypto-worker.js` if things get weird" footnote, not a design problem.

**There are four call sites plus one dependency type, not two** (rev 1 of this section
undercounted; re-enumerated with `grep -rn "silentRefresh" packages/web/src`). Every one is a
truthiness check today, and `"unreachable"` is **truthy**, so each silently changes meaning
unless updated in the same commit:

| Site | Today | Under the tri-state, if left alone | Required change |
|---|---|---|---|
| `features/auth/require-auth.tsx:56` | `const refreshed = await silentRefresh();` | — | handled by the diff above |
| `app/(public)/pair/page.tsx:66` | `if (!isSignedIn() && !(await silentRefresh()))` | An **offline visitor is treated as signed in**: skips `stashPendingPair` + the `/signin/` bounce and falls through to `fetchPairDetails` with no token | `!== "ok"` |
| `app/(public)/pair/page.tsx:109` | `token = (await silentRefresh()) ? getToken() : null;` | Returns a stale/`null` token and proceeds to `mintPairSession` | `=== "ok"` |
| `sync/index.ts:36` (`renewAccessToken`) | `const refreshed = await silentRefresh(); return refreshed ? getToken() : null;` | Hands `apiSocket` a stale-or-`null` token instead of `null`, so the socket retries with a dead credential rather than backing off | `=== "ok"` |
| `app/(public)/pair/pair-gate.ts:17` | dep typed `silentRefresh: () => Promise<boolean>` | **Compile error** — the one site the type system catches | widen the dep type; update `pair-gate.test.ts`'s four fakes (`:14`, `:28`, `:41`, `:52`) |

`pair/page.tsx:66` is the worst of the four: it is the identity gate 43 lines above the one
rev 1 did flag, and getting it wrong turns an offline visit to a pairing link into a token-less
request instead of a clean "sign in first". `pair-gate.ts` is the saving grace — it is a real
dependency-injected boundary, so `tsc` fails loudly there even though the three inline
truthiness checks would compile silently. **Do not rely on the compiler for the other three.**

`sync/apiSocket.ts` does **not** call `silentRefresh` directly (its `:150` comment explicitly
says it takes a `renewAccessToken` callback "rather than importing `lib/session.ts`'s
`silentRefresh`") — rev 1's "confirm with a grep" hedge resolves to: the caller is
`sync/index.ts:36`, and it is real.

---

## Fix 3 — A dead refresh token must trigger a real re-pair

**Status: ✅ Implemented — `ensureLoggedIn` gained the `{force?: boolean}` options param
(short-circuit skipped + `clearCredentials` called before pairing when `force: true`),
`runAuthLogin` now respects the caller's `homeDir` instead of always using
`resolveHomeDir()`, `runPreflightWithReauth` passes `{force: true}`, and the `??` →
`||` fix for `auth.message` landed too. `PreflightWithReauthDeps.ensureLoggedIn`'s type
widened to match. `index.ts:348` and `ensureCredentials.ts:22` needed no change (both
omit the third arg). Tests: `login.test.ts` gained `clearCredentials` to its mock factory
and the `force: true` mirror case (asserting `clearCredentials` runs before `writeCredentials`);
`startPreflight.test.ts`'s dead-token test now uses an `ensureLoggedIn` fake that models the
real short-circuit-unless-forced semantics instead of always re-pairing, plus an assertion
on the third call argument; `index.test.ts` needed no change (`EnsureLoggedInOptions` is
type-only, no new runtime export). Implemented exactly as specified, no deviation.**

### Root cause

`ensureLoggedIn()` decides "already signed in" from the **presence of a credentials file**, not
from whether the refresh token inside it still works. Web-side revocation is server-side only —
`~/.kvy/access.key` is never deleted — so when `runPreflightWithReauth()` detects a dead
token, prints `RECONNECTING`, and calls `ensureLoggedIn()` expecting it to re-pair, it gets
`{ok: true}` back without a single network call or QR code, and the second preflight
(correctly) fails again into `NO_TTY_CANNOT_SIGN_IN` — *at a real TTY, with a human present*.

### What was verified

Every claim in the report is confirmed verbatim.

- `packages/cli/src/auth/login.ts:77` — `if (readCredentials(homeDir)) return { ok: true };`
  is the first statement of `ensureLoggedIn` (which spans 73–87).
- `packages/cli/src/commands/startPreflight.ts:122-148` — `runPreflightWithReauth` writes
  `RECONNECTING` at :132, calls `deps.ensureLoggedIn(deps.logger, deps.homeDir)` at :133, calls
  `reloadDaemonAuth` at :141, re-runs `runPreflight` at :143, and hard-fails at :145.
- The dead-token detection is real and correct: `runPreflight` :97-102 calls
  `tokenProvider.getAccessToken()`, and `auth/tokenProvider.ts:68-74` sets `dead = true`
  **only** on HTTP 401 from `POST /v1/auth/refresh`. A network outage is correctly *not* a
  re-pair trigger.
- `readCredentials` (`auth/credentials.ts:81-90`) is a pure disk read + Zod parse; never throws,
  never touches the network. `clearCredentials` (:107-110) already exists and is exported; its
  only current caller is `auth/logout.ts:16`.

**Two additional findings the report did not have, both of which change the fix:**

1. **There are three real `ensureLoggedIn` call sites, not two.** `index.ts:348` inside
   `runStart()`, `auth/ensureCredentials.ts:22` (used by `commands/keysApprove.ts:81`), and the
   injected one at `startPreflight.ts:133`. A liveness check applied *unconditionally* inside
   `ensureLoggedIn` would fire **twice** per `kvy claude` — once at `index.ts:348` before the
   daemon even starts, once inside the preflight — costing two `POST /v1/auth/refresh` round
   trips per launch and, worse, printing `WELCOME_FIRST_RUN` and a QR code *before* the
   `RECONNECTING` line is ever written. So the new behaviour must be **opt-in per call site**.
2. **`runAuthLogin` ignores its caller's `homeDir`.** `login.ts:138` uses `resolveHomeDir()` and
   `:143` calls `writeCredentials(credentials)` with no `homeDir` argument, so an
   `ensureLoggedIn(logger, someOtherHome)` that falls through to pairing writes to the *default*
   home. Harmless today because the only non-default `homeDir` caller is
   `startPreflight.ts:133`, which passes the same value `resolveHomeDir()` would return — but it
   is a latent bug that this fix walks straight into, and should be corrected in the same diff.

### Affected files

- `packages/cli/src/auth/login.ts` (`ensureLoggedIn`, `runAuthLogin`)
- `packages/cli/src/commands/startPreflight.ts` (`PreflightWithReauthDeps.ensureLoggedIn` type,
  the call at :133)
- `packages/cli/src/index.ts` (`runStart`, :348 — no behaviour change, but must stay coherent)
- `packages/cli/src/auth/ensureCredentials.ts` (unchanged, but its contract is now explicit)
- Tests: `auth/login.test.ts`, `commands/startPreflight.test.ts`, `index.test.ts`

### Proposed fix

Add an options argument to `ensureLoggedIn` with a single `force` flag, and pass `force: true`
from `runPreflightWithReauth` — the *one* call site that has already proved the stored token is
dead. `ensureLoggedIn` deletes the stale credentials before pairing so the short-circuit cannot
re-trigger, and `runAuthLogin` learns to respect a caller-supplied `homeDir`.

**Why `force` and not "always verify":** the liveness answer already exists, computed by the
caller that needs it. `runPreflight` does a real `POST /v1/auth/refresh` and distinguishes
`isDead` (401) from `NETWORK_UNREACHABLE`. Duplicating that inside `ensureLoggedIn` would (a)
double the round trips on the hot path, (b) require `ensureLoggedIn` to grow a `backendUrl` +
`fetchImpl` dependency it does not have today, and (c) risk misclassifying an offline machine
as needing a re-pair — the exact mistake `resolveAccessToken` already makes by collapsing
"dead" and "unreachable" into `null`. Letting the site that *knows* say so is both smaller and
more correct.

**Alternatives considered and rejected:**

- *Have `runPreflightWithReauth` call `clearCredentials()` then `ensureLoggedIn()`.* Two lines,
  no signature change, tempting. Rejected: it makes credential deletion a side effect at a call
  site rather than a documented part of "start over and pair again", and it leaves
  `ensureLoggedIn`'s misleading contract ("returns ok if a file exists") intact for the next
  caller to trip over. It also destroys the credentials *before* the user has agreed to
  re-pair, so a Ctrl-C at the QR code leaves the machine worse off than before.
- *Have `runPreflightWithReauth` call `runAuthLogin()` directly.* Skips the TTY check that
  `ensureLoggedIn` owns (`login.ts:79-81`), duplicating a security-relevant branch. Rejected.
- *Make the daemon delete credentials when `tokenProvider.isDead` flips.* `machineClient.ts`
  sees the 401 first (its `connect_error` handler at :470-488). Rejected: the daemon is a
  background process with no user present; silently deleting the user's credentials from a
  background retry loop is exactly the kind of invisible destructive action principle 5 exists
  to prevent.

### Code

```diff
--- a/packages/cli/src/auth/login.ts
+++ b/packages/cli/src/auth/login.ts
@@
+/**
+ * `force: true` means the CALLER has already proved this machine's stored refresh token is
+ * dead (a real 401 from `POST /v1/auth/refresh` — see `startPreflight.ts`'s `isDead` check),
+ * so the credentials file on disk is worthless and must not be mistaken for being signed in.
+ *
+ * Revocation from Settings → Devices is server-side only: `access.key` survives it untouched.
+ * Without this flag, the first line below short-circuits and the entire "dead token → inline
+ * re-pair" path (AX-1.5) never runs — auth-ux-overhaul-e2e-results.md E2E-6.4, which
+ * reproduced 100% of the time.
+ */
+export interface EnsureLoggedInOptions {
+  force?: boolean;
+}
+
 export async function ensureLoggedIn(
   logger: Logger,
   homeDir: string = resolveHomeDir(),
+  options: EnsureLoggedInOptions = {},
 ): Promise<{ ok: true } | { ok: false; message: string }> {
-  if (readCredentials(homeDir)) return { ok: true };
+  if (!options.force && readCredentials(homeDir)) return { ok: true };
 
   if (process.stdin.isTTY !== true) {
     return { ok: false, message: NO_TTY_CANNOT_SIGN_IN };
   }
 
-  const code = await runAuthLogin(logger);
+  // Only now, with a TTY confirmed and pairing actually about to start, is it safe to drop
+  // the dead credentials — a Ctrl-C at the QR code then leaves the machine exactly as it
+  // was rather than worse off.
+  if (options.force) clearCredentials(homeDir);
+
+  const code = await runAuthLogin(logger, homeDir);
   // `runAuthLogin` already wrote a full explanation of what went wrong to stdout —
   // nothing further to say here, just propagate the failure.
   return code === 0 ? { ok: true } : { ok: false, message: "" };
 }
```

`runAuthLogin` gains the parameter it should always have had:

```diff
-export async function runAuthLogin(logger: Logger): Promise<number> {
+export async function runAuthLogin(
+  logger: Logger,
+  homeDir: string = resolveHomeDir(),
+): Promise<number> {
@@
-    const keyMaterial = await wrapNewKeyMaterial(outcome.result.masterSecret, resolveHomeDir());
+    const keyMaterial = await wrapNewKeyMaterial(outcome.result.masterSecret, homeDir);
@@
-    writeCredentials(credentials);
+    writeCredentials(credentials, homeDir);
```

`PreflightWithReauthDeps` (`startPreflight.ts:111`) must widen or the new argument cannot be
passed — the dep type is currently *looser* than the real function, which is what let this
compile:

```diff
-  ensureLoggedIn: (logger: Logger, homeDir: string) => Promise<{ ok: boolean; message?: string }>;
+  ensureLoggedIn: (
+    logger: Logger,
+    homeDir: string,
+    options?: { force?: boolean },
+  ) => Promise<{ ok: boolean; message?: string }>;
```

and the call site:

```diff
   deps.write(RECONNECTING);
-  const auth = await deps.ensureLoggedIn(deps.logger, deps.homeDir);
+  // `force`: we got here because `runPreflight` above saw a real 401 on the stored refresh
+  // token. The credentials FILE still exists (web revocation never deletes it), so without
+  // this the helper reports "already signed in" and no pairing ever starts.
+  const auth = await deps.ensureLoggedIn(deps.logger, deps.homeDir, { force: true });
```

One more line worth fixing while here — `startPreflight.ts:135` uses `??`, so
`ensureLoggedIn`'s deliberate `message: ""` passes through and **nothing is written to
stderr**, leaving a cancelled re-pair with no explanation. `auth/ensureCredentials.ts:23`
already uses `||` for the same expression. Align them:

```diff
-    return { ok: false, reason: "error", message: auth.message ?? NO_TTY_CANNOT_SIGN_IN };
+    return { ok: false, reason: "error", message: auth.message || NO_TTY_CANNOT_SIGN_IN };
```

`index.ts:348` and `auth/ensureCredentials.ts:22` need **no change** — they omit `options`, get
`force: false`, and keep today's fast path. That is the whole point of making it opt-in. Nor do
`start.ts:425` / `startCodex.ts`, which inject `typeof ensureLoggedInDefault` and therefore
absorb the new optional parameter with no edit.

One import the diff above depends on and does not show: `login.ts:28` currently imports
`{ type KvyCredentials, readCredentials, writeCredentials }` from `./credentials.js` —
`clearCredentials` must be added to that list. (`tsc` catches it; noted so the diff is
self-contained.)

### Testing

- `packages/cli/src/auth/login.test.ts` — the case at :147-157 ("returns ok when credentials
  exist, never calls pairDevice") pins the current short-circuit and stays valid as the
  `force`-absent case. **Add** its mirror: with credentials present, `isTTY = true`, and
  `{ force: true }`, assert `pairDeviceMock` **was** called and `clearCredentials` was called
  first. The `vi.mock("./credentials.js")` factory at :13-16 currently stubs only
  `writeCredentials`/`readCredentials` and must gain `clearCredentials`.
  The case at :188-196 uses `toEqual({ok:false, message:""})` — exact object equality, so do
  not add fields to the failure arm.
- `packages/cli/src/commands/startPreflight.test.ts` — the dead-token test at :58-88 stubs
  `ensureLoggedIn` with a fake that *does* re-pair (flipping a `paired` flag), which is exactly
  what masked this bug. **Replace that stub with one that consults `readCredentials`**, so it
  models the real function: it must re-pair only when handed `{ force: true }`. Also assert
  `ensureLoggedIn` was called with the third argument. Every stub at :40, :71, :99, :111, :127
  needs the widened signature.
- `packages/cli/src/index.test.ts` — the `mockSignedIn()` helpers at :492-497 and :643-648
  `vi.doMock("./auth/login.js", …)` and **enumerate the module's exports**. Adding
  `EnsureLoggedInOptions` is type-only (safe), but adding any new *runtime* export to
  `login.ts` breaks both mocks. Keep the fix export-free, or update both.
- `packages/cli/src/ui/messages.test.ts` — no new message constants are introduced, so its two
  guards (`kvy auth login` only alongside `no terminal here`; no `masterSecret|keyEpoch|
  ephPub|DEK|custody|\bbind\b`) are unaffected. Do not add a new string here without checking
  them.
- Integration (the actual E2E-6.4 repro): revoke the CLI daemon from Settings → Devices, run
  `kvy claude --model haiku` in a TTY, expect `Your session expired. Reconnecting…` followed
  by a **QR code**, approve in the browser, land in a session. Then send a message and confirm
  the web decrypts it — that is E2E-6.4's untested "critical half", and this fix is what
  unblocks it.

### Risk / blast radius

`ensureLoggedIn` is the CLI's single sign-in gate for every provider (`index.ts:346-348`'s
comment records that `codex` was deliberately brought under it as AX-1.1). Making the new
behaviour opt-in means the default path is byte-identical, which keeps the risk to the one
changed call site.

The genuinely destructive line is `clearCredentials(homeDir)`. It is placed **after** the TTY
check and **immediately before** `runAuthLogin`, so it only ever runs when a human is present
and pairing is starting. It is still a real data deletion — if pairing then fails, the machine
is signed out rather than holding a dead token, which is the honest state but is a change from
today. The failure message the user sees is `describeFailure`'s prose, and `runAuthLogin`
already writes it.

Note also `runStart`'s ordering constraint (documented at `index.ts:333-343`): login must
precede `ensureDaemon()` because the daemon registers its machine exactly once at startup. This
fix does not move anything across that boundary — the re-pair still happens later, inside the
preflight, which is precisely why `reloadDaemonAuth` (`startPreflight.ts:141`) exists.

---

## Fix 4 — Key material must be bound to the account it belongs to

**Status: ✅ Implemented — Part A (password sign-up always provisions fresh, reuse branch
deleted), Part A2 (OAuth sign-in scoped, 409→needs-keys added to the effect's own catch as
well as `handleProtectionChoice`'s), Part B (`StoredKeyRecordV2.accountId`, `belongsTo`,
`loadedForAccount`, account-aware `describeStorage`/`getIdentity`/`ensureLoaded`), and Part C
(`useCryptoBridgeStatus(accountId)`, threaded through `require-auth.tsx` and `pair/page.tsx`)
all implemented. `password/page.tsx`'s post-sign-in `getIdentity()` also scoped (it runs
after `setToken`, unlike the OAuth pre-check, so unlike that one it CAN be scoped).
**Deviations from the plan's exact diffs, all adaptations of stated intent:** (1) `init`'s
`accountId` was made a REQUIRED parameter (not optional) on both the protocol
(`InitRequest`) and client (`CryptoBridgeClient.init`) — every real caller already has an
authenticated session by the time it calls `init`, so "every newly written record is
tagged" only holds if the parameter can't be silently omitted; this required updating
`rotateKeyEpoch`/`rotateKeyEpochOAuth` (compute `accountId` before `init`, not just before
`bindKeysProof`) and ~4 test files that called `.init()` with the old 3-arg shape. (2)
`persistKeyMaterial` threads `accountId` through `init` only, NOT through `migrateFromPin`
or `acceptKeyResponse` (both pass `undefined`) — this matches the plan's own stated
scope/caveat ("an omitted call site is a silently unprotected path, not a compile error");
threading it through those two would have expanded the file list beyond what the plan
specified. (3) `ensureLoaded`'s in-memory fast path (`if (keyTree) return true`) was
extended with a `loadedForAccount` check, but treats `loadedForAccount === null` as
*permissive* (not foreign) — needed because `migrateFromPin` doesn't tag `loadedForAccount`,
and a strict check would have wrongly refused the legitimate "just migrated from v1, `refresh()`
immediately re-evaluates" case. New `complete-oauth-sign-in.test.ts` created (file didn't
exist). `worker-handler.test.ts` gained an "account scoping" describe block (4 new cases:
foreign-refuses-all-three, own-account-succeeds, untagged-adopted-and-stamped,
no-accountId-stays-permissive). `oauth-callback-page.test.ts` gained a case for the effect's
own 409 catch. `complete-password-sign-in.test.ts`'s stale "reuses an existing identity"
test replaced with the regression case the plan specifies.**

### Root cause

The browser's key store holds exactly one record in one fixed slot
(`key-storage.ts:67` — `RECORD_KEY = "keyRecord"`), and `StoredKeyRecordV2`
(`key-storage.ts:28-38`) has no account field. Nothing in the crypto layer knows *whose* keys
these are, so `getIdentity()`'s "a record exists" is treated app-wide as "this browser already
knows this identity" — for whatever account happens to be signed in.

### What was verified, and where the report was wrong

**Confirmed:**

- `worker-handler.ts:290-307` (`getIdentity`) returns from in-memory `keyTree` if present,
  else `storage.load()` → `identityFrom(record)`. **No account check of any kind.**
- `complete-password-sign-in.ts:96-113` is exactly as reported:
  `let identity = await bridge.getIdentity(); const isNewIdentity = !identity;` then
  `if (!identity) { …init… }`, then `bindKeysProof(accountId, nonce)` at :122 with whatever key
  tree happens to be loaded.
- `completePasswordSignIn` (:142-151) never touches the crypto layer at all and returns no
  account id — `password/page.tsx:57` does a bare `bridge.getIdentity()` with no account
  context.

**Refuted — and this matters for how the fix is scoped.** The report's worst case ("`keys/bind`
on the server will actually accept and permanently register that OTHER account's public key
against the NEW account") **cannot happen** while the other account still exists.
`packages/server/src/app/routes/keys.ts:207-214`:

```ts
const conflict = await db.query.accounts.findFirst({
  where: and(eq(accounts.signPublicKey, signPublicKeyHex), ne(accounts.id, request.accountId)),
});
if (conflict) return reply.code(409).send({ error: "Key already bound to another account" });
```

So the well-formed-leftover sign-up path ends in a **409**, which `password/page.tsx:90-92`
catches and converts into `status: "needs-keys"` — i.e. the user is shown "One more step" and
asked to fetch keys for an account that has none, forever. Bad, but not a silent
cross-account key binding.

**The residual hole is narrower and still real:** the conflict check is against *live account
rows*. A leftover record from an account that was deleted, or whose `signPublicKey` has since
been rotated away by `/reset-keys/`, passes the check — and the new account permanently binds
key material derived from a master secret that another party may still hold. And **failure mode
(a) is completely unguarded**: signing *in* as account B on a browser holding account A's keys
produces `status: "ready"`, a worker loaded with A's key tree, and `setSessionKey` silently
returning `false` for every one of B's sessions.

**One further finding the report did not have, and it is the cleanest part of the fix:** the
`isNewIdentity` reuse branch is not merely under-guarded, it is **logically wrong**.
`passwordRegister` returns a real token *only* for a genuinely new account — the
already-registered case returns `{token: "", refreshToken: ""}` and is handled at
`complete-password-sign-in.ts:86-93` as `{kind: "existing-account"}`, returning early. So by
the time line 96 runs, a brand-new account has just been created, and **it is impossible for
this browser to legitimately hold its key material**. The `if (!identity)` guard can only ever
be wrong.

### Affected files

- `packages/web/src/lib/complete-password-sign-in.ts` (`completePasswordSignUp`,
  `completePasswordSignIn`)
- **`packages/web/src/lib/complete-oauth-sign-in.ts`** (`completeOAuthSignIn`) — the
  production sign-in path; see [Part A2](#part-a2--the-oauth-path-has-the-same-bug-and-is-not-deletable)
- **`packages/web/src/components/auth/oauth-callback-page.tsx`** (the pre-check at :82 and the
  effect's `catch` at :100-106)
- `packages/web/src/crypto/key-storage.ts` (`StoredKeyRecordV2`)
- `packages/web/src/crypto/worker-handler.ts` (`getIdentity`, `describeStorage`, `ensureLoaded`,
  `init`, `acceptKeyResponse`, `persistKeyMaterial`)
- `packages/web/src/crypto/protocol.ts` (three request shapes)
- `packages/web/src/crypto/client.ts` (three signatures)
- `packages/web/src/lib/use-crypto-bridge-status.ts` (thread the account id)
- `packages/web/src/features/auth/require-auth.tsx`, `app/(public)/password/page.tsx`,
  `app/(public)/pair/page.tsx` (pass it in)
- Tests: `lib/complete-password-sign-in.test.ts`, `crypto/__tests__/worker-handler.test.ts`

### Proposed fix

**Part A — a new account always provisions new keys. Delete the reuse branch.**

```diff
   setToken(token);
 
-  let identity = await bridge.getIdentity();
-  const isNewIdentity = !identity;
-  if (!identity) {
-    await ready;
-    const masterSecret = getRandomBytes(32);
-    await bridge.init(masterSecret, refreshToken, protection);
-    identity = await bridge.getIdentity();
-  }
-  if (!identity) {
-    throw new Error("crypto bridge failed to provision an identity");
-  }
-  if (!isNewIdentity) {
-    // Reusing an already-provisioned identity (this browser signed up before) — `init`
-    // above didn't run, so the fresh refresh token still needs persisting. …
-    await bridge.setRefreshToken(refreshToken);
-  }
+  // Reaching this line means `passwordRegister` returned a real session, which the server
+  // only does for a genuinely NEW account (the already-registered case is the blanked-token
+  // branch above). A brand-new account therefore cannot legitimately have key material on
+  // this browser — so ALWAYS provision fresh. The old `getIdentity()` reuse branch treated
+  // "some record exists" as "this account's record", which meant signing up on a browser
+  // that had ANY prior account's keys skipped `init` entirely and tried to bind the other
+  // account's public key (the server's own cross-account guard, routes/keys.ts:207, then
+  // 409s — so the user got an unexplained dead end instead of an account).
+  const accountId = decodeAccountId(token);
+  await ready;
+  const masterSecret = getRandomBytes(32);
+  await bridge.init(masterSecret, refreshToken, accountId, protection);
+  const identity = await bridge.getIdentity(accountId);
+  if (!identity) {
+    throw new Error("crypto bridge failed to provision an identity");
+  }
 
-  const accountId = decodeAccountId(token);
   const { nonce } = await keysChallenge(token);
```

#### Part A2 — the OAuth path has the same bug, and is **not** deletable

`lib/complete-oauth-sign-in.ts:56-63` is a byte-for-byte sibling of the pattern Part A kills:

```ts
  let identity = await bridge.getIdentity();
  const isNewIdentity = !identity;
  if (!identity) {
    await ready;
    const masterSecret = getRandomBytes(32);
    await bridge.init(masterSecret, refreshToken, protection);
    identity = await bridge.getIdentity();
  }
```

and `isNewIdentity` additionally gates the whole `keysChallenge`/`bindKeysProof`/`keysBind`
block at :72-82. This matters more than the password path, not less: `/password/` **404s in
production** by its own header (`page.tsx:29`), so OAuth is *the* production sign-in. Shipping
Part A alone would leave the dev-only path protected and the production path not.

**The fix here is different, and Part A's deletion would be wrong.** `POST /v1/auth/register`
is find-or-create — `routes/oauth.ts:130-150` looks up `authIdentities` by
`(kind, identifier)` and only inserts an account when there is no match — so unlike
`passwordRegister`, a returning user legitimately reaches this code on a browser that already
holds *their* keys. Reuse is correct; it is just unscoped. Thread the account id instead:

```diff
   const { token, refreshToken } = await register({ oauthProvider: provider, oauthProof });
   setToken(token);
 
-  let identity = await bridge.getIdentity();
+  // Scoped to THIS account. Unscoped, "a record exists" meant "this account's record", so
+  // signing in as B on a browser holding A's keys reused A's key tree, skipped the bind
+  // entirely, and left every one of B's sessions failing `setSessionKey` in silence.
+  // Unlike the password path this branch is NOT deletable — `/v1/auth/register` is
+  // find-or-create (server/src/app/routes/oauth.ts:130-150), so a returning user reusing
+  // their own key material is the normal case.
+  const accountId = decodeAccountId(token);
+  let identity = await bridge.getIdentity(accountId);
   const isNewIdentity = !identity;
   if (!identity) {
     await ready;
     const masterSecret = getRandomBytes(32);
-    await bridge.init(masterSecret, refreshToken, protection);
-    identity = await bridge.getIdentity();
+    await bridge.init(masterSecret, refreshToken, accountId, protection);
+    identity = await bridge.getIdentity(accountId);
   }
@@
   if (isNewIdentity) {
-    const accountId = decodeAccountId(token);
     const { nonce } = await keysChallenge(token);
```

**The ordering constraint the review's sketch missed.** `oauth-callback-page.tsx:82` does the
same bare `bridge.getIdentity()`, and it is the gate that decides between "ask how to protect
keys" and "reuse silently" — but it runs **before** `register()` is called (`register` happens
inside `completeOAuthSignIn` at :92, or in the step-up branch at :64), so **there is no access
token and therefore no account id available at :82.** It cannot be account-scoped. Leave it as
what it honestly is — a cheap "does this browser have any keys at all" pre-check — and make
`complete-oauth-sign-in.ts:56` the authoritative, account-scoped one, with a comment at :82
saying so.

That leaves one reachable gap, and it already has a fix precedent three lines away. When the
page guesses "reuse" but the scoped check finds a foreign record, `completeOAuthSignIn` now
takes the `init` path with the `{mode: "device"}` protection the effect passes at :93, then
`keysBind` non-rotate returns **409 "Key mismatch; rotation must be explicit"**
(`routes/keys.ts:191-193`) because the real account already has keys bound elsewhere. Today
that surfaces as a generic error, because the effect's `catch` at :100-106 has no 409 branch —
even though `handleProtectionChoice` at :123-127 already has exactly the right one:

```diff
       } catch (err) {
         if (cancelled) return;
+        if (err instanceof ApiError && err.status === 409) {
+          // The account's keys are bound on another device — this browser can't first-bind.
+          // Fetching them is the non-destructive answer, same as `handleProtectionChoice`.
+          setStatus({ kind: "needs-keys", nextUrl: "/dashboard/" });
+          return;
+        }
         setStatus({
           kind: "error",
```

**Accepted consequence, stated as plainly as the password path's.** `bridge.init` has already
overwritten the previous record by the time the 409 arrives, so account A's key material is
destroyed by an OAuth sign-in as B even though B's bind then fails. This is the *same*
documented posture `rotateKeyEpochOAuth` already carries in its docblock
(`complete-password-sign-in.ts:228-233`: "a proof the server later rejects has already
overwritten this browser's previous wrapped record"). It is a wart, and it is the exact wart
the rejected **Option 3** below (a route that reads the account's bound public key) would
remove, by letting the client know *before* initing. Recorded here so the follow-up has a
concrete motivation rather than being theoretical.

**Why not centralise the two paths into one shared helper?** Tempting, and rejected: the two
`register` endpoints have materially different semantics — password-register is
create-only-if-new (blank tokens otherwise), OAuth-register is find-or-create — which is
precisely why one path must *always* `init` and the other must *sometimes* reuse. A shared
helper would have to take that policy as a flag, which is the same branch with more
indirection. Keep them siblings; make them *consistent* (same account-id threading, same
409 → `needs-keys` conversion), which is what the diffs above do.

**Part B — tag the record with its account and refuse to answer for a foreign one.**

```diff
 export interface StoredKeyRecordV2 {
   v: 2;
+  /**
+   * Which account this key material belongs to (the access token's `sub`). Absent on
+   * records written before this field existed — see `ensureLoaded`'s legacy-adoption note.
+   *
+   * This slot has always been single-tenant, but nothing recorded WHOSE keys were in it, so
+   * signing into a second account on the same browser produced a worker loaded with the
+   * first account's key tree and a silent `setSessionKey` failure on every session.
+   */
+  accountId?: string;
   mode: KeyWrapMode;
```

The worker's three account-aware branches take an optional `accountId` and treat a mismatch as
"there is nothing here":

```diff
         case "describeStorage": {
           const record = await storage.load();
-          if (!record) {
+          if (!record || !belongsTo(record, request.accountId)) {
             return {
               id: request.id,
               ok: true,
               result: { present: false, version: 2, mode: null, credentialId: null },
             };
           }
```

```diff
         case "getIdentity": {
-          if (keyTree) {
+          if (keyTree && loadedForAccount === (request.accountId ?? loadedForAccount)) {
             return { …from keyTree… };
           }
           const record = await storage.load();
           return {
             id: request.id,
             ok: true,
-            result: record ? identityFrom(record) : null,
+            result: record && belongsTo(record, request.accountId) ? identityFrom(record) : null,
           };
         }
```

with the predicate and the migration policy stated where it lives:

```ts
/**
 * Does this record belong to the account asking?
 *
 * `undefined` on either side is permissive, deliberately:
 *  - a caller with no account id yet (a pre-sign-in `describeStorage`) gets today's answer;
 *  - a record written before `accountId` existed is ADOPTED by the first account that asks,
 *    and stamped on the next successful `ensureLoaded`.
 *
 * Adoption is the honest trade, not an oversight. The strict alternative — treat every
 * untagged record as foreign — would show "One more step" to every existing single-device
 * user, whose only exit is `/reset-keys/` and permanent loss of their sessions. Adoption
 * mis-tags only the browsers that already have the cross-account collision this fix is
 * about, and those were already broken. The residual risk is bounded by the server: a
 * wrongly-adopted key cannot be re-bound to a second account while the first still holds it
 * (`server/src/app/routes/keys.ts:207-214`).
 */
function belongsTo(record: AnyStoredKeyRecord, accountId?: string): boolean {
  if (!accountId || !isV2Record(record) || record.accountId === undefined) return true;
  return record.accountId === accountId;
}
```

`ensureLoaded` refuses a foreign record when it is *given* an account id, and stamps a legacy
one on the way through; `init`/`acceptKeyResponse` pass the account id into
`persistKeyMaterial` so every newly written record is tagged. The worker keeps one new
closed-over variable, `loadedForAccount: string | null`, reset by `resetMemory()` alongside
`keyTree`.

**Scope of the in-worker enforcement, stated precisely.** The worker's *internal*
`ensureLoaded()` calls have no account id to pass — `setSessionKey:246`, `bindKeysProof:310`,
`sealForPeer:335` and `sealKeysForPeer:399` all call the zero-argument form. So the guarantee
is **not** "the worker can never operate under the wrong key tree"; it is "the worker never
*loads* a foreign record through an account-aware entry point, and once `loadedForAccount` is
set, the in-memory tree is the one that entry point admitted." The real enforcement boundary is
the main-thread gating that precedes those calls (`useCryptoBridgeStatus` → `no-keys` →
`RequestKeysPanel`). That is adequate — every path to `setSessionKey` runs behind a `ready`
status — but it is a layered defence, not an airtight one, and should not be described as more.

**Part C — make the status hook account-aware.** `useCryptoBridgeStatus()` currently evaluates
as soon as the worker exists, which on a cold load is *before* `RequireAuth`'s session effect
has minted an access token — so `getAccountId()` would be `null` and the whole check would be
permissive. Give the hook the account id as a parameter and hold `{kind:"loading"}` until it
arrives:

```diff
-export function useCryptoBridgeStatus(): { status: BridgeStatus; refresh: () => Promise<void> } {
+export function useCryptoBridgeStatus(accountId: string | null): {
+  status: BridgeStatus;
+  refresh: () => Promise<void>;
+} {
   const bridge = useCryptoBridge();
   const [status, setStatus] = useState<BridgeStatus>({ kind: "loading" });
 
   const evaluate = useCallback(async (): Promise<void> => {
-    if (!bridge) return;
-    const stored = await bridge.describeStorage();
+    // No account id yet means no session yet — evaluating now would answer "are there keys
+    // here" without being able to ask "whose". Stay `loading`; RequireAuth renders nothing
+    // until `sessionReady` anyway, and re-runs this the moment the id appears.
+    if (!bridge || !accountId) return;
+    const stored = await bridge.describeStorage(accountId);
     …
-    setStatus((await bridge.ensureLoaded(wrapKey)) ? { kind: "ready", bridge } : { kind: "no-keys" });
-  }, [bridge]);
+    setStatus(
+      (await bridge.ensureLoaded(accountId, wrapKey)) ? { kind: "ready", bridge } : { kind: "no-keys" },
+    );
+  }, [bridge, accountId]);
```

`RequireAuth` passes `getAccountId()` (already exported from `lib/session.ts:69-74`, reading
the access token's `sub`), re-reading it when `sessionReady` flips. The net user-visible effect
of a mismatch is the *right* one: `describeStorage` reports absent → `status.kind === "no-keys"`
→ `RequestKeysPanel`. Signing into a second account on a shared browser now offers to fetch
that account's keys instead of silently failing to decrypt.

### Alternatives considered and rejected

- **Key the storage slot per account** (`RECORD_KEY = \`keyRecord:${accountId}\``). Genuinely
  attractive: cross-account confusion becomes impossible by construction, and switching between
  two accounts on one browser *works* instead of trampling. Rejected for now on two grounds.
  First, it silently retains every account's key material on the device forever, which is a
  privacy regression against today's single-slot-wiped-on-logout behaviour and would need its
  own eviction policy and its own honest UI label. Second, it needs the same account-id
  threading as the accepted fix, so it is strictly more work for a benefit (multi-account
  switching) nobody has asked for. Worth revisiting if multi-account lands as a feature.
- **Validate against the server's bound key instead of a local tag.** Authoritative, needs no
  storage change and no migration, and it catches something this fix does *not*: a record from a
  stale key epoch (a browser holding pre-rotation keys for the *right* account). Rejected as the
  primary fix because there is currently **no route that reads an account's bound public keys** —
  `routes/keys.ts` exposes only `challenge` and `bind` — so it requires new server surface, and
  it puts a network round trip in front of every page's readiness check. It is the natural
  follow-up, and the accepted fix does not block it.
- **Wipe the key store on every sign-in.** Trivially correct for case (a) and catastrophic in
  general — it would destroy the key material of a user who signs in twice.

### Accepted consequence, stated plainly

The slot stays single-tenant. Signing up or pairing a second account on the same browser still
**replaces** the first account's local key material (`init` overwrites). What changes is that
the replacement is now the result of a deliberate act (the user completing sign-up or
approving a key fetch), never a silent side effect of `getIdentity()` guessing. Between signing
in as B and B's keys arriving, A's record sits untouched — so a user who signs back into A
before finishing B's key fetch loses nothing.

### Testing

- `packages/web/src/lib/complete-password-sign-in.test.ts` — its `fakeBridge()` helper and
  every `completePasswordSignUp` case need the new `init` arity. **Add** the regression case:
  a bridge whose `getIdentity` returns a *different* account's identity must still see `init`
  called exactly once, and `bindKeysProof` must be called with the newly-registered account id.
  Today that test would fail.
- **`packages/web/src/lib/complete-oauth-sign-in.test.ts`** — check whether this file exists
  before assuming it does; if not, it is worth creating for Part A2 alone. Assert three cases:
  `getIdentity(accountId)` returning **this** account's identity → `init` is **not** called and
  `keysBind` is skipped (the legitimate reuse that must survive); returning `null` (a foreign or
  absent record) → `init` **is** called with the account id and `keysBind` runs; and `keysBind`
  throwing a 409 → surfaced to the caller so `oauth-callback-page.tsx` can convert it.
- `packages/web/src/components/auth/oauth-callback-page.test.ts` **exists** — extend it with a
  source-text assertion that the effect's `catch` handles `err.status === 409` the same way
  `handleProtectionChoice` already does, since that asymmetry is the actual gap.
- `packages/web/src/crypto/__tests__/worker-handler.test.ts` — new cases against
  `createMemoryKeyStorage(record)`: a record tagged `"acct-A"` queried with `"acct-B"` →
  `describeStorage` reports `present: false`, `getIdentity` returns `null`, `ensureLoaded`
  returns `false`; the same queried with `"acct-A"` → all three succeed; an **untagged** record
  queried with any id → adopted, and a subsequent `storage.load()` shows the id stamped.
- `packages/web/src/lib/__tests__/copy.test.ts` is unaffected (no user-facing strings change),
  but note its `/bridge/i` and `/key material/i` bans if any error copy is added.
- Live: sign in as account B on a browser holding account A's keys; expect "One more step",
  not a dashboard full of undecryptable sessions.

### Risk / blast radius

This is the largest surface in the plan. Three of the worker's eighteen RPC ops change
signature, and `useCryptoBridgeStatus()` — consumed by `require-auth.tsx:45`,
`pair/page.tsx`, and any other key-gated surface — gains a required parameter. Grep for
`useCryptoBridgeStatus(` and `describeStorage(`/`ensureLoaded(`/`getIdentity(` before landing;
`use-machine-crypto.ts` and `features/session-control/**` are the likely additional callers.

**`getIdentity()` has four known callers and they must all be triaged, not just the two in
Part A/A2:** `complete-password-sign-in.ts:96` and `:174` (inside `rotateKeyEpoch`),
`complete-oauth-sign-in.ts:56`/`:62`, `oauth-callback-page.tsx:82`, and
`password/page.tsx:57`. The parameter is optional (`belongsTo` is permissive without it), so
every un-updated caller keeps today's behaviour and nothing breaks — which is exactly the
hazard: **an omitted call site is a silently unprotected path, not a compile error.** The two
that cannot be account-scoped for real ordering reasons — `oauth-callback-page.tsx:82` (no
token yet, see Part A2) and `rotateKeyEpoch:174` (reads back the identity it just provisioned)
— should each carry a one-line comment saying why, so the next reader can tell "deliberately
unscoped" from "missed".

The storage-shape change is **additive and optional**, so no migration step is needed and a
downgrade still reads the record fine (an older build ignores `accountId`). That is deliberate:
the E2E pass already showed what a hard storage-format break does to a user
(`describeStorage` reporting `version: 1` and stranding them on a migration prompt).

Land this **after** Fix 2. Part C depends on `getAccountId()` returning a real value on a cold
load, which today it does not, because `silentRefresh()` never succeeds.

---

## Fix 5 — Logout must delete the databases, not just empty them

**Status: ✅ Implemented — `destroy()` added to `KeyStorage`/`SessionStorage` (both IndexedDB
and memory doubles), the worker's `"clear"` RPC now calls `destroy()` on both stores,
`terminateSharedCryptoBridge()` added to `use-crypto-bridge.ts`, and `logout()` calls it as
step 0 (before wiping), wrapped in the same try/catch-and-continue posture as the existing
wipe step. Memory doubles' `destroy()` implemented independently (not delegating to
`clear()`) so tests can assert `destroy()` ran and `clear()` did not. Tests: `logout.test.ts`
updated for the 4-step order plus a new "throwing stopSharedBridge still lets the rest of
logout run" case; `worker-handler.test.ts` gained a case asserting `"clear"` calls
`destroy()` not `clear()` on both stores via `vi.spyOn`. Checked `sync/**` and
`features/session-control/**` for `bridge.open()` callers per the plan's risk note — none
exist, so `terminateSharedCryptoBridge()`'s in-flight-rejection behavior has no call site to
regress. Implemented exactly as specified, no deviation.**

### Root cause

`clear()` in both storage modules deletes **one record key** from its object store and never
calls `indexedDB.deleteDatabase()`. `key-storage.ts:110-122` does
`objectStore(STORE_NAME).delete(RECORD_KEY)`; `session-storage.ts:97-109` is the same shape. So
`kvy-crypto-bridge` and `kvy-session` survive logout as empty shells that
`indexedDB.databases()` keeps enumerating. `deleteDatabase` appears **nowhere** in
`packages/web`.

### What was verified

- Both `clear()` implementations confirmed at the cited lines. E2E-5.5's own finding stands:
  the object stores really are empty afterwards, so this is a tidiness defect, not a credential
  leak.
- **Both modules open and close a fresh `IDBDatabase` per operation** (`openDb()` … `db.close()`
  in a `finally`, at `key-storage.ts:85/94`, `:98/107`, `:111/120` and the matching
  `session-storage.ts` lines). There is **no cached connection handle.** This is the key
  enabling fact: the worker can safely call `deleteDatabase` itself, because it holds no open
  connection to block on. The "delete from the main thread after the worker confirms" dance the
  brief anticipated is not necessary.
- `logout()` (`lib/logout.ts:32-41`) spins up a *throwaway* bridge and `await`s
  `bridge.clear()` — `client.ts:151` resolves only on the worker's acknowledgement — then
  `terminate()`s it in a `finally`. Ordering is already correct.
- **A second, related residue the report did not name:** `logout()` never touches the *shared*
  bridge singleton. `use-crypto-bridge.ts`'s `release()` only terminates after
  `RELEASE_GRACE_MS = 2000` and only when `refCount` reaches 0, and `logout()` calls neither.
  So for at least two seconds after "Log out", a worker holding the unwrapped key tree in
  memory is still alive and still returned by `getSharedCryptoBridge()`. Worse for this fix
  specifically: that worker can `describeStorage()` on a re-render and **re-create the database
  we just deleted.**

### Affected files

- `packages/web/src/crypto/key-storage.ts` (`KeyStorage` interface + IDB impl + memory double)
- `packages/web/src/crypto/session-storage.ts` (same)
- `packages/web/src/crypto/worker-handler.ts` (the `"clear"` case)
- `packages/web/src/lib/use-crypto-bridge.ts` (new `terminateSharedCryptoBridge()`)
- `packages/web/src/lib/logout.ts` (call it first)
- Tests: `crypto/__tests__/worker-handler.test.ts`, `lib/logout.test.ts`

### Proposed fix

Add `destroy()` to both storage interfaces, implemented as `clear()` followed by
`indexedDB.deleteDatabase(DB_NAME)`, and call it from the worker's `"clear"` case. Keep
`clear()` as-is so nothing else changes meaning.

```ts
/**
 * Wipe the record AND remove the database itself. `clear()` empties the store, which leaves
 * `kvy-crypto-bridge` enumerable by `indexedDB.databases()` after a sign-out
 * (auth-ux-overhaul-e2e-results.md E2E-5.5) — the data is gone, but "both are gone" was the
 * stated guarantee and an empty shell is not that.
 *
 * Safe to call from the worker: every operation in this module opens and closes its own
 * connection, so nothing here is holding one open for `deleteDatabase` to block on. The
 * `onblocked` path still resolves rather than hanging — a connection from ANOTHER context
 * (the shared bridge worker, a second tab) can block the delete, and logout is best-effort
 * past the crypto step by design (`lib/logout.ts`).
 */
async destroy() {
  await this.clear();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
```

```diff
         case "clear": {
-          await storage.clear();
-          await sessionStorage.clear();
+          await storage.destroy();
+          await sessionStorage.destroy();
           resetMemory();
           return { id: request.id, ok: true, result: null };
         }
```

And close the shared-worker window so nothing re-creates the databases behind us:

```diff
+/**
+ * Tear the shared worker down NOW, skipping `release()`'s 2-second grace. Logout only —
+ * that grace exists so a client-side route change doesn't churn the worker, which is the
+ * opposite of what sign-out wants: a worker still holding the unwrapped key tree, and still
+ * able to re-create the IndexedDB databases logout just deleted, is exactly the residue
+ * being removed.
+ */
+export function terminateSharedCryptoBridge(): void {
+  cancelPendingTerminate();
+  const instance = sharedBridge;
+  sharedBridge = null;
+  refCount = 0;
+  instance?.terminate();
+}
```

```diff
 export async function logout(deps: Partial<LogoutDeps> = {}): Promise<void> {
   const wipeKeyMaterial = deps.wipeKeyMaterial ?? wipeKeyMaterialWithThrowawayBridge;
+  const stopSharedBridge = deps.stopSharedBridge ?? terminateSharedCryptoBridge;
   …
+  // Step 0: stop the shared worker before wiping, so it can't answer a stray
+  // `describeStorage()` mid-teardown and re-open a database we're about to delete.
+  stopSharedBridge();
   try {
     await wipeKeyMaterial();
```

**Alternatives considered and rejected:**

- *Delete from the main thread after the worker acknowledges.* The brief's suggested sequencing,
  and it would be right if the storage modules cached a connection. They do not (verified
  above), so this would duplicate the DB names on the main thread — the one place the design
  deliberately keeps ignorant of the store (`key-storage.ts:1-5`: "The worker (not the main
  thread) owns this store"). Rejected on that principle alone.
- *Call `objectStore.clear()` instead of `delete(RECORD_KEY)`.* Empties the store more
  thoroughly but leaves the same shell. Does not address the finding.
- *Leave it — the data is already gone.* Defensible (E2E-5.5 itself downgraded the severity),
  but "both are gone" is a stated guarantee, and anyone auditing local storage after a logout
  should not have to open two databases to discover they are empty.

### Testing

- `packages/web/src/crypto/__tests__/worker-handler.test.ts:223-228` already has
  `it("clear() wipes the session store as well as the key store")` using the memory doubles.
  Extend both `createMemoryKeyStorage`/`createMemorySessionStorage` with a `destroy()` that
  records it was called, and assert `"clear"` invokes `destroy()` (not `clear()`) on both. This
  is the cheap, environment-free assertion and it is enough to pin the contract.
- `packages/web/src/lib/logout.test.ts` currently asserts the step order
  `["wipe","disconnect","clear"]`. Update to `["stop-shared","wipe","disconnect","clear"]` and
  add a case proving a throwing `stopSharedBridge` still lets the rest of logout run.
- **There is no test of the real IndexedDB path at all** — grep for
  `createIndexedDbKeyStorage` hits only the module, `worker.ts`, and `index.ts`, and
  `packages/web/vitest.config.ts` has no jsdom environment. Testing `destroy()` against real IDB
  needs `fake-indexeddb` as a devDependency. Recommend adding it *only if* the interface-level
  test above proves insufficient; it is new tooling for one assertion.
- Live re-verification of E2E-5.5: log out, then `await indexedDB.databases()` in the console —
  expect `[]`.

### Risk / blast radius

`terminateSharedCryptoBridge()` is the risky half. It rejects every in-flight worker call
(`client.ts:164-167` → `rejectAllPending`), so any component still mounted and awaiting a
`bridge.open()` gets a rejection instead of a value. Both call sites navigate immediately
afterwards (`nav-user.tsx:45-46` → `router.replace(SIGNIN_PATH)`;
`features/settings/components/DevicesSection.tsx:112`), so the window is small — but a
component that logs an unexpected rejection to `console.error` will now do so during a normal
sign-out. Check `sync/engine.ts` and `features/session-control/**` for `bridge.open()` callers
that treat a rejection as an error state rather than a teardown.

`deleteDatabase` firing `onblocked` when a second tab holds a connection is expected and
handled — the database is then deleted once that tab closes. Do not turn `onblocked` into a
rejection; logout must not fail because another tab is open.

---

## Fix 6 — Stop backfilling transcripts that predate Kvy

**Status: ✅ Implemented — `RegisteredWorkspace.registeredAt` (optional), the
`FIRST_REGISTRATION_GRACE_MS` (1hr) `isWithinWatchWindow` gate applied in both
`processFile` (authoritative) and `scanExisting` (cheap pre-filter), and the adapter fix
(`workspace/adapters.ts` no longer structurally discards `registeredAt`) all implemented
exactly as specified. Tests: `transcriptIndexer.test.ts` gained a `"registeredAt gating"`
describe block (3 cases: pre-Kvy history excluded, resumed-inside-grace-window included
via `fs.utimes` to move mtime without waiting real wall-clock time, and the
absent-`registeredAt`-indexes-everything default); `registry.test.ts`'s two existing
immutability tests annotated as load-bearing per the plan's note. `adapters.test.ts`'s two
existing tests needed fixing (their exact `toEqual` no longer matched once `registeredAt`
stopped being discarded) plus a new case closing the `machineIntegration.test.ts` wiring
gap the plan flagged, added at the adapter level (more direct than a broader
`machineIntegration.test.ts` wiring test). No deviation from the plan's intent.**

### Root cause

The transcript indexer reads Claude Code's **own global** project directory
(`~/.claude/projects/<cwd-hash>`) and indexes **every** `.jsonl` in it with no age or ownership
filter, the first time a workspace is watched. On a brand-new account, that is the user's entire
pre-Kvy Claude Code history for that folder, uploaded and attributed to the account that
happens to be signed in.

### What was verified

Every claim in the prior investigation is confirmed at the cited lines:

- `claude/scanner.ts:118-125` — `getProjectPath()` resolves
  `(CLAUDE_CONFIG_DIR || homedir()/.claude)/projects/<sanitised-cwd>`, and never imports
  `home.ts`, so it is independent of `KVY_HOME_DIR` and of which account is active.
- `daemon/transcriptIndexer.ts:396-408` — `scanExisting` schedules every `.jsonl` from a bare
  `readdir`. Called from `watchWorkspace:414` **and again from the watcher's `onReady` hook at
  :424**, so every watch reattach re-enqueues the whole directory.
- `daemon/transcriptIndexer.ts:88-89` — `isManaged: () => false`, and
  `machineIntegration.ts:599-608` overrides only `logger`. Repo-wide, `isManaged` appears
  nowhere else in `packages/cli/src` except its own test. (`adopt/lineage.ts`'s
  `getAdoptionLineage` is exactly the store the module header says it should consult — built,
  never wired.)
- `workspace/registry.ts:220-222` sets `registeredAt` once and never mutates it (three
  `registry.test.ts` cases already pin that immutability).
- `server/src/app/routes/unmanagedSessions.ts` scopes rows to the authenticated
  account+machine and cannot validate provenance — `summary` is an opaque `EncryptedBox`.

**The missing link nobody cited:** `workspace/adapters.ts:45-53`'s
`createTranscriptIndexerWorkspaceLister` maps registry entries to
`{ workspaceId: entry.path, path: entry.path }` — **it structurally discards `registeredAt`**
before the indexer could ever see it. The indexer's own `RegisteredWorkspace` type
(`transcriptIndexer.ts:60-64`) has no timestamp field to receive it.

### Documented intent this fix must serve

- `docs/kvy-prd.md:221` — *"The most common real-world entry path: the user opens plain
  `claude` (muscle memory), works a while, then needs to leave and wants remote access to
  **that** session."*
- `docs/kvy-prd.md:228` (FR-9.1) — passive indexing of provider transcript dirs *"for
  registered workspaces"*, with *"opt-out per workspace"*.
- `docs/kvy-prd.md:230` (FR-9.2) — `kvy adopt` lists **recent** plain sessions.
- `docs/kvy-system-design.md:885` — the transcript-granularity decision resolved to
  *"on-demand (privacy + bandwidth)"*, i.e. the documented bias is toward uploading **less**.

Nothing documents an archive import. "That session" and "recent" are the governing words.

### Affected files

- `packages/cli/src/daemon/transcriptIndexer.ts` (`RegisteredWorkspace`, `scanExisting`,
  `processFile`)
- `packages/cli/src/workspace/adapters.ts` (stop dropping `registeredAt`)
- Tests: `daemon/transcriptIndexer.test.ts`
- Follow-up note only: `packages/web/src/features/unmanaged-sessions/**`

### Proposed fix

**Gate indexing on file mtime against the workspace's `registeredAt`.** A transcript whose file
has not been touched since Kvy started watching this workspace is, by definition, not the
session the user just left — it is history. Widen `RegisteredWorkspace` with an **optional**
`registeredAt`, pass it through the adapter, and apply the gate in two places:

1. `scanExisting` — `stat` each candidate and skip scheduling anything older. There is
   precedent for a per-file stat in a directory loop right there in the same module
   (`computeRunning:242-253` already stats every `.jsonl`), so this is not new cost.
2. `processFile` — the authoritative check, applied to live watch events too. `mtimeMs` is
   **already in hand** at `:346-348` (the `stat` runs in parallel with the `readFile` and feeds
   the `lastActivity` fallback at `:370`), so this costs zero extra I/O.

Gating on **mtime**, not on the transcript's in-file `lastActivity`, is deliberate. It means a
genuinely old plain session that the user *resumes* gets a fresh mtime and is picked up
immediately, while one they never touch again stays out. It also happens to be the only choice
that leaves the existing test suite green (see Testing).

**The first-registration edge, and a grace window for it (corrected in rev 2).** Rev 1 asserted
that "a transcript not touched since Kvy started watching is, by definition, not the session
the user just left." That is not true at *first* registration, and the PRD's own canonical
scenario is the counterexample — `docs/kvy-prd.md:221`: *"the user opens plain `claude`
(muscle memory), works a while, then needs to leave and wants remote access to that session."*
Run that literally and the just-exited session's mtime is **minutes older** than
`registeredAt`, so the gate filters out the exact transcript FR-9.1 exists to capture. (A
*still-running* plain session survives — its next write re-triggers the watcher with a fresh
mtime — but the just-exited one does not.)

So the gate takes a grace window at the workspace's first registration:

```ts
/**
 * How far back a workspace's FIRST registration reaches. kvy-prd.md:221's canonical entry
 * path is "run plain `claude`, work a while, THEN reach for Kvy", so the session the user
 * just left is minutes older than `registeredAt` — a strict `mtime >= registeredAt` gate would
 * drop precisely the transcript Tier 1 exists to catch. One hour is long enough for "I just
 * finished that" and far short of the days-old archive that made a brand-new account show 11
 * unrelated cards.
 */
const FIRST_REGISTRATION_GRACE_MS = 60 * 60 * 1000;

function isWithinWatchWindow(workspace: RegisteredWorkspace, mtimeMs: number): boolean {
  if (!workspace.registeredAt) return true;
  const registeredAtMs = Date.parse(workspace.registeredAt);
  if (Number.isNaN(registeredAtMs)) return true;
  return mtimeMs >= registeredAtMs - FIRST_REGISTRATION_GRACE_MS;
}
```

One hour is a judgement call, not a derived number, and it should be labelled as one. It is
chosen against the observed failure: the E2E's 11 cards were *"hours-to-days old"*, with titles
from *"days earlier"* — so an hour excludes all of them while keeping the PRD scenario. If it
proves wrong in practice, it is a one-constant change, and the failure mode of it being too
small (a session the user wanted doesn't appear) is recoverable by sending one message, while
too large re-opens the bug.

*Alternative considered:* document the exclusion instead and point users at `kvy adopt`
(FR-9.2). Rejected — it makes the documented primary entry path work only if the user knows a
second command exists, which is principle 1 inverted.

```diff
 export interface RegisteredWorkspace {
   workspaceId: string;
   path: string;
+  /**
+   * ISO-8601 first-registration time, from `workspace/registry.ts`. Transcripts whose files
+   * haven't been touched since then are pre-Kvy history, not "the session the user just
+   * left" (kvy-prd.md FR-9.1), and are not indexed — a brand-new account's first
+   * `kvy claude` was otherwise uploading the machine's entire prior Claude Code archive
+   * for that folder as unmanaged sessions.
+   *
+   * Optional: absent means index everything, which keeps the daemon's default
+   * `listWorkspaces: async () => []` and every existing test's fixture valid.
+   */
+  registeredAt?: string;
 }
```

```diff
   async function processFile(workspace: RegisteredWorkspace, sessionId: string): Promise<void> {
     if (await deps.isManaged(sessionId)) return;
     …
     const [raw, stats] = await Promise.all([readFile(file, "utf8"), stat(file)]);
+    if (!isWithinWatchWindow(workspace, stats.mtimeMs)) return;
```

```diff
   async function scanExisting(workspace: RegisteredWorkspace, projectDir: string): Promise<void> {
     try {
       const names = await readdir(projectDir);
       for (const name of names) {
-        if (name.endsWith(JSONL_EXT)) {
-          scheduleProcess(workspace, name.slice(0, -JSONL_EXT.length));
-        }
+        if (!name.endsWith(JSONL_EXT)) continue;
+        // Cheap pre-filter so a directory with months of history doesn't get read and
+        // parsed on every watcher (re)attach only to be dropped. `processFile` re-checks.
+        const stats = await stat(join(projectDir, name)).catch(() => null);
+        if (stats && !isWithinWatchWindow(workspace, stats.mtimeMs)) continue;
+        scheduleProcess(workspace, name.slice(0, -JSONL_EXT.length));
       }
     } catch {
```

(`isWithinWatchWindow` is defined above, under "The first-registration edge".)

and the two-line adapter change that makes any of it reachable:

```diff
     return async () => {
       const entries = await listWorkspaces(options);
-      return entries.map((entry) => ({ workspaceId: entry.path, path: entry.path }));
+      return entries.map((entry) => ({
+        workspaceId: entry.path,
+        path: entry.path,
+        registeredAt: entry.registeredAt,
+      }));
     };
```

**Alternatives considered and rejected:**

- *A fixed recency cap (e.g. "nothing older than 7 days").* A second tunable with no documented
  basis, and it does not actually fix the reported scenario any better than `registeredAt` does
  — a brand-new account registers the workspace *now*, so `registeredAt` already excludes all
  11. Adding a cap on top would only matter for a workspace registered long ago, where the
  `registeredAt` gate is already doing the right thing. Rejected as scope.
- *Wire up `isManaged` to `adopt/lineage.ts`.* Should happen — the hook is a permanent no-op in
  production and the lineage store exists — but it answers a different question ("has Kvy
  already adopted this one?"), not "is this mine at all?". It would not have prevented a single
  one of the 11 cards. Worth a separate, small PR.
- *Require an explicit `kvy adopt` instead of automatic backfill.* This is the biggest
  behaviour change and contradicts the documented design: FR-9.1 specifies *passive* indexing
  and `kvy adopt` (FR-9.2) is a **separate**, already-specified terminal-side command for
  taking one over. Removing Tier 1's ambient index would be re-planning the feature, not fixing
  a defect.
- *Filter on the transcript's in-file `lastActivity`.* Semantically closer to "recent", and it
  breaks **all eight** `startTranscriptIndexer` integration tests at once — every fixture in
  `transcriptIndexer.test.ts` hardcodes `timestamp = "2026-01-01T00:00:00.000Z"` while the files
  are written at test time, so every fixture would be judged seven months stale. Rejected.
- *Server-side provenance validation.* Impossible: the summary is ciphertext by design
  (§5.3/§6.1). The server can only scope to account+machine, which it already does correctly.

### Testing

- `packages/cli/src/daemon/transcriptIndexer.test.ts` — `baseWorkspace()` at :95-97 returns
  `{workspaceId, path}` with no timestamp, and `registeredAt` is **optional**, so all 14 tests
  keep compiling and passing unchanged. Verify that explicitly; it is the whole reason for
  choosing optional over required.
  **Add** two cases: a workspace with `registeredAt` in the future must upsert nothing even
  though the directory has transcripts; the same workspace after the file is re-touched must
  upsert it. Note the existing case at :177-196 asserts that **both** `sess-old` and `sess-new`
  are upserted — this fix must not break it (it does not: both are written during the test, so
  both have `mtime = now`).
- `packages/cli/src/workspace/registry.test.ts` — three cases already pin `registeredAt`
  immutability across re-registration. No change needed; they become load-bearing for this fix,
  so add a comment saying so.
- `packages/cli/src/daemon/machineIntegration.test.ts` has **zero** coverage of the indexer
  wiring (`grep unmanaged|indexer|listWorkspaces` → no matches). Adding one test that the
  production wiring passes a lister which preserves `registeredAt` would close a real gap.
- Live: fresh `KVY_HOME_DIR`, fresh account, in a directory with existing
  `~/.claude/projects/` history — run `kvy claude`, send one message, confirm the dashboard
  shows **zero** unmanaged cards. Then run plain `claude` in the same directory, send a
  message, and confirm exactly one appears.

### Risk / blast radius

`RegisteredWorkspace` is the indexer's own narrow type, used by
`machineIntegration.ts:196/259`, `daemon/commands.ts:169/299`, and `workspace/adapters.ts`.
Making the new field optional means none of those need to change except the adapter.

The gate is a **filter on upload**, so the failure mode of getting it wrong is "a session the
user wanted doesn't appear", which is recoverable (touch the file / send a message) and
visible. The opposite failure — over-uploading — is the one being fixed and is not recoverable
by the user at all.

**Residue this fix does not clean up.** The ~11 rows already uploaded stay. There is no delete
route, no `dismissed` column (`schema.ts:205-218` has none), and `sync.ts:44-45` returns every
row for the account unfiltered — and the web's cards have only "View" and "Take over", no
dismiss (`features/unmanaged-sessions/components/unmanaged-session-card.tsx:78,87`). Affected
accounts need a manual DB cleanup, or a follow-up PR adding a dismiss action. Say so in the
release note rather than letting users discover it.

Also worth flagging as documented-but-missing scope, deliberately **not** claimed here:
FR-9.1's *"opt-out per workspace"* has no implementation anywhere in `packages/cli/src`.

---

## Fix 7 — A key request must reach the person at the terminal

**Status: ✅ Implemented — `sessionClient.ts` gained an `onKeyRequest` dep + `"ephemeral"`
listener (EphemeralSchema-parsed, key-request-only); `ptyClaudeSession.ts` gained the
exported `notifyTerminal(write, text)` OSC9+BEL helper; `ui/messages.ts` gained
`KEY_REQUEST_PENDING`; `start.ts` wires `onKeyRequest` into the session client (live OSC9
notify, gated on `stdout.isTTY`, plus recording the label) and, on exit, prints the durable
line always and — when `stdin.isTTY` — runs `runKeysApproveCommand` inline (now injectable
via a new `StartClaudeCommandDeps.runKeysApproveCommand`). **Deviation from the plan's
premise:** the plan's "Proposed fix" section 2 says to "extract a reusable `runKeysApprove`"
from `keysApprove.ts` — re-reading the current file, `runKeysApproveCommand` already exists
as exactly that reusable, injectable-deps function (nothing to extract); `start.ts` just
needed to call it. `notifyTerminal` was placed in `ptyClaudeSession.ts` (which already
defines the `StdoutLike`/write abstraction this needs) rather than a new file, matching the
plan's "surface it" note for that file. Tests: `sessionClient.test.ts` gained 3 cases
(fires on key-request, ignores other ephemerals, doesn't throw on garbage);
`ptyClaudeSession.test.ts` gained the "writes ONLY OSC9+BEL" case; `start.test.ts` gained a
3-case describe block (TTY runs the review, non-TTY prints the line but never calls the
injected approve command, and no-key-request runs neither). `ui/messages.test.ts` needed no
change — the new constant is automatically covered by its existing guards.
**Live-terminal verification (Terminal.app/iTerm2/tmux) was NOT performed** — this requires
a human at a real terminal per the plan's own risk section ("Ship this behind a check, and
verify live... before enabling by default"); flagging for the user to verify before this
ships.**

### Root cause

When another device asks for a copy of your keys, the CLI's only reaction is a line in
`~/.kvy/logs/`. `machineClient.ts:461-468` handles the `key-request` ephemeral with
`deps.logger.info(...)`, and `logger.ts:5-19` documents that this module **must never write to
stdout/stderr** (it would corrupt the inherited provider TUI). Nobody tails that file, so the
notification is invisible — even to a user sitting in an active `kvy claude` session.

### What was verified

- `machineClient.ts:457-468` confirmed exactly, including the AX-4.17 comment. The socket event
  is `"ephemeral"`; the payload is `@kvy/wire`'s `EphemeralSchema`, whose `key-request`
  member (`packages/wire/src/updates.ts:110-115`) is `{ t, ephPub, label }` — public data only.
- `logger.ts:5-19` confirmed (the report cited 8-18; the prohibition itself is on lines 8-13,
  inside a docblock spanning 5-19). Implementation matches: `write()` only ever
  `appendFileSync`s.
- **No notification mechanism of any kind exists in the CLI.** `daemon/notify.ts` is a false
  positive (an HTTP POST to the daemon's own `/session-started`); `claude/hookServer.ts`'s
  "Notification" is Claude Code's hook name; `remotePermissionHook.ts:105` asks the *server* to
  push to *web*. No `node-notifier`, no `osascript`, no BEL.
- Daemon↔session IPC is **strictly session→daemon**: `controlServer.ts:255` binds a local
  Fastify on `127.0.0.1:<ephemeral>`, six POST routes, all inbound. The daemon never learns a
  session's address (`SessionStartedBodySchema:45-58` carries no port). The only daemon→session
  channel today is `process.kill` (`sessionRegistry.ts:105`).

**And the finding that makes this cheap:** the running `kvy claude` process **already
receives this event and throws it away.** `emitEphemeral`'s
`recipientFilter: {type: "all-user-authenticated-connections"}` resolves to room
`user:${accountId}` (`server/src/app/events/eventRouter.ts:239-240`), and **every** connection
joins that room regardless of type (`eventRouter.ts:116-118`). But
`packages/cli/src/session/sessionClient.ts` registers only `connect`, `connect_error`, and
`disconnect` — no `"ephemeral"` handler. **No new transport is needed.**

Also load-bearing: `kvy claude` does **not** inherit stdio. `claude/ptyClaudeSession.ts:582`
spawns the provider on a pty and Kvy itself relays every byte
(`child.onData(data => stdout.write(data))` at :592-593, stdin proxied at :613-646). So Kvy
owns both directions and could paint — but the TUI owns the framebuffer, so painting into it is
still wrong.

### Affected files

- `packages/cli/src/session/sessionClient.ts` (add the `"ephemeral"` handler + an
  `onKeyRequest` dep)
- `packages/cli/src/claude/ptyClaudeSession.ts` (surface it; run the review on exit)
- `packages/cli/src/commands/start.ts` (wire the dep)
- `packages/cli/src/ui/messages.ts` (one new constant)
- `packages/cli/src/commands/keysApprove.ts` (extract a reusable `runKeysApprove`)

### Proposed fix

Three layers, cheapest first.

**1. Notify without touching the TUI's frame.** Write an OSC 9 desktop-notification escape
sequence (plus a single BEL) to the real terminal. These are non-rendering control sequences —
the terminal consumes them and raises a system notification; they do not move the cursor or
disturb the alternate screen buffer. iTerm2, WezTerm, kitty and Ghostty implement OSC 9;
terminals that do not simply ignore it. This is the only way to reach the user *during* an
active TUI without violating the rule that Kvy never paints into the provider's frame.

Per guiding principle 7, state the limit honestly: **this raises the chance the user notices,
it does not guarantee it.** In a terminal with no OSC 9 support, only layer 2 fires.

**2. Print a durable line, and then actually run the review, when the TUI exits.** This is the
guarantee. `kvy claude`'s exit path already writes to stdout (`start.ts:564`) — a command
handler, explicitly exempt from the logger rule. If a key request was seen during the session
and `stdin.isTTY`, run the approve flow inline rather than telling the user to run it.
Principle 1: *never print "run X" when you can run X.* `keysApprove.ts`'s `defaultConfirm`
(:62-70) opens a `readline` on `process.stdin`, which cannot coexist with the pty's raw mode —
so this must run **after** raw mode is restored, which the exit path already does.

**3. Listen where the event already arrives.**

```diff
--- a/packages/cli/src/session/sessionClient.ts
+++ b/packages/cli/src/session/sessionClient.ts
@@
+  // The session socket joins `user:${accountId}` like every other connection
+  // (server/src/app/events/eventRouter.ts:116-118), so a key request raised on another
+  // device already lands here — it was simply never listened for. The daemon's own handler
+  // (daemon/machineClient.ts) logs it to a file nobody reads; this is the copy that can
+  // reach a human, because a `kvy claude` session has a real terminal attached.
+  socket.on("ephemeral", (payload: unknown) => {
+    const parsed = EphemeralSchema.safeParse(payload);
+    if (!parsed.success || parsed.data.t !== "key-request") return;
+    deps.onKeyRequest?.({ label: parsed.data.label });
+  });
```

with the terminal-side surface:

```ts
/**
 * A desktop notification via OSC 9, plus a BEL. Deliberately NOT a screen write: the
 * provider's TUI owns the framebuffer while a session runs, and painting into it would
 * corrupt its rendering exactly the way `logger.ts` exists to prevent.
 *
 * HONEST SCOPE: OSC 9 is implemented by iTerm2, WezTerm, kitty and Ghostty, and ignored by
 * terminals that don't support it. This raises the chance the user notices in time; it does
 * not guarantee it. The guarantee is the post-session review below, which always runs.
 */
function notifyTerminal(stdout: NodeJS.WriteStream, text: string): void {
  // ESC ] 9 ; <text> BEL — OSC 9, BEL-terminated. Non-rendering: no cursor movement and
  // no framebuffer write, so there is nothing for the provider TUI to repaint over.
  stdout.write(`\x1b]9;${text}\x07`);
}
```

and one new message constant. Note the constraint from `ui/messages.test.ts:26-29`: no exported
string may contain `kvy auth login` unless it also contains `no terminal here`. This one
mentions no command at all, which is the point.

```ts
export const KEY_REQUEST_PENDING =
  "\n  A device asked for a copy of your keys while you were working.\n";
```

**Alternatives considered and rejected:**

- *A one-line banner painted into the TUI.* The pty relay at `ptyClaudeSession.ts:592-593` makes
  it technically easy, and the existing human-typing gate (`controller.setLocalDraft`,
  `DRAFT_IDLE_MS` at :629-643) would even keep it off mid-keystroke. Rejected: the provider TUI
  redraws from its own model and does not know about our line, so the banner is either
  overwritten immediately or leaves artefacts. This is the exact failure `logger.ts` was written
  to prevent, and doing it deliberately from a command handler is no better.
- *A new daemon→session push channel.* `controlServer.ts` is request/response only and the
  daemon does not know any session's address, so this means a new transport. Unnecessary: the
  event already arrives on the session's own socket.
- *Reuse the server's push infrastructure* (`server/src/app/push/`: webpush, telegram, ntfy).
  None can reach a CLI — webpush needs a service worker, the other two are third-party relays
  keyed to account settings. Rejected.
- *Add `node-notifier` / shell out to `osascript`.* A new dependency (or a macOS-only shell-out)
  for something a two-byte escape sequence does portably. Rejected.
- *Prompt for approval inline, mid-session.* Would need to steal stdin from the pty. Approving a
  key share is the single most security-sensitive action in the product
  (`auth-ux-overhaul-plan.md:2474-2479`) and must never be answered by a keystroke the user
  thought was going to their editor. Hard no.

### Testing

- `packages/cli/src/session/__tests__/` — add a case driving the fake socket with a valid
  `key-request` ephemeral and asserting `onKeyRequest` fires once; and with a non-`key-request`
  ephemeral asserting it does not. Mirror `machineClient`'s existing ephemeral test if one
  exists.
- `packages/cli/src/ui/messages.test.ts` — the new constant is automatically covered by its two
  existing guards (`/masterSecret|keyEpoch|ephPub|DEK|custody|\bbind\b/i`, and the
  `kvy auth login` rule). Confirm both pass.
- Assert `notifyTerminal` writes **only** the OSC 9 + BEL sequence and nothing else, against a
  fake `stdout` — the regression that matters is someone later "improving" it into a visible
  line.
- `packages/cli/src/commands/start.test.ts` — assert that when a key request was recorded, the
  exit path invokes the approve flow (injected), and that with `stdin.isTTY` false it prints the
  durable line and does **not** try to open a readline.
- Live: with `kvy claude` running, raise a key request from a browser. Expect a desktop
  notification; on exit, expect the approve prompt with a code matching the browser's, using the
  same `verificationCode()` (`keysApprove.ts:47-50`, contractually mirrored by
  `web/src/lib/verification-code.ts` — do not reimplement it).

### Risk / blast radius

Writing *anything* to the real terminal while a pty session is live is the risk. OSC 9 is
non-rendering by specification, but "by specification" is not "verified on this user's
terminal" — principle 7 applies. **Ship this behind a check, and verify live on at least
Terminal.app, iTerm2, and tmux before enabling by default.** tmux in particular passes through
OSC sequences only with `set -g allow-passthrough on`; without it the sequence is swallowed
harmlessly, which is the acceptable failure.

`sessionClient.ts` gains one optional dep, so every existing construction site keeps compiling.

---

## Fix 8 — `/password/` must not default to sign-up on a pairing continuation

**Status: ✅ Implemented — `password/page.tsx` reads `peekPendingPair()` inside a
`useEffect` (not a `useState` initialiser, per rev 2's correction) and defaults `mode` to
`"signin"` when a pair is pending, plus a `pendingPair` state driving the shared
`copy.signin.titleWithPendingPair` heading. New `password/page.test.ts` (source-text,
mirroring `signin/page.test.ts`'s technique) asserts the effect placement with the
load-bearing negative check (peekPendingPair NOT inside the `useState<Mode>` call). Ran
`pnpm --filter @kvy/web build` as the plan's stated acceptance criterion — succeeds
cleanly, confirming the effect-based fix doesn't reintroduce rev 1's prerender break.
Implemented exactly as specified, no deviation.**

### Root cause

`app/(public)/password/page.tsx:39` — `const [mode, setMode] = useState<Mode>("signup")` — is
unconditional. The file contains no `useEffect`, no query-param read, and no `sessionStorage`
read, so the page cannot distinguish a first-time visitor from a returning user finishing a
pairing.

### What was verified

- Line 39 confirmed exactly. `Mode = "signup" | "signin"` at :15.
- The only two `setMode` calls are :80 (the server's no-enumeration branch flips to `"signin"`)
  and :183-186 (the manual toggle link).
- `/signin/page.tsx:131` navigates with a bare `router.push("/password/")` — no params, no hash.
  **Two tests assert that exact literal** (`signin/page.test.ts:35` and `:44`), so adding a
  query param there means updating them.
- The mechanism to fix it already exists and is already used one route away:
  `lib/pending-pair.ts:18-20`'s `peekPendingPair()` is a **non-consuming** read of
  `sessionStorage["kvy:pendingPair"]`, and `signin/page.tsx:36` calls it to swap its heading
  to "Connect your machine". `/password/` simply never calls it.
- The consequence is worse than a wrong label: `handleSubmit` at :47-50 short-circuits in
  `"signup"` mode straight to `setStatus({kind:"choose-protection"})` **without calling the
  API**, so a returning user who does not notice the toggle is routed into a key-protection
  question that makes no sense for them.

### Affected files

- `packages/web/src/app/(public)/password/page.tsx`
- `packages/web/src/lib/copy.ts` (one string, if the heading is made pairing-aware)
- Tests: a new source-text test alongside `signin/page.test.ts`'s pattern

### ⚠️ Correction (rev 2) — `peekPendingPair` is NOT prerender-safe

Rev 1 of this section proposed reading `peekPendingPair()` from a `useState` **lazy
initialiser**, and justified it with the claim that the helper "guards on `typeof window`".
**That claim was false and the diff would have broken `next build`.** Re-verified:

```ts
// packages/web/src/lib/pending-pair.ts:16-20 — no guard of any kind
/** Read without consuming — the sign-in page needs to KNOW a pairing is pending (to
 * change its heading) without spending it. Only the pair page consumes. */
export function peekPendingPair(): string | null {
  return window.sessionStorage.getItem(PENDING_PAIR_KEY);
}
```

All three exports (`stashPendingPair:13`, `peekPendingPair:19`, `consumePendingPair:23-24`)
touch `window.sessionStorage` bare. A `useState` lazy initialiser runs during the render pass,
including the prerender `next build` performs for `/password/` (`next.config.ts:26` applies
`output: "export"` for the build phase), where `window` is undefined — `ReferenceError`, build
fails. Every existing caller is safe only because it runs inside an effect
(`signin/page.tsx:36`) or post-interaction (`pair/page.tsx:68`).

### Proposed fix (corrected)

Default the mode from `peekPendingPair()` **in an effect**, matching the pattern this codebase
already uses for exactly this problem one route away. `signin/page.tsx:29-37` is the precedent,
comment and all:

```ts
// Static export — no server-rendered query string to read on the first paint — so this
// reads `window.location.search` in an effect rather than `useSearchParams()`, matching
// the OAuth callback pages' convention.
const [banner, setBanner] = useState<"expired" | "pair" | null>(null);

useEffect(() => {
  if (isExpiredReason(window.location.search)) { setBanner("expired"); return; }
  if (peekPendingPair()) setBanner("pair");
}, []);
```

`hooks/use-mobile.ts:6-16` uses the same shape (`useState(undefined)` + effect) for
`window.matchMedia`. So:

```diff
   const [mode, setMode] = useState<Mode>("signup");
+  // A pending pair means the CLI sent this browser here to finish connecting a machine, so
+  // an account almost certainly exists already — defaulting to "signup" pushed those users
+  // into the key-protection question (`handleSubmit`'s signup short-circuit below) instead
+  // of signing them in.
+  //
+  // Read in an EFFECT, not a `useState` initialiser: `peekPendingPair` dereferences
+  // `window.sessionStorage` unguarded, and an initialiser runs during the static-export
+  // prerender where there is no `window`. Same reason — and the same shape — as
+  // `signin/page.tsx`'s banner effect. `peek` does NOT consume the value; the auth call
+  // still spends it via `consumePendingPair()`.
+  useEffect(() => {
+    if (peekPendingPair()) setMode("signin");
+  }, []);
```

This costs one extra render on a pairing continuation and **zero hydration mismatch** — the
server-rendered and first-client renders both produce `"signup"`, and the effect flips it
afterwards. A guarded lazy initialiser
(`() => (typeof window !== "undefined" && peekPendingPair() ? "signin" : "signup")`) would also
build, but it renders `"signup"` on the server and `"signin"` on the client's first pass — a
React hydration-mismatch warning, and a new pattern this codebase does not otherwise use.

Optionally pair it with the heading `/signin/` already shows, so the two screens agree — note
this must read the *same* effect-set state, not call `peekPendingPair()` inline in JSX:

```diff
-          <CardTitle>{mode === "signup" ? "Create your account" : "Sign in"}</CardTitle>
+          <CardTitle>
+            {mode === "signin" && pendingPair
+              ? copy.signin.titleWithPendingPair
+              : mode === "signup"
+                ? "Create your account"
+                : "Sign in"}
+          </CardTitle>
```

**Alternatives considered and rejected:**

- *A `useState` lazy initialiser (rev 1's proposal).* Breaks the build. Even guarded, it
  introduces a hydration mismatch and a pattern with no precedent here.
- *Add `if (typeof window === "undefined") return null;` to `pending-pair.ts` itself.* Not
  wrong, and arguably makes the module honestly prerender-safe — but guarding only `peek` while
  `stash`/`consume` stay bare is inconsistent, and guarding all three silently converts a real
  programming error (calling these during render) into a `null` that looks like "no pending
  pair". Worth doing as a separate defence-in-depth change **with all three guarded**; it is
  explicitly *not* what makes this fix safe. The effect is.
- *Pass a query param from `/signin/`.* Requires changing `router.push("/password/")` and
  updating two tests that assert that exact string, and it only covers the one entry point —
  a bookmarked `/password/` still guesses wrong. `peekPendingPair()` covers every path.
- *Remove the default entirely and show both buttons.* More neutral, and arguably better, but
  it is a redesign of a screen that is documented as **local-testing-only** (`page.tsx:29`:
  *"these routes 404 in production"*). Not worth the churn.

### Testing

- **`pnpm --filter @kvy/web build` is an acceptance criterion for this fix, not an
  afterthought.** A source-text test would have passed happily on rev 1's build-breaking
  version; only a real build catches this class of error.
- New source-text test in `app/(public)/password/`, following the technique
  `signin/page.test.ts` already uses (this package's vitest config has no DOM): assert
  `peekPendingPair()` appears inside a `useEffect`, and that it does **not** appear inside the
  `useState<Mode>` call. The negative assertion is the one that matters.
- `lib/__tests__/pending-pair.test.ts` already covers `peekPendingPair`'s non-consuming
  contract — reference it, don't duplicate it.
- Live: run `kvy` on a machine with an existing account, open the printed link, sign in
  through `/signin/` → "Continue with email + password", and confirm the page opens in
  **Sign in** mode.

### Risk / blast radius

One effect, one route, and the route 404s in production. Two hazards, both now handled above:
calling a `window`-dereferencing helper during render (the rev 1 defect), and confusing
`peekPendingPair` with `consumePendingPair` — using the consuming variant here would spend the
pairing token before the auth call needs it (`complete-password-sign-in.ts:130`/`:148`) and
strand the user on `/dashboard/` with the CLI still spinning.

---

## Fix 9 — "One more step" must say what will happen next

**Status: ✅ Implemented — `copy.ts`'s `keys` block gained `needKeysBody`'s expanded text,
`needKeysStarting`, `codeMismatchRequester`, and `noOtherDevicesHint` (a function, so the
"run `kvy keys approve`" instruction the jargon-linter previously couldn't see now
routes through `copy.*`). `request-keys-panel.tsx` gained the `starting`-phase render
branch and the mismatch line under the code. **Deviation:** moving the "no other devices"
hint into `copy.ts` as a plain string-returning function meant dropping the `<code>` inline
monospace styling around `kvy keys approve` (a `copy.*` string can't carry embedded JSX)
— content-linter coverage over that one styling detail, consistent with how every other
`copy.ts` function in this file already works (plain string interpolation, no markup).
Tests: `copy.test.ts` gained the requester-mismatch assertion; new
`request-keys-panel.test.ts` (source-text, no existing test file for this component)
covers the `starting` branch, the mismatch line, and the copy-routed hint. Implemented per
the plan's intent; the one deviation is disclosed above.**

### Root cause

The requester panel's entire explanation is one 12-word sentence
(`copy.keys.needKeysBody`). It never says *what will happen next* (another of your devices will
show a card), *what the code is for* (a check that stops an attacker, not a formality), or
*that the page will move on by itself*. The 6-digit code and its instruction only appear once
the request is in flight, so the first thing a user sees is a bare title, one sentence, and a
"Start over with new keys" link.

### What was verified

- The string lives in `lib/copy.ts:34`, not the component — `"One more step"` has exactly one
  occurrence in `packages/web/src`.
- `components/auth/request-keys-panel.tsx` is 147 lines; every rendered string is a
  `copy.keys.*` reference **except** the inline JSX at :128-131
  (`{copy.keys.noOtherDevices} Run <code>kvy keys approve</code> on a machine that has your
  keys.`) — which is the one string `copy.test.ts` cannot see, because that test walks the
  `copy` object and never greps `.tsx`.
- The panel's `starting` phase renders **no** waiting UI at all: between mount and the first
  `createKeyRequest` + `listDeviceSessions` round trip there is only the title, the body, and
  `<StartOverLink/>`.
- The plan already recorded that this copy is load-bearing —
  `auth-ux-overhaul-plan.md:139-145` carries a comment ("*the verification code is the security
  control, so its copy is load-bearing — it must tell the user what to compare and what to do on
  mismatch*") that survives in **neither** `copy.ts` nor the component. And
  `copy.keys.codeMismatch` exists but is rendered **only** on the approver side
  (`key-request-listener.tsx:119`), never to the requester.

### Constraints any copy edit must respect

- **Banned words** (`auth-ux-overhaul-plan.md:59-60`): `keyEpoch`, `masterSecret`, `bind`,
  `custody`, `bridge`, `epoch`, `DEK`, `nonce`, `ephPub`.
- `lib/__tests__/copy.test.ts` enforces a *subset* as an unanchored, case-insensitive
  alternation: `/key material|masterSecret|keyEpoch|epoch|DEK|custody|bridge|ephPub/i`. Two
  traps: `key material` is banned (so the natural phrasing is out — say "your keys"), and
  `bridge` is a substring match, so "bridges the gap" would fail.
- A fourth assertion is **specific to this string**: `copy.keys.needKeysBody` must not *begin
  with* `"run "` (case-insensitive).
- Three documents assert the literal phrase **"One more step"**
  (`auth-ux-overhaul-plan.md:2443`, `auth-ux-overhaul-e2e-checklist.md:159`,
  `auth-ux-overhaul-e2e-results.md:126`). Keep the title; change what surrounds it.

### Affected files

- `packages/web/src/lib/copy.ts`
- `packages/web/src/components/auth/request-keys-panel.tsx`
- `packages/web/src/lib/__tests__/copy.test.ts` (one new assertion)

### Proposed fix

Keep the title. Expand the body to say what is about to happen, add a mismatch line to the
requester side (it exists for the approver and is exactly as load-bearing here), and give the
`starting` phase a real waiting state instead of a blank.

```diff
   keys: {
     needKeysTitle: "One more step",
     needKeysBody:
-      "Your sessions are end-to-end encrypted, so this browser needs a copy of your keys.",
+      "Your sessions are end-to-end encrypted, so this browser needs a copy of your keys. " +
+      "We'll ask a device you're already signed in on — you approve it there, and this page " +
+      "continues on its own.",
+    /** Shown while the request is being raised, so the first thing on screen isn't a blank. */
+    needKeysStarting: "Asking your other devices…",
     codeIntroRequester: "Check that your other device shows this same code:",
+    /** The requester half of the mismatch warning. `codeMismatch` below is the approver's;
+     *  the check is only a control if BOTH ends know what a mismatch means. */
+    codeMismatchRequester:
+      "If the codes don't match, don't approve it — someone else may be asking.",
```

and in the component:

```diff
+      {phase.kind === "starting" && (
+        <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
+          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
+          {copy.keys.needKeysStarting}
+        </div>
+      )}
+
       {phase.kind === "waiting" && (
         <>
           <div className="rounded-lg border bg-muted/30 p-4 text-center">
             <p className="text-sm text-muted-foreground">{copy.keys.codeIntroRequester}</p>
             <p className="mt-2 font-mono text-3xl tracking-[0.2em]">
               {formatVerificationCode(phase.code)}
             </p>
+            <p className="mt-2 text-xs text-muted-foreground">
+              {copy.keys.codeMismatchRequester}
+            </p>
           </div>
```

The inline JSX at :128-131 should also move into `copy.ts` as a function so the lint test can
see it — it is currently the only user-facing string in this component the test is blind to,
and it is the one that tells the user to run a command.

**Alternatives considered and rejected:**

- *Rename the title to something more explanatory.* Breaks three documents' assertions for a
  marginal gain, and "One more step" is genuinely good: it frames this as a step in a flow, not
  an error. The problem is the 12 words under it, not the four above.
- *Explain the encryption model in more detail.* Every additional sentence risks the banned-word
  list and, more importantly, the user does not need the model — they need to know where to look
  and what to compare. Two added sentences, no jargon.
- *Drop the mismatch line to keep the screen short.* Rejected on the plan's own terms
  (`auth-ux-overhaul-plan.md:2474-2479`): the verification code is a control, not decoration,
  and a control the user does not know how to fail is not a control.

### Testing

- `lib/__tests__/copy.test.ts` — the existing four assertions must still pass; verify
  `needKeysBody` still does not start with "run" and contains no banned substring (note it now
  contains the word "approve", which is fine). **Add** a fifth mirroring the existing
  `"the approve action names the check it depends on"`:
  `expect(copy.keys.codeMismatchRequester).toMatch(/code/i)`.
- Add a source-text test that `request-keys-panel.tsx` renders `phase.kind === "starting"` —
  the blank first paint is the part most likely to be silently reverted.
- Live: raise a key request from a second browser and read the screen cold. The success test is
  a user who knows, without being told, to go look at their other device.

### Risk / blast radius

Copy only, plus one new render branch. The one real hazard is the `copy.test.ts` regex: run
`pnpm --filter @kvy/web test` before assuming any new sentence is safe.

---

## Fix 10 — The `/pair/` key-fetch detour is a dead end

**Status: ✅ Implemented — Part A (reversible `confirm ⇄ needs-keys` transition) and Part B
(`RequestKeysPanel`'s optional `context` line) both implemented. **Deviation:** `Gate` was
moved from a local type in `page.tsx` into `pair-gate.ts` (previously page-local, unexported)
alongside the new `nextGate` pure function and `PairDetails` interface — required because a
Next.js `page.tsx` may only export the default component (same constraint `pair-gate.ts`'s
own docblock already documents for `resolvePairGate`), so the pure gate-transition function
the plan's testing note asks for ("extract it to a pure `nextGate(current, bridgeStatus,
details)` function") could not live in, or export a type from, `page.tsx` itself.
`pairDetails` hoisted into its own `useState` as the plan specifies. Tests: `pair-gate.test.ts`
gained a `nextGate` describe block (5 cases: demote, promote-with-details,
promote-with-nulls-on-failed-fetch, other-kinds-untouched, no-flicker-bounce on
loading/locked-out/needs-migration); `request-keys-panel.test.ts` gained context-rendering
and no-effect-dependency assertions. `copy.test.ts` picks up `resumeAfterKeys` automatically
via its function-invoking walker.**

### Root cause, and an upgrade in severity

The report describes this as "no transition explanation" between the key-request screen and the
CLI-pairing approval. That is true, and it is the smaller half. **The larger half is a
functional dead end:** `app/(public)/pair/page.tsx:93-98` demotes `gate` from `"confirm"` to
`"needs-keys"` when the bridge reports no keys, and **there is no inverse**. When the keys
arrive, `onReady` calls `void refresh()`, which flips `bridgeStatus` to `"ready"` — but the
effect at :93-98 only ever runs its demotion, so `gate` stays `"needs-keys"` forever and the
page keeps rendering `RequestKeysPanel`. The user completes the key hand-off and is left staring
at the screen they just finished, with the CLI still waiting.

### What was verified

```ts
// pair/page.tsx:91-98
  // 4. Crypto, second: approving needs the master secret, so a browser without keys is
  // routed to fetch them rather than dead-ended.
  useEffect(() => {
    if (bridgeStatus.kind !== "no-keys") return;
    setGate((current) =>
      current.kind === "confirm" ? { kind: "needs-keys", ephPub: current.ephPub } : current,
    );
  }, [bridgeStatus]);
```
```ts
// pair/page.tsx:130-136
  if (gate.kind === "needs-keys") {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <RequestKeysPanel onReady={() => void refresh()} />
      </main>
    );
  }
```

The comment's own promise — *"routed to fetch them rather than dead-ended"* — is not kept by the
code. Contrast the other `RequestKeysPanel` call site,
`password/page.tsx:112`, whose `onReady={() => router.replace(status.nextUrl)}` **does**
navigate onward; and `require-auth.tsx:98`, where `refresh()` is sufficient because `status`
*is* the render condition. `/pair/` is the only one of the three that keeps a second piece of
state (`gate`) that `refresh()` cannot move.

The screen sequence for a brand-new browser + brand-new CLI, traced end to end:

1. `/pair/#<ephPub>` → `"Checking link…"`
2. not signed in → `stashPendingPair` → `/signin/`, which **does** name the pairing
   ("Connect your machine" / "Sign in to finish connecting your machine.")
3. → `/password/`, which loses that context entirely (Fix 8)
4. → key-protection question → back to `/pair/`
5. bridge reports `no-keys` → **silently swapped** to "One more step" + a 6-digit code about a
   *different* device, with no back-reference to the machine being connected
6. keys arrive → **stuck** (this fix)

### Affected files

- `packages/web/src/app/(public)/pair/page.tsx`
- `packages/web/src/components/auth/request-keys-panel.tsx` (an optional context line)
- `packages/web/src/lib/copy.ts`

### Proposed fix

**Part A — give the demotion an inverse.** Widen the effect so it promotes back to `"confirm"`
when the bridge becomes ready, preserving the `ephPub` it stashed.

```diff
-  useEffect(() => {
-    if (bridgeStatus.kind !== "no-keys") return;
-    setGate((current) =>
-      current.kind === "confirm" ? { kind: "needs-keys", ephPub: current.ephPub } : current,
-    );
-  }, [bridgeStatus]);
+  // The detour is REVERSIBLE. Demoting `confirm` -> `needs-keys` without an inverse left the
+  // user stranded on the key-request panel after their keys arrived: `onReady`'s `refresh()`
+  // moves `bridgeStatus`, but nothing moved `gate` back, so the approval card never
+  // returned and the CLI kept waiting.
+  useEffect(() => {
+    setGate((current) => {
+      if (bridgeStatus.kind === "no-keys" && current.kind === "confirm") {
+        return { kind: "needs-keys", ephPub: current.ephPub };
+      }
+      if (bridgeStatus.kind === "ready" && current.kind === "needs-keys") {
+        return { kind: "confirm", ephPub: current.ephPub, ...pairDetails };
+      }
+      return current;
+    });
+  }, [bridgeStatus, pairDetails]);
```

This needs the `fetchPairDetails` result (`label`, `cwd`, `requestedAt`, fetched at :74-83) to
survive the detour. Simplest shape that keeps the existing `Gate` union honest: hoist those
three fields into their own `useState` set once by the first effect, and have both `confirm`
transitions read from it — rather than trying to smuggle them through the `needs-keys` variant.

**Part B — name the destination.** Give `RequestKeysPanel` an optional `context` line rendered
under the body, and pass the machine label from `/pair/`:

```diff
-export function RequestKeysPanel({ onReady }: { onReady: () => void }) {
+export function RequestKeysPanel({
+  onReady,
+  context,
+}: {
+  onReady: () => void;
+  /** One line naming what happens after the keys land — e.g. which machine is waiting to be
+   *  connected. Without it, `/pair/`'s detour reads as two unrelated prompts in a row. */
+  context?: string;
+}) {
```

```diff
   if (gate.kind === "needs-keys") {
     return (
       <main className="flex min-h-screen items-center justify-center p-8">
-        <RequestKeysPanel onReady={() => void refresh()} />
+        <RequestKeysPanel
+          onReady={() => void refresh()}
+          context={copy.pair.resumeAfterKeys(pairDetails?.label ?? copy.pair.unknownMachine)}
+        />
       </main>
     );
   }
```

```ts
// copy.ts, in the `pair` block alongside `unknownMachine`
/** Shown on the key-request panel when it interrupts a pairing, so the two prompts read as
 *  one flow instead of two unrelated demands. */
resumeAfterKeys: (machine: string) =>
  `Once your keys arrive, we'll bring you straight back to connecting ${machine}.`,
```

`copy.test.ts` invokes functions with the literal `"Sample"`, so this string is automatically
covered by the jargon assertions.

**Alternatives considered and rejected:**

- *A separate interstitial screen ("Got your keys — now connecting your CLI").* An extra screen
  in a flow whose problem is already too many screens. Principle 6 says every waiting screen
  updates itself; the right answer is to make the transition legible *before* it happens, not
  to add a beat after it.
- *Fold the two approvals into one card.* Tempting and wrong: they are two distinct grants — a
  key share and a machine connection — with two distinct verification steps. The plan is
  explicit that these controls must not be simplified for visual polish
  (`auth-ux-overhaul-plan.md:2474-2479`).
- *Fix only the copy and leave the dead end.* Would make the stuck screen better-worded.

### Testing

- `app/(public)/pair/page.test.ts` and `pair-gate.test.ts` already exist. Add a case to whichever
  owns the gate logic: `bridgeStatus: "no-keys"` on a `confirm` gate → `needs-keys`; then
  `bridgeStatus: "ready"` on that `needs-keys` gate → back to `confirm` **with the same
  `ephPub`**. If the gate transition is inline in the component, extract it to a pure
  `nextGate(current, bridgeStatus, details)` function first — that is the pattern
  `signin-gate.test.ts` and `devices-revoke-state.test.ts` already use in this package.
- Assert `RequestKeysPanel` renders `context` when given and nothing extra when omitted (its two
  other call sites pass nothing).
- `lib/__tests__/copy.test.ts` picks up `resumeAfterKeys` automatically via its function-invoking
  walker.
- Live (this is E2E-4.9/4.10's blocked scenario, so it needs a second browser profile): brand-new
  browser + brand-new CLI, and confirm the user is returned to the "Connect this machine?" card
  after the keys arrive.

### Risk / blast radius

`/pair/` is the highest-stakes public route in the product and its gate ordering is deliberate
and documented (:43-47, *"IDENTITY FIRST, crypto second"*). Part A adds a transition to a state
machine that currently only moves one way — get the guard conditions exactly right, or a browser
that flickers `ready → no-keys → ready` could bounce the user between screens. Both arms are
guarded on the *current* gate kind, which prevents that, but it is the thing to review hardest.

Part B touches a component with three call sites (`pair/page.tsx:133`,
`password/page.tsx:112`, `require-auth.tsx:98`). The prop is optional, so the other two are
unaffected — but note `RequestKeysPanel`'s deliberate `onReadyRef` pattern (:35-42): its
docstring records that putting `onReady` in a deps array re-ran the effect and minted a fresh
key request every render until the rate limit tripped. **Do not add `context` to any effect's
dependency array.**

---

## Fix 11 — First click after load is swallowed — diagnosis plan

**Status: ✅ Implemented (the two confirmed sub-fixes) — `/pair/`'s Approve button now
`disabled={bridgeStatus.kind !== "ready"}` with a `copy.pair.preparingCta` ("Preparing…")
label swapped in while disabled; `key-request-listener.tsx`'s send-keys button gained
`disabled={pending || !bridge}` (defensive — the outer `if (!card || !bridge) return null;`
already keeps this card unmounted until `bridge` exists, so `!bridge` can't be true in
practice today, but the button must never be ABLE to look clickable while it can't do
anything, and a future change to that gate should not silently reopen this). Tests:
`pair/page.test.ts` gained a describe block asserting the disabled prop and the
ready/preparing label swap; new `key-request-listener.test.ts` (no prior test file) asserts
the disabled prop. **The diagnosis portion (ranked hypotheses 1–6, requiring a live
`document.body.style.pointerEvents` check and a `next build` + static server repro) was
NOT performed** — it needs a live human-driven browser session per the plan's own
instructions ("the diagnosis needs a live session and should not gate anything"), which is
outside what this pass could execute. Flagging for the user: run the plan's suggested
order-of-work (H1 stuck-Radix-body-lock check first, since it's the only hypothesis that
explains the account-menu button also failing) in a live session before considering Fix 11
fully closed.**

### Status

This one ends in a **diagnosis plan plus two confirmed sub-fixes**, not a single root cause.
Static reading found two places that reproducibly swallow a click today, and four further
candidates that need live instrumentation to separate. Both confirmed sub-fixes are one-liners
and worth landing regardless of what the live session finds.

### Confirmed today, no live debugging needed

**(a) `/pair/`'s Approve button is enabled while it cannot work.**

```ts
// pair/page.tsx:100-101
  async function approve(ephPub: string, label: string | null): Promise<void> {
    if (bridgeStatus.kind !== "ready") return;
```
```ts
// pair/page.tsx:169-171
            <Button type="button" onClick={() => void approve(gate.ephPub, gate.label)}>
              {copy.pair.approveCta}
            </Button>
```

The button looks and behaves as clickable, and `approve()` returns silently while the crypto
worker is still booting. That is a literal swallowed first click, on the single most important
button in the pairing flow. Same shape at `key-request-listener.tsx:81`
(`if (!token || !bridge) return;` inside `approve()`).

**Fix:** `disabled={bridgeStatus.kind !== "ready"}` plus a pending label, matching what
`password/page.tsx:169` already does correctly (`disabled={status.kind === "pending" || !bridge}`).
This is a no-silent-failures fix, not a workaround.

### Environment facts established

- **react 19.2.7, react-dom 19.2.7, next 15.5.20**, sonner 2.0.7, radix-ui 1.6.2.
- **No application code intercepts clicks.** An exhaustive grep for
  `addEventListener("click"|"pointerdown"|"mousedown")`, `click-outside`, `useClickOutside`,
  `onPointerDownOutside`, `onInteractOutside`, `onClickCapture`, `capture: true` across
  `packages/web/src` returns exactly **one** hit — `features/new-session/components/options-step.tsx:70`,
  a local `onPointerDown={(e) => e.stopPropagation()}`. Every other `document`/`window`
  listener is `keydown` (sidebar Cmd-B), `dragover`/`drop`, `online`/`offline`, `storage`, or
  `visibilitychange`. **This whole class of cause is ruled out.**
- **Nothing full-screen mounts unconditionally.** `fixed inset-0` appears only in
  `components/ui/dialog.tsx:33` and `sheet.tsx:33`, both Radix overlays that mount while open.
  The only always-mounted overlay is `KeyRequestListener` (`require-auth.tsx:108`), anchored
  `bottom-4` and returning `null` unless it has a card.
- `providers.tsx` mounts exactly three things — `QueryClientProvider`, Radix `TooltipProvider`,
  sonner `<Toaster/>` — and handles no clicks.
- `next.config.ts:26` applies `output: "export"` **only for `next build`**; `next dev` runs a
  normal dev server. Dev and production therefore have materially different chunking and
  hydration timing.
- `components/ui/button.tsx` is a Radix `Slot` / `asChild` component with **no** `onPointerDown`
  handling; it spreads props verbatim. Relevant base classes: `select-none`,
  `disabled:pointer-events-none`. Note it sets **no default `type`**, so a `<Button>` inside a
  `<form>` without an explicit `type` is a submit button.

### Ranked hypotheses and how to test each

1. **A stuck Radix body lock.** Radix's `DismissableLayer` / `react-remove-scroll` sets
   `pointer-events: none` on `document.body` while a dropdown/dialog/select is open and restores
   it on close. If one unmounts across a route change instead of closing, the style is never
   restored and **every** subsequent click is swallowed — which matches "multiple different
   buttons, including the account-menu button" better than any hydration theory.
   Prime suspect: `components/nav-user.tsx`, whose `DropdownMenuItem` handlers both navigate
   (`:46 router.replace(SIGNIN_PATH)`) and open a dialog (`:96 setSettingsOpen(true)`).
   **Test:** after a swallowed click, run `document.body.style.pointerEvents` in the console. If
   it is `"none"`, stop — this is the cause and nothing else here matters.
2. **Ordinary hydration lag in `next dev`.** Handlers are not attached when the page appears
   interactive. Amplified here by `useCryptoBridge()` returning `null` on first render and only
   acquiring the worker in an effect, which `/password/`'s `disabled={… || !bridge}` correctly
   reflects (dead but visibly disabled) and `/pair/` does not (hypothesis (a) above).
   **Test:** reproduce against `next build` + a static file server, never `next dev`. If it
   vanishes, it is dev-only and lower priority.
3. **A pre-hydration native form submit on `/password/`** — *demoted in rev 2; probably not
   real.* With `output: "export"`, `/password/index.html` ships a real
   `<form onSubmit={handleSubmit}>` (:125), so before hydration `preventDefault` is unwired and
   a submit would perform a native `GET /password/?email=…&password=…`. **But the button that
   would trigger it is `disabled` in that very HTML** — `page.tsx:166-170` is
   `<Button type="submit" … disabled={status.kind === "pending" || !bridge}>`, and `bridge` is
   `null` until the effect acquires it. A disabled submit button cannot be clicked, and HTML
   implicit submission (Enter in a text field) does nothing when the form's default button is
   disabled. So the pre-hydration window is effectively closed by hypothesis 2's own mechanism,
   and rev 1's "security finding in its own right" framing overstated it.
   **Test:** keep the URL-bar check in the diagnostic script — it is free — but do not spend
   time here before 1 and 2.
4. **An SRI-blocked chunk.** `next.config.ts:41-54` documents a previously-observed failure where
   SRI blocked the webpack runtime and produced *"a silent, totally blank page with no console
   error"*. A partially-blocked chunk would present as "JS never runs, clicks do nothing".
   **Test:** check the console for `integrity`/SRI violations during the repro.
5. **Re-render churn right after hydration.** Three separate sources flip state immediately
   after mount: `useTheme()`'s `useSyncExternalStore` snapshot (`lib/use-theme.ts:85-97`),
   `hooks/use-mobile.ts` (`undefined` → real, re-rendering the whole `SidebarProvider` subtree
   and swapping the sidebar between desktop and `Sheet` trees), and `useCryptoBridge`'s
   `setBridge`. A button whose identity changes across that swap can lose a click already in
   flight.
   **Test:** add a `pointerdown`/`click` capture-phase logger at `document` and compare against
   React's `onClick` firing; a `pointerdown` with no matching `onClick` localises it precisely.
6. **`RequireAuth`'s double `null` gate.** `require-auth.tsx:70` and `:103` render `null` until a
   network round trip and a worker boot complete. This produces a *blank screen*, not a dead
   button, so it explains "clicked where a button was about to be" but not the reported symptom.
   Lowest priority.

### Suggested order of work

1. Land the two confirmed sub-fixes (`pair/page.tsx` Approve button, `key-request-listener.tsx`)
   — they are correct independent of the investigation.
2. Run diagnostics 1 and 2 first — H1 (stuck Radix body lock) is the only listed mechanism that
   explains the **account-menu button** also failing, so it stays first.
3. Only if both come back clean, instrument (5) and re-test against a production build.

### Affected files (confirmed sub-fixes only)

- `packages/web/src/app/(public)/pair/page.tsx`
- `packages/web/src/components/auth/key-request-listener.tsx`

### Testing

- `components/ui/button.test.ts` asserts on `buttonVariants()` output including
  `disabled:pointer-events-none` and `disabled:opacity-50` — unaffected, but do not change the
  base class string without checking it.
- For the sub-fixes, a source-text assertion that `/pair/`'s Approve button carries a `disabled`
  prop derived from `bridgeStatus` is enough given this package's no-DOM test environment.

### Risk / blast radius

The sub-fixes are additive `disabled` props; the worst case is a button that stays disabled
longer than necessary, which is strictly better than one that lies. The diagnosis work itself is
read-only.

---

## Implementation and PR sequencing

| Order | Fix | Why here | Rough size |
|---|---|---|---|
| 1 | **Fix 1** — migration runner | Infrastructure. Nothing else can be verified against a database missing `key_requests`. Land first, alone. | 1 file changed + 1 new test + config + docs |
| 2 | **Fix 2** — worker `API_URL` + refresh outcome | Unblocks every web-side E2E. Nothing web can be tested while a reload signs the user out. Includes all four `silentRefresh` call sites, `pair-gate.ts`'s dep type, and Part C's unreachable state. | 9 files + 4 test files |
| 3 | **Fix 3** — CLI re-pair | Same root-cause family as Fix 2 (*a credential's liveness is only knowable from the server; both bugs trusted a local proxy for it*). Independent of Fix 2 in code, so it can go in parallel — plan them together, ship them separately. | 4 files + 3 test files |
| 4 | **Fix 4** — account-bound key material | Depends on Fix 2: its account-id threading needs `getAccountId()` to return a real value on a cold load, which today it cannot. Largest surface here; give it its own PR and its own review. **Part A2 (OAuth) ships in this same PR** — see the note below. | 10 files + 4 test files |
| 5 | **Fix 5** — logout deletes the databases | Same storage layer as Fix 4; landing them adjacent means one review pass over `key-storage.ts` instead of two. | 5 files + 2 test files |
| 6 | **Fix 6** — unmanaged transcript backfill | Fully independent (CLI daemon). Can go any time after Fix 1; placed here because it is the highest-severity remaining item. | 2 files + 1 test file |
| 7 | **Fix 7** — CLI key-request notification | Independent. Needs live terminal verification before enabling by default, so it should not block anything. | 5 files + 2 test files |
| 8 | **Fix 8** — `/password/` default mode | One line; unblocks clean manual testing of the flow Fixes 9 and 10 live in. | 1–2 files + 1 test |
| 9 | **Fix 9** — requester-panel copy | Establishes the copy tokens Fix 10 reuses. | 3 files |
| 10 | **Fix 10** — `/pair/` dead end + handoff | Builds on Fix 9's tokens. Contains a real functional bug, so do not defer it as "just copy". | 3 files + 1 test |
| 11 | **Fix 11** — swallowed first click | Two one-line sub-fixes now; the diagnosis needs a live session and should not gate anything. | 2 files, plus investigation |

**Total scope (rev 2):** roughly **52 source files touched** across `packages/server` (4),
`packages/web` (29), `packages/cli` (11), plus build scripts and docs; and around **21 test
files** created or updated. Three new files (`db/migrate.test.ts`, a build-worker test, and
`complete-oauth-sign-in.test.ts` if it does not already exist). No schema migrations, no
wire-protocol changes to `@kvy/wire`, and one internal main-thread↔worker protocol change
(Fix 2's `RefreshOutcome`, Fix 4's account-id parameters) that ships as a single bundle pair
and so carries no version-skew risk.

**Suggested merge order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11.

**Sequencing note added in rev 2 — Part A2 is not a follow-up.** Fix 4's OAuth half must ship
*inside* Fix 4's PR. Splitting it produces a release where the dev-only password path is
account-scoped and the production OAuth path is not — which is worse than today's uniform
behaviour from an auditing standpoint, because the protection becomes conditional on which
sign-in button the user pressed, and nothing in the UI says so.

**Re-run after landing 1–5:** the full `auth-ux-overhaul-e2e-checklist.md`, with particular
attention to E2E-4.1, E2E-6.1 and E2E-6.4 — the three CRITICAL failures — plus the two items
listed as out of scope below, which only become testable once these land.

---

## Deliberately not in scope

- **Section 3 (web-first zero-machine onboarding).** Entirely BLOCKED in the E2E run — not
  attempted, no evidence either way (`auth-ux-overhaul-e2e-results.md:113-117`). This needs
  **verification**, not a fix. It is one of the three original complaints the overhaul set out
  to address, so it should be the first thing tested in the next pass.
- **Whether a message sent right after a CLI re-pair decrypts in the web (E2E-4.8 / E2E-6.4's
  "critical half").** The result was INCONCLUSIVE and confounded by Fix 3's defect occurring in
  the same window. There is nothing to fix until it has been re-tested cleanly — which requires
  Fix 3 to land first, since today there is no successful re-pair to test with.
</content>
</invoke>
