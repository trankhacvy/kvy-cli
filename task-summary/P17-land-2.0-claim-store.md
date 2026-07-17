# P17-land-2.0-claim-store — Land P17-2.0-claim-store onto main

**Section:** 17. v2 — ACP migration > Phase 2.0 — foundation (plan.md line 855).

## Problem

`P17-2.0-claim-store` (tip `41834e0`) fully implements the send-idempotency claim
store (`packages/cli/src/claims/claimStore.ts`, design §7.10) and passes 21 tests.
That worktree also carried a branch-local commit `19f8c59` titled "Land
send-idempotency claim store onto main" — but that commit never actually reached
`main`: `git merge-base --is-ancestor 19f8c59 main` was `false`, and
`git cat-file -e main:packages/cli/src/claims/claimStore.ts` failed. The "land"
commit only ever touched the throwaway branch's own worktree, matching the same
false-land pattern seen in `P0-land-cross-wire-schema-lint` and
`P17-2.0-message-rpc-tristate` before their real land tasks.

## What this task did

1. Confirmed the starting state before doing anything: `19f8c59` not an ancestor
   of `main`, `packages/cli/src/claims/claimStore.ts` absent from `main`'s tree.
2. Created a fresh worktree, `.worktrees/P17-land-2.0-claim-store`, off current
   `main` (tip `efcff70`) on a new branch of the same name.
3. `git merge --no-ff 19f8c59` into that worktree. The merge applied cleanly with
   no conflicts (`plan.md` auto-merged — the source branch's own commit had
   already flipped line 855's checkbox to `[x]`, and that line doesn't overlap
   with anything touched on `main` since divergence). New files pulled in:
   - `packages/cli/src/claims/claimStore.ts`
   - `packages/cli/src/claims/claimStore.test.ts`
   - `task-summary/P17-2.0-claim-store.md`
4. Re-verified green on the merged tree, from repo root:
   - `pnpm build` — 6/6 tasks (turbo cache hits + fresh builds).
   - `pnpm typecheck` — 11/11 tasks.
   - `pnpm test` — 11/11 tasks, 119 test files / 1146 tests passing workspace-wide.
   - `npx vitest run src/claims/claimStore.test.ts` (run directly in
     `packages/cli`) — 21/21 passing, confirming the task description's claim.
5. Updated `plan.md`: line 855's checkbox was already `[x]` (carried over from the
   merge), so added a dated confirmation note under that bullet documenting this
   land task's verification (mirroring the established pattern used by the
   `P17-2.0-message-rpc-tristate` and `P0-land-cross-wire-schema-lint-final` land
   tasks), and updated the now-stale "claim store, adapter manager remain
   unflipped" aside left by the `message`-RPC bullet's own note, since claim
   store is no longer one of the unflipped ones.
6. Per this task's explicit instructions ("Do NOT merge or push — just commit in
   the worktree"), the merge was committed only in this task's own worktree
   branch (`P17-land-2.0-claim-store`) — it was **not** merged onto the shared
   `main` ref. Landing that branch onto the real `main` is a separate, later step
   (outside this task's scope), same division of labor as every other
   `P*-land-*` task in this repo's history.

## Verification

```
git merge-base --is-ancestor 19f8c59 main            → false (before this task)
git cat-file -e main:packages/cli/src/claims/claimStore.ts → fails (before this task)

# after this task, on branch P17-land-2.0-claim-store:
git merge-base --is-ancestor 19f8c59 HEAD            → true
git cat-file -e HEAD:packages/cli/src/claims/claimStore.ts → exists
pnpm build      → 6/6 tasks
pnpm typecheck  → 11/11 tasks
pnpm test       → 11/11 tasks, 1146 tests passing
```

## Files changed (relative to prior main, `efcff70`)

- `packages/cli/src/claims/claimStore.ts` — new: the claim store implementation
  (claim-before-execute, tri-state, atomic tmp-write+rename, bounded retention).
- `packages/cli/src/claims/claimStore.test.ts` — new: 21 tests.
- `task-summary/P17-2.0-claim-store.md` — carried over unchanged from the merged
  branch (historical record of the original implementation task).
- `plan.md` — line 855's checkbox (already `[x]` from the merge) annotated with a
  dated confirmation note; the adjacent `message`-RPC bullet's stale
  "claim store ... remain unflipped" aside updated to reflect that claim store
  has now landed via this task.

## Assumptions / notes

- No new implementation was written by this task — the substantive claim-store
  code belongs to `P17-2.0-claim-store`; this task's job was purely to get that
  work merged for real (in this task's own worktree/branch, per instructions)
  and prove it with re-verification.
- Did not touch the many other unrelated worktrees under `.worktrees/` — this
  task only concerns the `P17-2.0-claim-store` lineage.
- No push to any remote was performed (none is configured in this workspace by
  default for these worktree-based land tasks).
