# P1-land-1.6-crypto-worker — Land the web crypto-worker worktree onto main

**Section:** Phase 1 §1.6 Web app v1 (read-only)

## What this task did

Merged the `P1-1.6-crypto-worker` branch/worktree (built on `main`'s cycle-15 tip,
`9ff3c4a`) into `main` (which had advanced to cycle-16 tip, `4ed02a4`, with no
`packages/web` changes in between — confirmed via `git diff --stat 9ff3c4a main --
packages/web` returning empty). This is a pure landing task; no new implementation
code was written — the crypto-worker code itself was built and self-verified in the
prior `P1-1.6-crypto-worker` task.

## Steps taken

1. Confirmed the worktree at `.worktrees/P1-land-1.6-crypto-worker` didn't exist yet;
   created it fresh off `main` on a new branch `P1-land-1.6-crypto-worker`
   (`git worktree add .worktrees/P1-land-1.6-crypto-worker -b P1-land-1.6-crypto-worker main`).
2. Verified `P1-1.6-crypto-worker` made no changes to `plan.md` or `progress.md`
   relative to its own merge-base (`git diff 9ff3c4a P1-1.6-crypto-worker --
   plan.md progress.md` — empty), so the doc drift visible in
   `git diff main P1-1.6-crypto-worker -- plan.md progress.md` was purely main having
   moved forward (cycle 16 verification notes), not a real conflict.
3. `git merge --no-ff P1-1.6-crypto-worker` — clean merge, no conflicts. Brings in:
   - `packages/web/src/crypto/{protocol,key-storage,worker-handler,worker,client,factory,index}.ts`
   - `packages/web/src/crypto/__tests__/{bytes-scan,client-concurrency.test,client.test,loopback,worker-handler.test}.ts`
   - `packages/web/package.json` (`@falcon/crypto: workspace:*` dependency added)
   - `pnpm-lock.yaml` update
   - `task-summary/P1-1.6-crypto-worker.md` (the original task's own summary)
4. `pnpm install` — clean.
5. `pnpm build` (root, full turbo graph so `@falcon/crypto` builds before `@falcon/web`
   per `dependsOn: ["^build"]`) — 5/5 tasks green, `@falcon/web` static export
   succeeds. (Note: running `pnpm --filter @falcon/web build` directly, bypassing the
   turbo dependency graph, fails with `Cannot find module '@falcon/crypto/web'` since
   `@falcon/crypto` hasn't been built into its `dist/` yet — always use the root
   `pnpm build` / `pnpm typecheck` / `pnpm test` scripts, which resolve the graph.)
6. `pnpm typecheck` — 6/6 tasks green.
7. `pnpm test` — 9/9 tasks green; `@falcon/web` 36/36 tests (26 pre-existing +
   `client-concurrency.test.ts`'s 8 plus the crypto suite already counted in the
   26 — full package total is 36, up from the pre-merge scaffold's 14).
8. Flipped the `plan.md` §16 (§1.6) "Crypto worker" bullet from `[ ]` to `[x]`,
   replacing the stale "not yet merged, worktree-only" annotation with a landed/
   verified-on-main note.

## Verification (on `main`, post-merge)

- `pnpm build` — 5/5 tasks green (full turbo graph).
- `pnpm typecheck` — 6/6 tasks green.
- `pnpm test` — 9/9 tasks green, `@falcon/web` 36/36.
- Merge was a clean 3-way merge (`git merge --no-ff`), no conflicts, no manual
  conflict resolution needed.

## Assumptions / scope decisions

- Did not touch `packages/web/src/app/` — wiring `createCryptoBridge()` into actual
  UI/auth flow is the separate "Auth pages" bullet (plan.md line 700), out of scope
  here.
- Left `progress.md` untouched by this task (beyond what the merge itself carried,
  which was nothing — the source branch never modified it); cycle-tracking entries
  are managed by the cycle/orchestration process, not by individual land tasks.
- Used `--no-ff` merge (not squash/rebase) to preserve the original branch's commit
  history (`feat` → `fix` → `refactor` progression) in `main`'s log, consistent with
  how the other `P1-land-*` tasks in this repo's history operate.
