# P0-land-0.4-worktrees — Land the ready P0-land-0.4-worktrees-onto-main integration branch onto main

**Section:** Phase 0 — Repo & contracts (M0) / §0.4 Server foundation
**Type:** Integration landing task (no new product code)

> Note on naming: an earlier, different task in this repo's history was also
> named `P0-land-0.4-worktrees` (it merged four Phase-0.4 worktrees into an
> integration branch — see `task-summary/P0-land-0.4-worktrees-onto-main.md`
> and `git log --oneline b391b89` for that work). This file now documents the
> **current** task with that same name: taking the already-built,
> already-verified `P0-land-0.4-worktrees-onto-main` branch (tip `03ff892`,
> merge commit `efc08db`) and landing it onto a fresh `main`-based worktree so
> it's ready for the orchestrator to fast-forward `main` itself.

## What this did

1. Confirmed `.worktrees/P0-land-0.4-worktrees-onto-main` (branch
   `P0-land-0.4-worktrees-onto-main`) already contains a clean merge of the
   four completed Phase-0.4 worktrees, built essentially on top of `main`'s
   tip:
   - `P0-0.4-drizzle-schema` — Drizzle schema (`accounts`, `machines`,
     `workspaces`, `sessions`, `sessionMessages`, `unmanagedSessions`,
     `pairRequests`, `pushSubscriptions`, `blobs` + custom `bytea` type) +
     initial `drizzle-kit generate` migration + migration-on-boot runner.
   - `P0-0.4-docker-compose-dev` — `docker-compose.dev.yml` (Postgres 16 for
     local dev).
   - `P0-0.4-auth-module` — JWT mint/verify (HS256) + in-memory token cache +
     Fastify `app.authenticate` preHandler plugin.
   - `P0-0.4-seq-allocator` — `seq.ts`: `allocMsgSeq` (per-session) /
     `allocHeaderSeq` (per-account), atomic `UPDATE … RETURNING`, with a
     concurrency test (skipped without a live Postgres).
2. `git merge-base main P0-land-0.4-worktrees-onto-main` == `main`'s own tip
   (`cc17a14`) — i.e. the integration branch's base *is* current `main`, no
   divergence to reconcile. Created this fresh worktree off `main`
   (`git worktree add .worktrees/P0-land-0.4-worktrees -b P0-land-0.4-worktrees main`)
   and ran `git merge --no-ff P0-land-0.4-worktrees-onto-main`.
3. Merge was completely clean — **zero conflicts** (33 files changed, 3539
   insertions(+), 15 deletions(-)); confirms the branch really was built
   directly on `main`'s current tip as described in the task.
4. Independently re-verified from scratch in the new worktree (`pnpm install`
   then forced, non-cached runs):
   - `pnpm build --force` — 3/3 packages succeed (`@falcon/wire`,
     `@falcon/crypto`, `@falcon/server`).
   - `pnpm typecheck --force` — 3/3 packages succeed.
   - `pnpm test --force` — 6/6 package test runs succeed:
     `@falcon/wire` 61/61, `@falcon/crypto` 65/65, `@falcon/server` 50/55 (5
     `seq.test.ts` concurrency tests skipped — they require a live Postgres
     via `DATABASE_URL`, unavailable in this sandbox, consistent with every
     prior task-summary for this lineage).
5. Checked `plan.md` §16 "0.4 Server foundation" — already correctly reflects
   the landed state from the upstream branch: Drizzle schema, migration,
   `seq.ts`, auth module, and `docker-compose.dev.yml` bullets are all `[x]`,
   with `POST /v1/auth` challenge/response, OAuth routes, and pairing
   endpoints correctly left `[ ]` (not part of this scope). No further edits
   needed.

## Result

`main` (`cc17a14`) plus this merge now contains the full, working Phase-0.4
server foundation: Drizzle schema + migration, `docker-compose.dev.yml`, the
auth module (mint/verify + cache), and `seq.ts`. This worktree's branch
(`P0-land-0.4-worktrees`) is a direct, conflict-free superset of `main` and is
ready to be fast-forwarded/merged into `main` by the orchestrator's landing
cycle.

## Explicitly NOT included

`P0-0.4-auth-challenge-route` (the `POST /v1/auth` route implementation) was
**not** part of `P0-land-0.4-worktrees-onto-main` and is **not** landed here —
per the upstream task-summary, it still needs its two route-implementing
commits rebased/cherry-picked onto the new `main` tip as a follow-up task.

## Assumptions

- Did not merge this worktree's branch into the real `main` branch and did
  not push — per task instructions, this is a commit-in-worktree landing step;
  the orchestrator's cycle process performs the actual fast-forward onto
  `main`.
- No live Postgres was available in this sandbox, so `seq.test.ts`'s 5
  concurrency tests remain skipped (not failures).
