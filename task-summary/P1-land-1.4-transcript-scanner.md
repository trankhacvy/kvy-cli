# P1-land-1.4-transcript-scanner

Land the `P1-1.4-transcript-scanner` worktree (sessionScanner port) onto `main`.

## What this task was

A landing/merge task, not new implementation. The `packages/cli/src/claude/` code (JSONL
transcript watcher + dedupe + phantom-session guard, plus `startFileWatcher`) was already
built, self-verified, and committed in the isolated worktree `.worktrees/P1-1.4-transcript-scanner`
(commits `c6d5937`, `60f6313`, `07ead60`, based on `main`'s cycle-15 tip `9ff3c4a`). This task
merges that branch onto `main` and flips the corresponding plan.md checkboxes.

## Steps taken

1. Confirmed `main` (cycle-16 tip `4ed02a4`) had made no changes to `packages/cli/` since the
   branch's merge-base (`9ff3c4a`) — `git diff --stat 9ff3c4a main -- packages/cli/` was empty.
   `packages/cli/src/claude/` did not exist on `main` prior to this merge, and the branch only
   touches that new subdirectory plus `packages/cli/package.json` (added deps) and the root
   lockfile — no overlap with `main`'s existing `args.ts`/`home.ts`/`index.ts`/`logger.ts`.
2. Created worktree `.worktrees/P1-land-1.4-transcript-scanner` on a new branch
   `P1-land-1.4-transcript-scanner`, branched from `main`.
3. `git merge --no-edit P1-1.4-transcript-scanner` — merged clean, no conflicts (fast, simple
   3-way merge; `ort` strategy, 8 files changed, all additions).
4. Ran `pnpm install`, then `pnpm build`/`pnpm turbo run typecheck --force`/`pnpm turbo run test --force`
   monorepo-wide (forced, bypassing turbo's cross-worktree shared cache, to get a genuine
   verification in this worktree's checked-out tree). All green:
   - `falcon` (cli): 66/66 tests, including the new `scanner.test.ts` (4) and
     `fileWatcher.test.ts` (4) suites ported with the scanner.
   - `@falcon/crypto`: 65/65, `@falcon/server`: 18/18, `@falcon/wire`: 61/61.
   - `@falcon/web`: builds and typechecks (no test regressions).
5. Updated `plan.md` §1.4 (Phase 1 §1.4 Transcript pipeline): checked off the
   `sessionScanner` port and `startFileWatcher` bullets, and replaced the stale
   "not-yet-landed" cycle-16 note with a landed/verified note. Left the `mapClaudeToEnvelopes`
   mapper and HTTP outbox bullets unchecked — explicitly out of scope for this task, per the
   task description.

## Files touched by the merge (from the source branch, now on this branch)

- `packages/cli/src/claude/types.ts` — envelope/session types for the scanner.
- `packages/cli/src/claude/fileWatcher.ts` (+ `.test.ts`) — `startFileWatcher`: polls for a
  file's existence with a missing-file grace-period timeout and `onGaveUp` callback; disposable.
- `packages/cli/src/claude/scanner.ts` (+ `.test.ts`) — `createSessionScanner`: watches Claude
  JSONL transcript files, dedupes already-seen entries via `processedEntryKeys`, and drops
  ("phantom guard") sessions whose transcript file never materializes so the scanner doesn't
  spin re-watching a dead instance forever; supports reviving a dropped session id via
  `onNewSession(treatExistingAsProcessed)`.
- `packages/cli/package.json` — added the runtime deps the scanner needs (chokidar-equivalent
  file watching / JSONL parsing utilities already selected by the source task).
- `pnpm-lock.yaml` — lockfile updates for the above.

## Files touched by this landing task itself

- `plan.md` — §1.4 checkbox flips + updated status note (see above).
- `task-summary/P1-land-1.4-transcript-scanner.md` — this file.

## Assumptions / notes

- Did not modify any of the ported source files — the task description said this was a
  straight merge of already-complete, already-self-verified work, and verification
  (build/typecheck/test all green in this fresh worktree) confirmed nothing needed fixing.
- Left `mapClaudeToEnvelopes`, the HTTP outbox, `alive` keepalive, and exit-semantics bullets
  in plan.md §1.4 unchecked — they are separate, not-yet-built follow-up work per the task
  description, not part of this land.
- Did not merge this branch into `main` or push anything — per instructions, landing/merging
  onto `main` itself is a separate step outside this worktree task; the commit here only
  captures the merge + plan.md update on the `P1-land-1.4-transcript-scanner` branch.
