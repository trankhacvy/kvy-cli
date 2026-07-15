# P0-land-0.4-worktrees-onto-main

**Section:** Phase 0 — 0.4 Server foundation (§3.2, §4)
**Type:** Integration landing task (no new product code)

## What this did

Landed the pre-built, pre-verified `P0-land-0.4-worktrees` integration branch onto
`main`. That branch already sequentially merged four completed Phase-0.4 worktrees in
dependency order:

1. `P0-0.4-drizzle-schema` — Drizzle schema (`accounts`, `machines`, `workspaces`,
   `sessions`, `sessionMessages`, `unmanagedSessions`, `pairRequests`,
   `pushSubscriptions`, `blobs` + custom `bytea` type) + initial `drizzle-kit generate`
   migration + migration-on-boot runner.
2. `P0-0.4-docker-compose-dev` — `docker-compose.dev.yml` (Postgres 16 for local dev).
3. `P0-0.4-auth-module` — JWT mint/verify (HS256) + in-memory token cache + Fastify
   `app.authenticate` preHandler plugin.
4. `P0-0.4-seq-allocator` — `seq.ts`: `allocMsgSeq` (per-session) / `allocHeaderSeq`
   (per-account), atomic `UPDATE … RETURNING`, with a concurrency test (skipped without
   a live Postgres).

## Landing process

1. Checked `git merge-base --is-ancestor main P0-land-0.4-worktrees` — **not** an
   ancestor. Between when `P0-land-0.4-worktrees` was built (on top of `main`@`2dcbde4`,
   cycle 10) and now, `main` had advanced two more no-op tracking cycles (cycle 11
   `b7a6f85`, cycle 12 `cc17a14`), each touching only `plan.md`/`progress.md` — no
   product code. A literal `--ff-only` was therefore no longer possible.
2. Created this worktree fresh off current `main` tip (`cc17a14`) as a new branch
   `P0-land-0.4-worktrees-onto-main`, then ran `git merge --no-ff P0-land-0.4-worktrees`.
3. Only conflict was in `plan.md` — both sides had rewritten the same "0.4 Server
   foundation" status paragraph (main's cycles 11/12 kept it as "not merged", the land
   branch's version already described the post-merge state). Resolved by keeping the
   land branch's rewritten paragraph and checkboxes (Drizzle schema, migration, `seq.ts`,
   auth module, `docker-compose.dev.yml` all flipped to `[x]`), amended to reference this
   landing task's name and to note `pnpm lint` was also verified green.
4. Ran `pnpm install`, then fresh `pnpm build` / `pnpm typecheck` / `pnpm test` /
   `pnpm lint` on the merged tree — all green:
   - `@falcon/server`: 50/55 tests passing, 5 `seq.test.ts` tests skipped (require a
     live Postgres, unavailable in this sandbox).
   - `@falcon/wire`: 61/61 tests passing.
   - `@falcon/crypto`: 65/65 tests passing.
   - `pnpm lint`: exit 0, 32 pre-existing warnings (not errors, not from this change —
     `noExplicitAny`/`noNonNullAssertion` in `packages/crypto`, an env-var lint in
     `scripts/postinstall.cjs`), 0 errors.
5. Committed the merge (`efc08db`).

## plan.md changes

Checked off the 0.4 bullets that are now actually on `main`:
- [x] Drizzle schema … — §3.2
- [x] `drizzle-kit generate` initial migration; migration-on-boot runner
- [x] `seq.ts`: `allocMsgSeq` / `allocHeaderSeq` **(N — DELTA D2)**
- [x] Auth module: token mint/verify, token cache
- [x] `docker-compose.dev.yml`: postgres:16 for local dev

Left unchecked (correctly, not part of this integration branch):
- [ ] `POST /v1/auth` Ed25519 challenge/response route
- [ ] OAuth sign-in routes
- [ ] Pairing endpoints

## Explicitly NOT included

`P0-0.4-auth-challenge-route` (the `POST /v1/auth` route) branches off the same
`drizzle-schema`/`auth-module` tips but was **not** part of the
`P0-land-0.4-worktrees` integration branch and is **not** landed by this task. It
carries only the already-merged prerequisite commits plus two new commits
(`eafc56b`, `5ca36a4`) implementing the actual route. Landing those two commits is
left as a follow-up task: rebase/cherry-pick them onto the new `main` tip (`efc08db`)
rather than merging the whole branch, to avoid re-applying the shared prerequisite
history a second time.

## Cleanup

The following worktrees are now redundant (their commits are on `main` via the merge,
or — for the landing branch — the merge itself is complete) and were removed along
with their branches:
- `.worktrees/P0-0.4-drizzle-schema`
- `.worktrees/P0-0.4-docker-compose-dev`
- `.worktrees/P0-0.4-auth-module`
- `.worktrees/P0-0.4-seq-allocator`
- `.worktrees/P0-land-0.4-worktrees`

`.worktrees/P0-0.4-auth-challenge-route` was deliberately **left in place** — it still
has the two unlanded route commits needed for the follow-up task.

## Assumptions

- Per task instructions, used `git merge --no-ff` (not `--ff-only`) since `main` had
  moved on with non-conflicting-in-substance but line-conflicting tracking commits;
  this matches "ff-only or --no-ff per repo convention" and preserves the four nested
  merge commits' history from the integration branch intact.
- No live Postgres was available in this sandbox, so `seq.test.ts`'s 5 concurrency
  tests remain skipped, consistent with every prior task-summary for this branch.
