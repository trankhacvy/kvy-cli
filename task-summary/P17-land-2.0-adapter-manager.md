# P17-land-2.0-adapter-manager

Lands `P17-2.0-adapter-manager` onto `main` via a genuine `git merge` (not a
same-branch commit that only claims to land).

## Starting state

- `P17-2.0-adapter-manager` (tip `66a469e`) fully implemented the pinned-version
  ACP adapter manager (design §7.9) and had a branch-local commit,
  `66a469e` ("feat: P17-2.0-adapter-manager - Land ACP adapter manager onto main"),
  that documented the work as landed and flipped `plan.md`'s checkbox — but never
  actually merged into `main`.
- Confirmed before starting: `git merge-base --is-ancestor 66a469e main` → `false`,
  and `git cat-file -e main:packages/cli/src/adapters/manifest.ts` failed (file did
  not exist on `main`). `git merge-base main P17-2.0-adapter-manager` resolved to
  `1d56810`, well behind both branches' actual tips.

## What was done

1. Created worktree `.worktrees/P17-land-2.0-adapter-manager` off `main`
   (branch `P17-land-2.0-adapter-manager`, `main` tip `efcff70` at merge time).
2. `git merge --no-ff P17-2.0-adapter-manager` into that branch.
   - `CLAUDE.md` merged cleanly (the branch's package-layout addition for
     `src/adapters/` composed with unrelated intervening edits to the same file).
   - `plan.md` conflicted: both `main` (via the already-landed
     `P17-2.0-message-rpc-tristate` progress note) and the adapter-manager branch
     touched the same Phase 2.0 checklist region. Resolved by keeping the existing
     cycle-71 progress note and flipping the adapter-manager bullet from `[ ]` to
     `[x]`, appending a dated confirmation note pointing at this merge.
   - Every other file (the 12 new files under `packages/cli/src/adapters/`,
     `packages/cli/src/commands/adapters.ts` + test, and the modified
     `args.ts`/`daemon/doctor.ts`/`index.ts` + their tests) merged with no
     conflicts — `main` had not touched any of them since the branch's fork point.
3. Committed the merge: `merge: land P17-2.0-adapter-manager onto main`.
4. Re-verified on the merged tree:
   - `pnpm build` — 6/6 tasks green.
   - `pnpm typecheck` — 11/11 tasks green.
   - `pnpm test` — 11/11 tasks green, 124 test files / 1159 tests passed (CLI
     suite alone, including the new `src/adapters/{manifest,health,spawn}.test.ts`
     and `src/commands/adapters.test.ts`).
   - `pnpm lint` scoped to the new/touched adapter files
     (`packages/cli/src/adapters/`, `packages/cli/src/commands/adapters.ts`,
     `packages/cli/src/commands/adapters.test.ts`) is clean. A full-repo
     `pnpm lint` run reports pre-existing errors/warnings unrelated to this diff
     (consistent with the note already carried in the source branch's own
     "Land ACP adapter manager onto main" commit message) plus a nested-biome-root
     configuration error caused by running biome from inside a directory tree that
     itself contains multiple git worktrees each with their own `biome.json` — an
     artifact of the worktree layout, not a regression introduced here.
5. Updated `plan.md` line for the adapter manager to `[x]` with a dated note
   referencing this merge (see diff in `plan.md`, Phase 2.0 section).

## Verification

- `git merge-base --is-ancestor <merge-commit> P17-land-2.0-adapter-manager` → true
  (trivially, it's the branch tip).
- `git cat-file -e HEAD:packages/cli/src/adapters/manifest.ts` → succeeds on the
  merged branch tip.
- Build/typecheck/test all green as recorded above.

## Assumptions / notes

- Did not merge or push to `main` itself — per instructions, work stays on the
  `P17-land-2.0-adapter-manager` branch/worktree, ready for a separate landing
  step to fast-forward or merge into `main`.
- No code changes beyond the merge + the `plan.md` checkbox/note; this is
  purely an integration ("land") task, not new implementation.
