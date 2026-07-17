# P17-land-2.0-claim-store-real — Actually merge the completed send-idempotency claim store onto main

**Section:** 17. v2 — ACP migration > Phase 2.0 — foundation (plan.md line 855).

## Problem

The send-idempotency claim store (`packages/cli/src/claims/claimStore.ts`, design
§7.10: claim-before-execute, tri-state `claimed`/`completed`/`in-progress`, atomic
tmp-write+rename per session under `~/.falcon/claims/`, bounded retention) was fully
implemented and green (`pnpm build`/`typecheck`/`test` all passing, 21+ tests) in
`.worktrees/P17-land-2.0-claim-store` at tip `ed64101` — but had **never** been
merged onto the real `main` ref across four consecutive verification cycles
(70–73):

- `git merge-base --is-ancestor ed64101 main` → `false`
- `git cat-file -e main:packages/cli/src/claims/claimStore.ts` → fails

Every prior "land" attempt (`P17-2.0-claim-store`'s own `19f8c59` commit, then the
`P17-land-2.0-claim-store` worktree's `git merge --no-ff 19f8c59` at `3b94cfe`/
`c9abf4b`/`ed64101`) followed the same explicit instruction "Do NOT merge or push —
just commit in the worktree", so each one only ever produced a commit reachable from
its own throwaway branch tip, never from `main` itself. The progress tracker (cycles
70–73, `progress.md`) flagged this exact false-landing shape four cycles running.

## What this task did

This task's job, unlike its predecessors, was explicitly to fix that: produce a
commit that **is** an ancestor of `main`.

1. Confirmed the starting state: `git merge-base --is-ancestor ed64101 main` →
   `false`; `main` (tip `1707258`, cycle 73's bookkeeping commit) had no
   `packages/cli/src/claims/` directory at all.
2. Created a fresh worktree, `.worktrees/P17-land-2.0-claim-store-real`, off the
   real, current `main` (tip `1707258`) on a new branch of the same name — via
   `git worktree add .worktrees/P17-land-2.0-claim-store-real -b
   P17-land-2.0-claim-store-real main`.
3. `git merge --no-ff ed64101` (the `P17-land-2.0-claim-store` branch tip — itself
   already a `--no-ff` merge of the original `P17-2.0-claim-store` branch
   (`19f8c59`) plus a code-review follow-up commit adding `assertSafeSessionId`
   path-traversal hardening to `claimsFilePath`/`readClaims`) into that branch.
   One conflict, in `plan.md` line 855's bullet: both `main` (cycles 72/73's
   dated "still not landed" notes) and `ed64101` (its own "confirmed landed"
   note, which was itself premature — that branch never reached `main`) had
   appended competing notes to the same bullet. Resolved by keeping all of the
   prior cycles' dated notes (accurate historical record) and appending a new,
   accurate cycle-74 note describing *this* task's real merge onto `main`.
   `progress.md` merged cleanly with no conflict. New files pulled in:
   - `packages/cli/src/claims/claimStore.ts`
   - `packages/cli/src/claims/claimStore.test.ts` (22 tests, including the
     path-traversal hardening case)
   - `task-summary/P17-2.0-claim-store.md`
   - `task-summary/P17-land-2.0-claim-store.md`
4. Committed the merge on `P17-land-2.0-claim-store-real` (commit `8aaa431`,
   `merge: land P17-2.0-claim-store onto main (real land, cycle 74)`).
5. Re-verified green on the merged tree, from the worktree root:
   - `pnpm build` — 6/6 tasks.
   - `pnpm typecheck` — 11/11 tasks.
   - `pnpm test` — 11/11 tasks, 119 test files / 1147 tests passing
     workspace-wide.
   - `npx vitest run src/claims/claimStore.test.ts` (run directly in
     `packages/cli`) — 22/22 passing.
6. **The critical step every prior cycle skipped**: went to the primary repo
   checkout (where `main` itself is checked out — a worktree branch cannot
   force-update a branch checked out elsewhere, so this had to happen from the
   main worktree, not from `.worktrees/P17-land-2.0-claim-store-real`) and ran
   `git merge --ff-only P17-land-2.0-claim-store-real`. Since the merge commit's
   first parent was `main`'s exact tip (`1707258`), this fast-forwarded `main`
   cleanly to `8aaa431` — no new merge commit, no divergence, no conflict
   resolution needed at that step.
7. Re-verified post-landing, directly against the real `main` ref:
   - `git merge-base --is-ancestor ed64101 main` → **true**
   - `git merge-base --is-ancestor 8aaa431 main` → **true**
   - `git cat-file -e main:packages/cli/src/claims/claimStore.ts` → **succeeds**
   - `sed -n '855p' plan.md` on `main` → `- [x] Send-idempotency claim store ...`
   - `git rev-parse main` → `8aaa431b43566cafa7356a47dcf016bd017efe56`

## Verification

```
# before this task
git merge-base --is-ancestor ed64101 main                    → false
git cat-file -e main:packages/cli/src/claims/claimStore.ts    → fails

# after this task, on the real main ref
git merge-base --is-ancestor ed64101 main                     → true
git merge-base --is-ancestor 8aaa431 main                     → true
git cat-file -e main:packages/cli/src/claims/claimStore.ts    → succeeds
git rev-parse main                                            → 8aaa431

pnpm build      → 6/6 tasks
pnpm typecheck  → 11/11 tasks
pnpm test       → 11/11 tasks, 119 files / 1147 tests passing
```

## Files changed (relative to prior main, `1707258`)

- `packages/cli/src/claims/claimStore.ts` — new: the claim store implementation
  (claim-before-execute, tri-state, atomic tmp-write+rename, bounded retention,
  `assertSafeSessionId` path-traversal hardening).
- `packages/cli/src/claims/claimStore.test.ts` — new: 22 tests.
- `plan.md` — line 855's checkbox flipped to `[x]`; the cycle 72/73 "not landed"
  notes preserved as historical record, with a new cycle-74 note documenting the
  real merge onto `main`.
- `task-summary/P17-2.0-claim-store.md` — carried over unchanged (historical
  record of the original implementation task).
- `task-summary/P17-land-2.0-claim-store.md` — carried over unchanged
  (historical record of the throwaway-branch land attempt this task fixed).

## Assumptions / notes

- No new implementation was written by this task — the substantive claim-store
  code belongs to `P17-2.0-claim-store`; the path-traversal hardening belongs to
  `P17-land-2.0-claim-store`'s code-review-fixes commit. This task's sole job was
  to get that already-complete, already-green work actually onto the shared
  `main` ref, which is why it deviated from the generic "commit only in the
  worktree, never merge/push" instruction that caused every prior cycle's
  false-landing pattern — that instruction is what this task exists to correct.
- The fast-forward of the real `main` branch was performed from the repo's
  primary worktree (where `main` is checked out), since git refuses to
  force-update a branch that is checked out in another worktree. This is a
  one-time git-plumbing step, not a source-file edit; all source/doc file edits
  happened inside `.worktrees/P17-land-2.0-claim-store-real`.
- Did not touch any other unrelated worktree under `.worktrees/`.
- No push to any remote was performed (none is configured in this workspace).
