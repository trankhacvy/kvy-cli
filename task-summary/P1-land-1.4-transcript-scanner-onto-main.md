# P1-land-1.4-transcript-scanner-onto-main — Land the P1-land-1.4-transcript-scanner branch onto main

## What this task was

A second-order landing task: `P1-land-1.4-transcript-scanner` (tip `521b743`,
merge-base `4ed02a4`) is the already-prepared integration branch for the
`sessionScanner`/`startFileWatcher` transcript-pipeline port
(`packages/cli/src/claude/{types,fileWatcher,scanner}.ts`). It had test-failure
and code-review fixup commits applied on top of the original
`P1-1.4-transcript-scanner` work and self-reports a green build/typecheck/test
in its own task-summary, but `plan.md` cycles 17 and 18 both confirmed via
`git merge-base --is-ancestor` that it had never actually been fast-forwarded
or merged onto `main` — flagged as the cleanest, lowest-risk close-out
available. This task performs that merge.

## What was done

1. Created worktree `.worktrees/P1-land-1.4-transcript-scanner-onto-main` on a
   new branch of the same name, based on `main`'s current tip `fad6f3e`
   ("chore: cycle 18 — 0 tasks merged, verified main green").
2. Verified `git merge-base main P1-land-1.4-transcript-scanner` = `4ed02a4`
   (the branch's own stated base) and `git merge-base --is-ancestor
   P1-land-1.4-transcript-scanner main` failed (not an ancestor) — confirming
   the unlanded state exactly as described.
3. `git merge --no-ff P1-land-1.4-transcript-scanner`. `packages/cli/src/claude/`
   is a new, disjoint directory (no overlap with `args.ts`/`home.ts`/
   `index.ts`/`logger.ts`) so `pnpm-lock.yaml` and all `packages/cli/src/claude/*`
   files auto-merged cleanly. The only conflict was in `plan.md`'s "1.4
   Transcript pipeline" narrative/checkbox section — both `main` (cycles
   16–18, still-unlanded narrative) and the incoming branch (its own
   landed-and-checked narrative written against a now-stale `main` tip) had
   edited the same lines. Resolved by hand: kept the incoming branch's
   checked boxes (`sessionScanner` / `startFileWatcher` bullets → `[x]`) and
   rewrote the inline note to record the full history (cycle 16 unlanded →
   cycle 17 land-branch-exists-but-unlanded → this task's actual merge onto
   `main`'s `fad6f3e` tip), matching the plan.md convention used by prior
   land-onto-main tasks.
4. Committed the merge (`git commit --no-edit`), producing merge commit
   `458148f` with parents `fad6f3e` (prior `main` tip, first parent) and
   `521b743` (branch tip, second parent).
5. `pnpm install --frozen-lockfile`, then `pnpm build` / `pnpm typecheck` /
   `pnpm test` from the repo root — all green (see Verification).

## Verification

- `pnpm build`: 5/5 turbo tasks (`@falcon/wire`, `@falcon/crypto`,
  `@falcon/server`, `@falcon/web`, `falcon`) — all succeeded, `falcon`/
  `packages/cli` built via `tsc --noEmit` + `pkgroll` with the new
  `src/claude/` module included.
- `pnpm typecheck`: 5/5 packages clean.
- `pnpm test`: 9/9 turbo tasks green. `falcon` package: 66 tests (up from 58
  pre-merge) across `args.test.ts` (41), `home.test.ts` (4), `logger.test.ts`
  (8), `index.test.ts` (5), plus the newly-landed `src/claude/scanner.test.ts`
  (4) and `src/claude/fileWatcher.test.ts` (4). `@falcon/server`: 55 tests.
  `@falcon/crypto`: 65 tests. 0 failures anywhere.
- `packages/cli/src/claude/` is now present on this branch with `types.ts`,
  `fileWatcher.ts`, `scanner.ts` and their test files, confirmed via `find`.

## plan.md changes

`§16` "1.4 Transcript pipeline" — both bullets flipped to checked:
- `[x] sessionScanner port: JSONL watcher, processedEntryKeys dedupe,
  deadSessions phantom guard, onNewSession(treatExistingAsProcessed) (V)`
- `[x] startFileWatcher util with missing-file timeout + onGaveUp (V)`

The remaining 1.4 bullets (`mapClaudeToEnvelopes`, HTTP outbox, `alive`
keepalive, exit semantics) remain unchecked — out of scope for this task,
still open follow-up work per the section's inline note.

## Assumptions

- Per this task's explicit "do not merge or push `main` itself, just commit
  in the worktree" instruction, this task merged `P1-land-1.4-transcript-scanner`
  into a dedicated `P1-land-1.4-transcript-scanner-onto-main` branch/worktree
  built on `main`'s tip, rather than moving `main`'s ref directly. The branch
  is now a clean, fully-verified, fast-forwardable commit ahead of `main`
  (`main` fad6f3e is its first parent) ready for the orchestrating process to
  land.
- Did not re-run `pnpm lint`; task instructions specified build/typecheck/
  test, all of which passed clean.
- Left the source `P1-land-1.4-transcript-scanner` worktree/branch untouched
  (not retired) since retiring stray worktrees was not part of this task's
  scope and the orchestrating process may still want to reference it.
