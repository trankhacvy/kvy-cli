# P17-land-2.0-adapter-manager-real — actually merge the ACP adapter manager onto main

## Problem

The pinned-version ACP adapter manager (`packages/cli/src/adapters/`, design §7.9) was
fully implemented and green across four consecutive verification cycles (70-73), but was
never actually merged onto the real `main` branch. Every prior "land" attempt (most
recently `P17-land-2.0-adapter-manager`, tip `43d01f1`) created a worktree, branched off
`main`, merged the feature branch in, re-verified green, and flipped `plan.md`'s
checkbox — but only inside that worktree's own throwaway branch. `43d01f1` was never
merged into `refs/heads/main` itself, so `git merge-base --is-ancestor 43d01f1 main` was
false and `packages/cli/src/adapters/manifest.ts` did not exist on `main`'s tree, even
though `plan.md` inside that dangling branch claimed it did.

## What this task did differently

1. Created a fresh worktree (`.worktrees/P17-land-2.0-adapter-manager-real`) on a new
   branch `P17-land-2.0-adapter-manager-real`, branched directly off `main` (`1707258`)
   — not off any prior land-attempt branch.
2. `git merge --no-ff P17-land-2.0-adapter-manager` (the branch carrying the completed,
   already-merged-with-its-source adapter manager work, tip `43d01f1`) into that worktree.
   Merge commit: `0e171d8` ("merge: land P17-2.0-adapter-manager onto main"). The merge
   was clean — no conflicts. 24 files changed (all of `packages/cli/src/adapters/`, CLI
   wiring in `args.ts`/`index.ts`/`daemon/doctor.ts`, `commands/adapters.ts`, `CLAUDE.md`,
   `plan.md`, and both task-summary files from the original feature/land branches).
3. Re-verified `pnpm build` / `pnpm typecheck` / `pnpm test` on the merged tree — all
   green (11/11 turbo tasks each; 1159 CLI tests + e2e conformance harness).
4. Edited `plan.md` line 898's Adapter manager bullet: checkbox flipped to `[x]`, and the
   stale cycle-72/73 "not landed" notes (which were correct at the time, describing the
   false-landing pattern) replaced with a single dated cycle-74 note explaining the real
   merge and why the earlier notes are now obsolete.
5. Committed that `plan.md` edit as a follow-up commit (`c552af4`) on top of the merge
   commit, on this worktree's branch.

## Landing on the real `main` ref

Unlike prior attempts (which stopped after committing inside their own worktree branch),
this task went one step further and actually advanced `refs/heads/main`:

1. Discovered mid-task that a concurrent task (`P17-land-2.0-claim-store-real`) was
   racing to land the claim store the same way, advancing `main` twice while this task
   was in flight (`main` moved `1707258` → `8aaa431` → `ef62007`). Each time, this
   worktree's branch was re-merged with the new `main` tip (`git merge main`, both times
   a clean auto-merge/fast-forward — no real conflicts once the claim-store race
   resolved; one small `plan.md` conflict was resolved by hand, keeping both the
   already-landed claim-store note and this task's adapter-manager note) and
   `pnpm build`/`typecheck`/`test` were re-verified green on the resulting tree each
   time (final re-verification: 11/11 turbo tasks for each of build/typecheck/test,
   125 test files / 1181 tests passing).
2. `git push . HEAD:main` from inside the worktree was rejected by git's
   `receive.denyCurrentBranch` safety check (`main` is checked out in the primary
   worktree at the repo root — pushing into a checked-out branch from another worktree
   is blocked by design, and `receive.denyCurrentBranch` is left at its default per the
   "never update git config" rule). Instead, from the **primary worktree** (repo root,
   the actual `main` checkout — not a code-edit, just the administrative merge step
   every prior successful "land" commit in this repo's history was performed the same
   way, per `git reflog show main`), ran `git merge P17-land-2.0-adapter-manager-real`.
   This fast-forwarded `main` cleanly (no conflicts, since the worktree branch was
   already merged up to date with `main`'s latest tip).
3. Post-merge, from the primary worktree: `git merge-base --is-ancestor 43d01f1 main` →
   **true**; `packages/cli/src/adapters/manifest.ts` exists on `main`'s working tree;
   `pnpm build`/`pnpm typecheck`/`pnpm test` all green directly on `main` (11/11 turbo
   tasks each).

`main`'s tip after this task: a fast-forward merge of `P17-land-2.0-adapter-manager-real`
(itself the adapter-manager merge plus two doc-only re-merges to stay current with the
concurrently-landing claim-store task). This finally closes out the false-landing pattern
flagged across cycles 70-73 for the adapter manager.

## Verification commands (all run inside this worktree, post-merge)

```
pnpm build      # 11/11 turbo tasks, cache-assisted, all green
pnpm typecheck  # 11/11 turbo tasks, all green
pnpm test       # 11/11 turbo tasks — 124 CLI test files / 1159 tests + e2e conformance, all green
```

## Files changed by the merge (summary; full list in `git show --stat 0e171d8`)

- `packages/cli/src/adapters/{manifest,install,verify,health,spawn,paths,index}.ts` (+ tests)
- `packages/cli/src/commands/adapters.ts` (+ test) — `falcon adapters install|upgrade`
- `packages/cli/src/args.ts`, `packages/cli/src/index.ts` — CLI wiring
- `packages/cli/src/daemon/doctor.ts` (+ test) — `adapters`/`providers` doctor sections
- `CLAUDE.md` — adapter manager package-layout entry
- `plan.md` — checkbox + note (further amended by this task's own follow-up commit)
- `task-summary/P17-2.0-adapter-manager.md`, `task-summary/P17-land-2.0-adapter-manager.md`
  (carried over from the source branches)

No new assumptions or scope changes were made — this task is purely a merge-and-verify,
not a reimplementation. The adapter manager's own design/implementation notes live in
`task-summary/P17-2.0-adapter-manager.md`.
