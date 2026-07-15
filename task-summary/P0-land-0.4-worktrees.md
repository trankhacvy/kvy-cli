# P0-land-0.4-worktrees — Land the four ready Phase-0.4 worktrees into main

## What this task was

An orchestration/integration task, not a new feature. Four sibling task
worktrees held complete, self-verified, committed work for plan.md §16
"0.4 Server foundation" that had never been merged anywhere:

- `P0-0.4-drizzle-schema` (`9c66020`) — Drizzle ORM schema (`accounts`,
  `machines`, `workspaces`, `sessions`, `sessionMessages`,
  `unmanagedSessions`, `pairRequests`, `pushSubscriptions`, `blobs` + custom
  `bytea` type), initial `drizzle-kit generate` migration, migration-on-boot
  runner, `DATABASE_URL` config env var.
- `P0-0.4-docker-compose-dev` (`04d4e94`) — `docker-compose.dev.yml`
  (postgres:16 for local dev). Disjoint from everything else.
- `P0-0.4-auth-module` (`c9823c4`) — `src/auth/`: JWT HS256 mint/verify
  (`tokens.ts`), in-memory token cache (`token-cache.ts`), Fastify plugin
  decorating `app.authenticate` (`plugin.ts`), `FALCON_MASTER_SECRET` config
  env var. Built on top of `drizzle-schema`'s config.ts.
- `P0-0.4-seq-allocator` (`8280d8b`) — `src/db/seq.ts`: `allocMsgSeq`
  (per-session) and `allocHeaderSeq` (per-account) atomic `UPDATE …
  RETURNING` allocators, plus a concurrency test (requires a live Postgres,
  skipped without one). Built directly on top of `drizzle-schema`.

This mirrors the `P0-merge-pending-worktrees` / `P0-land-phase0-worktrees`
pattern already used successfully in this repo's history: build and verify
the integration on an isolated branch first.

**Explicitly out of scope** (per task instructions): `P0-0.4-auth-challenge-route`
was NOT merged here. That branch currently contains only the two merged
prerequisite commits (`drizzle-schema` + `auth-module`) with no task-summary
and no actual `POST /v1/auth` route implementation of its own — landing it
would credit unwritten work. The real challenge/response route remains a
separate follow-up task.

## Merge order and outcome

Worked in `.worktrees/P0-land-0.4-worktrees`, branched from `main`'s tip at
the time (`2dcbde4`), per the dependency order specified in the task
(`drizzle-schema` first since both `seq-allocator` and `auth-module` build on
its `config.ts`/schema; `docker-compose-dev` is disjoint and merged in
between for convenience).

1. **`P0-0.4-drizzle-schema`** (`7fa2fcb`) — clean, no conflicts.
2. **`P0-0.4-docker-compose-dev`** (`aae2e02`) — clean, no conflicts
   (touches only `docker-compose.dev.yml` + its own task-summary).
3. **`P0-0.4-auth-module`** (`75bfefd`) — **3-way conflicts**, all expected
   (both branches independently extended the same `EnvSchema` in
   `config.ts`/`config.test.ts`, and both touched the `packages/server`
   bullet in root `CLAUDE.md`). Resolved by hand:
   - `packages/server/src/config.ts`: merged into one `EnvSchema` object
     carrying both `DATABASE_URL` (drizzle-schema) and
     `FALCON_MASTER_SECRET` + the production-secret `.refine()` guard
     (auth-module).
   - `packages/server/src/config.test.ts`: kept every test from both
     branches (defaults test now asserts both new fields; production test
     sets/asserts both; both new "throws when empty/short" tests kept).
   - `CLAUDE.md`: merged both one-line descriptions of `packages/server`
     into a single paragraph mentioning Drizzle, migrations, and the auth
     module together.
   - `pnpm-lock.yaml` / `packages/server/package.json` / `server.ts` /
     `logger.test.ts`: auto-merged cleanly by git (disjoint hunks), verified
     by inspection afterward — dependency lists carry both branches' new
     deps (`drizzle-orm`, `postgres`, `jose`, `@paralleldrive/cuid2`, etc.).
4. **`P0-0.4-seq-allocator`** (`a1dd84d`) — clean, no conflicts (its only
   overlap, `drizzle-schema`, was already on this branch).

## Fixes applied on the integration branch

- **Biome formatting** (post-merge, same commit): merging introduced 4 real
  `pnpm lint` **errors** — two drizzle-kit-generated JSON files
  (`drizzle/meta/0000_snapshot.json`, `drizzle/meta/_journal.json`) missing
  a trailing newline, `packages/server/src/db/seq.test.ts` (never
  biome-formatted before being committed on its source branch), and
  `packages/server/src/config.ts` (my conflict-resolution merge produced a
  line the formatter wanted wrapped differently). Fixed with
  `biome check --write` on exactly those four files — pure reformatting,
  re-ran `pnpm build`/`typecheck`/`test` afterward to confirm no behavior
  changed. The remaining 32 `pnpm lint` warnings (in `@falcon/crypto` and
  `scripts/postinstall.cjs`) are pre-existing on `main` and out of scope.
- **`plan.md` §16 checkboxes**: checked off the `seq.ts` bullet, the "Auth
  module: token mint/verify … token cache" bullet, and the
  `docker-compose.dev.yml` bullet under "0.4 Server foundation" (the
  Drizzle-schema and migration bullets were already checked from a prior
  cycle). Left unchecked, per task instructions: the `POST /v1/auth`
  challenge/response route, OAuth sign-in routes, and pairing endpoints —
  none of those exist yet. Updated the section's status note to record the
  merge and explain why `auth-challenge-route` was deliberately excluded.

## Verification

From the integration branch root, after all four merges + the formatting
fix:

- `pnpm install` — lockfile unchanged, no conflicts, resolves cleanly.
- `pnpm build` — 3/3 packages succeed (`@falcon/wire`, `@falcon/crypto`,
  `@falcon/server`).
- `pnpm typecheck` — 3/3 packages succeed.
- `pnpm test` — 6/6 package test runs succeed: `@falcon/wire` 61/61,
  `@falcon/crypto` 65/65, `@falcon/server` 50/55 (5 skipped — `seq.test.ts`'s
  concurrency tests need a live Postgres connection via `DATABASE_URL`, by
  design; they're not run in this sandbox).
- `pnpm lint` — 0 errors (down from 4 after the formatting fix), same 32
  pre-existing warnings as `main`.

## Assumptions

- Did not attempt to spin up Postgres to un-skip `seq.test.ts`'s concurrency
  tests — out of scope for a merge/integration task, and the task
  instructions only require `build`/`typecheck`/`test` to be green, which
  they are (skipped tests aren't failures).
- Did not merge or push this branch onto `main` — per task instructions,
  landing the integration branch itself is a separate follow-up step.
