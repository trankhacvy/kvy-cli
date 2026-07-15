# P1-land-cli-scaffold — Land the CLI package scaffold and retire the duplicate worktree

## What this task was

An integration/cleanup task, not a new feature. Two sibling worktrees held
independent, complete implementations of the same plan.md §16 "1.3 CLI
skeleton + local mode" bullet — `packages/cli` scaffold (hand-rolled
`parseArgs`, `falcon`/`falcon claude [args...]`/`falcon codex [args...]`
flag passthrough, `~/.falcon` home-dir resolution, file-only logger):

- `P1-1.3-cli-package-scaffold` (branch tip `523da96`, 2 commits) — the
  scaffold plus a code-review-fix pass making the file logger's writes
  best-effort (try/catch around `appendFileSync` so a blocked/read-only
  `~/.falcon/logs` path can't crash the CLI's own `--help`/`--version`
  path), with 2 added regression tests (56 → 58 tests) and a 207-line
  task-summary.
- `P1-1.3-cli-skeleton` (branch tip `77fc254`, 1 commit) — same scope, no
  review-fix pass.

Per plan.md's cycle-9/cycle-10 notes, `P1-1.3-cli-package-scaffold` was
already identified as the more complete of the two. Neither had been
merged into `main`, so plan.md §16 stayed unchecked despite both being
individually done.

## What was done

Worked in `.worktrees/P1-land-cli-scaffold`, branched from `main`'s tip
(`2dcbde4`, "chore: cycle 10 — completed 0 tasks, re-verified main green").

1. Merged `P1-1.3-cli-package-scaffold` into the land branch with
   `git merge --no-ff` — clean, no conflicts (new `packages/cli/**` tree,
   plus `pnpm-lock.yaml` and root `CLAUDE.md` updates already carried by
   that branch's commits).
2. `pnpm install --frozen-lockfile`, then `pnpm build` / `pnpm typecheck` /
   `pnpm test` from the repo root — all green: 8/8 turbo tasks across
   `@falcon/wire`, `@falcon/crypto`, `@falcon/server`, and `falcon` (the new
   `packages/cli`), with the cli package's own 4 test files / 58 tests
   passing (`home.test.ts` 4, `args.test.ts` 41, `logger.test.ts` 8,
   `index.test.ts` 5).
3. Retired the losing duplicate: `git worktree remove
   .worktrees/P1-1.3-cli-skeleton --force` + `git branch -D
   P1-1.3-cli-skeleton`.
4. Also removed the now-merged source worktree/branch
   `P1-1.3-cli-package-scaffold` itself (`git worktree remove --force` +
   `git branch -D`), matching the cleanup precedent set by
   `P0-land-integration-branch` / `P0-merge-pending-worktrees` — its
   content lives on in the merge commit on this branch, so the standalone
   worktree/branch is redundant once landed.
5. Checked off `packages/cli` scaffold: hand-rolled arg parse, `falcon`/
   `falcon claude [args]` with full flag passthrough; file-only logger
   (never stdout)` under plan.md §16 "1.3 CLI skeleton + local mode", and
   replaced the stale cycle-9/10 "still unmerged" note with a short landed
   note recording the merge and verification result.

Root `CLAUDE.md`'s package-layout table already reflects `packages/cli`
(`falcon`) as landed rather than `[planned]` — that update was carried in
by the merged branch itself, so no further edit was needed here.

## Assumptions

- No `.worktrees/P1-land-cli-scaffold` worktree existed yet when this task
  started (only the two source worktrees did); created it fresh with
  `git worktree add -b P1-land-cli-scaffold main` per the standard
  land-task pattern used by prior `P*-land-*` tasks in this repo.
- Did not attempt to salvage anything from `P1-1.3-cli-skeleton` — its
  task-summary and plan.md's own cycle-10 note both agree it's a strict
  subset (same scope, missing the logger review-fix pass), so a clean
  discard is correct rather than a cherry-pick/merge.
