# P1-land-1.6-crypto-worker-onto-main — Land the prepared crypto-worker branch onto main

**Section:** Phase 1 §1.6 Web app v1 (read-only) — plan.md line 701

## Context

A prior land-branch, `P1-land-1.6-crypto-worker` (tip `1be84b9`, merge-base `4ed02a4`),
already contained the crypto-bridge Worker code plus fixups (test-failure fix, code-review
refactor) and self-reported green across two prior cycles. Despite that, it had never
actually been merged into `main` — confirmed both by this task and by the prior cycles
(17, 18) via `git merge-base --is-ancestor P1-land-1.6-crypto-worker main` returning
false. This task performs the real merge.

## What this task did

1. Confirmed via `git merge-base --is-ancestor P1-land-1.6-crypto-worker main` that the
   branch was not yet an ancestor of `main` (tip `fad6f3e`), and confirmed the branch's
   merge-base with `main` is `4ed02a4`.
2. Created the worktree `.worktrees/P1-land-1.6-crypto-worker-onto-main` on a fresh
   branch `P1-land-1.6-crypto-worker-onto-main`, based on current `main` (`fad6f3e`).
3. Ran `git merge --no-ff P1-land-1.6-crypto-worker`. Result: one conflict, in
   `plan.md` (both `main` and the land branch had independently edited the same §1.6
   "Crypto worker" bullet — `main`'s side documented it as *not yet merged*, the land
   branch's side pre-emptively documented it as *merged*). `pnpm-lock.yaml` auto-merged
   cleanly; all `packages/web/src/crypto/*` files applied without conflict.
4. Resolved the `plan.md` conflict by keeping the checked `[x]` bullet and rewriting the
   annotation to reflect the actual land performed by this task (branch name
   `P1-land-1.6-crypto-worker-onto-main`, main tip `fad6f3e`, verified green in this
   worktree) rather than trusting either side's pre-existing self-report verbatim.
5. Verified the diff brought in only the expected files (no accidental deletions of
   unrelated `packages/server`/other files that appeared in a naive `git diff main
   P1-land-1.6-crypto-worker` — those were artifacts of comparing against the stale
   `4ed02a4` merge-base, not real changes; `git status` after the merge confirmed only
   the crypto files + `plan.md` + `pnpm-lock.yaml` + two task-summary docs were staged).
6. Completed the merge commit.
7. Ran `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test` from the repo root
   (full Turborepo graph, so `@falcon/crypto` builds before `@falcon/web` per
   `dependsOn: ["^build"]`).

## Verification (post-merge, in worktree)

- `pnpm build` — 5/5 tasks green (full turbo graph, includes `@falcon/web` static
  export).
- `pnpm typecheck` — 6/6 tasks green.
- `pnpm test` — 9/9 tasks green; `@falcon/web` 36/36 tests passing (includes the new
  `client.test.ts`, `client-concurrency.test.ts`, `worker-handler.test.ts` crypto
  suites).
- `git merge-base --is-ancestor P1-land-1.6-crypto-worker HEAD` now succeeds (the
  source branch is an ancestor of this worktree's tip).

## Files brought in by the merge

- `packages/web/src/crypto/{protocol,key-storage,worker-handler,worker,client,factory,index}.ts`
- `packages/web/src/crypto/__tests__/{bytes-scan,client-concurrency.test,client.test,loopback,worker-handler.test}.ts`
- `packages/web/package.json` (`@falcon/crypto: workspace:*` dependency)
- `pnpm-lock.yaml` update
- `task-summary/P1-1.6-crypto-worker.md`, `task-summary/P1-land-1.6-crypto-worker.md`
  (the source tasks' own summaries, carried in as history)

## plan.md change

Flipped line 701 ("Crypto worker (`crypto-bridge`): keys in worker memory from
IndexedDB; seal/open message API") from `[ ]` to `[x]`, with an annotation citing this
task's branch name, the `main` tip merged onto, and the green `pnpm build`/`typecheck`/
`test` verification performed in this worktree.

## Assumptions / scope decisions

- Did not touch `packages/web/src/app/` — wiring `createCryptoBridge()` into the actual
  UI/auth flow remains the separate "Auth pages" bullet (plan.md line 700), unstarted
  and out of scope here.
- Left `progress.md` untouched — cycle-tracking entries are managed by the
  cycle/orchestration process, not by individual land tasks.
- Used `--no-ff` merge (not squash/rebase) to preserve the original branch's
  `feat`/`fix`/`refactor` commit history in `main`'s log, consistent with the other
  `P1-land-*` tasks in this repo.
- Per task instructions, did not merge/push this land branch onto the real `main` —
  the merge exists only as a commit on `P1-land-1.6-crypto-worker-onto-main` in this
  worktree, ready for the orchestrator to fast-forward `main` onto it.
