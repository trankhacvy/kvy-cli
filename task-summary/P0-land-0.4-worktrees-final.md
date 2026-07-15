# P0-land-0.4-worktrees-final

**Section:** Phase 0 — 0.4 Server foundation (§3.2, §4)
**Type:** Integration merge (no new product code) — prepares the 0.4 server foundation
for landing onto `main`

## Context

`P0-land-0.4-worktrees-onto-main` had, across several prior cycles, assembled and
re-verified the complete Drizzle schema + `seq.ts` allocator + auth module +
`docker-compose.dev.yml` on top of `main`'s cycle-13 tip (`4121603`), but the branch
itself was never actually fast-forwarded/merged into `main` — `main` still had no
`packages/server/src/db/` as of its tip `4ed02a4` (cycle 16). This task builds a fresh
integration branch off the **current** `main` tip, merges the ready branch into it,
resolves the resulting conflicts, and re-verifies the build — leaving a branch that is
ready to be fast-forwarded onto `main` by a subsequent integration step (per this
task's explicit instructions, no merge/push into `main` itself was performed here).

## What this did

1. Created worktree `.worktrees/P0-land-0.4-worktrees-final` on new branch
   `P0-land-0.4-worktrees-final`, based on `main` tip `4ed02a4` (cycle 16, includes
   the P1 web-scaffold landing that postdates the 0.4 branch's base).
2. `git merge --no-ff P0-land-0.4-worktrees-onto-main` (branch tip `1cd7b21`). Two
   conflicts, both resolved:
   - `CLAUDE.md` package-layout table: both sides had edited the same table row —
     `main` had added the real `@falcon/web` (Next.js PWA) description after the web
     scaffold landed; the 0.4 branch had updated only the `@falcon/server` row. Kept
     `main`'s `@falcon/web` row and the branch's `@falcon/server` row (Drizzle +
     auth module description).
   - `pnpm-lock.yaml`: took `main`'s version then ran `pnpm install` to regenerate it
     against the merged `package.json` set (adds `drizzle-orm`, `drizzle-kit`,
     `jose`, `postgres`, `fastify-plugin`, `fastify-type-provider-zod`, etc. from
     `packages/server/package.json`).
   - No conflicts anywhere under `packages/server/src/` — confirms the task
     description's expectation that main's server package hadn't changed
     structurally since this branch's base.
3. Updated `plan.md`'s "0.4 Server foundation" status paragraph to describe the new
   integration branch and current state, and **reverted the premature `[x]` checkbox
   flips** the upstream branch had made for the five 0.4 bullets (Drizzle schema,
   migration runner, `seq.ts`, auth module, `docker-compose.dev.yml`) back to `[ ]`
   — per the standing project rule ("flip checkboxes only once verified live on
   `main`"), since this branch has not yet been merged into `main` and this task's
   instructions explicitly forbid doing so here. `P0-0.4-auth-challenge-route`,
   `P0-0.4-oauth-signin-routes`, and `P0-0.4-pairing-endpoints` remain unchecked and
   out of scope, as intended — they should be sequenced after this branch actually
   lands on `main`.
4. Ran `pnpm build`, `pnpm typecheck`, `pnpm test` on the merged tree — all green:
   - `@falcon/wire`: 61/61
   - `@falcon/crypto`: 65/65
   - `@falcon/server`: 55/55 (including all 5 `seq.test.ts` concurrency tests against
     a live local Postgres available in this environment — none skipped)
   - `falcon` (cli): 58/58
   - `@falcon/web`: 14/14
   - `pnpm build` and `pnpm typecheck`: 5/5 packages green across the board.
5. `pnpm lint` (`biome check .`) failed repeatedly with `[warn] Linter process
   terminated abnormally (possibly out of memory)`, including on files untouched by
   this merge (e.g. `packages/server/src/logger.ts` in isolation, which is
   pre-existing code) and on unrelated packages in isolation on some runs. This
   matches the transient-flakiness note already documented in this repo's
   `CLAUDE.md` ("Linter process terminated abnormally... transient resource
   contention... not a config problem"), and was reproduced even after killing a
   stray leftover `biome __run_server` daemon process. Spot-checks of individual
   package directories (`packages/crypto`, `packages/wire`, and `packages/server`
   with a raised `--max-diagnostics`) succeeded on at least one run each and
   surfaced no lint errors attributable to the newly merged files. Did not block on
   this — `pnpm build`/`pnpm typecheck`/`pnpm test`, the gates this task's
   instructions named explicitly, are all green.

## What's in this branch (unchanged from the source branch, for reference)

- `packages/server/src/db/{schema,client,migrate,seq}.ts` — Drizzle schema
  (`accounts`, `machines`, `workspaces`, `sessions`, `sessionMessages`,
  `unmanagedSessions`, `pairRequests`, `pushSubscriptions`, `blobs` + custom `bytea`
  type), migration-on-boot runner, and `allocMsgSeq`/`allocHeaderSeq` atomic
  `UPDATE … RETURNING` allocators (design DELTA D2).
- `packages/server/src/auth/{plugin,tokens,token-cache,index}.ts` — JWT (HS256)
  mint/verify, in-memory token cache, Fastify `authenticate` preHandler plugin.
- `packages/server/drizzle.config.ts` + `packages/server/drizzle/` — initial
  migration + snapshot.
- `docker-compose.dev.yml` at repo root — `postgres:16` for local dev.

## Assumptions / notes for the next step

- This branch (`P0-land-0.4-worktrees-final`) is **not** merged into `main`. A
  separate integration step should fast-forward or `--no-ff` merge it onto the then-
  current `main` tip, re-verify `pnpm build && pnpm typecheck && pnpm test`, and only
  then flip the five `plan.md` §16 0.4 checkboxes.
- Once landed, `P0-0.4-auth-challenge-route`, `P0-0.4-oauth-signin-routes`, and
  `P0-0.4-pairing-endpoints` (all separate worktrees building on this schema/auth
  foundation) can be sequenced in — not attempted here, to avoid double-applying
  shared prerequisite commits, per this task's instructions.
- The other now-superseded land-attempt worktrees/branches (`P0-land-0.4-worktrees`,
  `P0-land-0.4-worktrees-onto-main`, and the original component branches
  `P0-0.4-drizzle-schema`, `P0-0.4-docker-compose-dev`, `P0-0.4-auth-module`,
  `P0-0.4-seq-allocator`) are still present and unremoved; cleanup of stale
  worktrees is out of scope for this task and left to the orchestrator's cleanup
  phase once this branch is confirmed landed.
