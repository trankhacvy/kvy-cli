# P0-land-cross-wire-schema-lint-final — Land the verified P0-land-cross-wire-schema-lint integration branch onto main

**Section:** Cross-cutting — Wire-schema additive-only lint (plan.md §16 Cross-cutting, line 810).

## Problem

`P0-land-cross-wire-schema-lint` (tip `003a75c`) already did the real work: it
`--no-ff` merged `P0-cross-wire-schema-lint` and additionally fixed a genuine CI
gap (added `tsx` as a workspace devDependency in `packages/wire/package.json`
instead of relying on a global npm install for `lint:additive`). Its own
task-summary claimed "Landed the ... branch onto `main`" — but that was false.
Independent ancestry checks across Cycles 24-25 repeatedly confirmed
`git merge-base --is-ancestor P0-land-cross-wire-schema-lint main` returned
`false`, and `packages/wire/scripts/check-additive-vs-base.ts` was absent from
`main`'s working tree. The merge had only ever touched the throwaway branch's
own worktree — it never touched the shared `main` ref.

## What this task did

1. Created a fresh worktree, `.worktrees/P0-land-cross-wire-schema-lint-final`,
   off current `main` (tip `10c73ef`, cycle 25) on a new branch of the same name.
2. `git merge --no-ff P0-land-cross-wire-schema-lint` into that worktree.
   One conflict, in `plan.md`'s Cross-cutting annotation block (both sides had
   appended narrative commentary to the same paragraph) — resolved by writing
   a single up-to-date annotation describing the actual landing, and checking
   `- [x] Wire-schema additive-only lint in CI (runs from Phase 0 onward)`.
   `pnpm-lock.yaml` merged cleanly with no conflict (both branches only added
   the `tsx` entry in the same place).
3. Re-verified green in the merged worktree before touching `main`:
   - `pnpm build` — 5/5 tasks (turbo cache hits + fresh `@falcon/web` `next build`).
   - `pnpm typecheck` — 6/6 tasks.
   - `pnpm test` — 9/9 tasks, including `@falcon/server` 87/87 and
     `@falcon/wire` 61/61 (vitest run directly in `packages/wire`).
   - `pnpm --filter @falcon/wire run lint:additive` — ran the new
     `check-additive-vs-base.ts` script directly: `OK — @falcon/wire is
     additive-only vs main (36 schema(s) checked)`.
4. **The actual landing step** (where prior attempts silently stopped):
   switched to the primary repo working copy (checked out on `main`, no
   worktree needed there since it's the shared ref) and ran
   `git merge --no-ff P0-land-cross-wire-schema-lint-final` directly on
   `main`. This is the same pattern used by prior successful `P0-land-*`
   commits in history (e.g. `13216c1`, `21f4724`) — an explicit two-parent
   merge commit recording the land event, rather than a silent fast-forward.
   The merge applied cleanly (no conflicts — identical to the already-resolved
   tree from step 2).
5. Re-ran `pnpm build` and `pnpm typecheck` from repo root on `main` post-merge
   to confirm the landed state is still green (both full-turbo cache hits,
   6/6 and 5/5 tasks respectively — consistent with the worktree verification
   since the trees are identical).

## Verification that main actually moved this time

```
git merge-base --is-ancestor P0-land-cross-wire-schema-lint main   → true
git cat-file -e main:packages/wire/scripts/check-additive-vs-base.ts → exists
git show main:packages/wire/package.json | grep tsx                → "tsx": "^4.20.0"
git rev-parse main                                                  → 0226396...
```

`main`'s tip is now the merge commit
`feat: P0-land-cross-wire-schema-lint-final - Land the verified
P0-land-cross-wire-schema-lint integration branch onto main`, with parents
`10c73ef` (prior main) and `2ef444f` (this task's worktree merge tip).

## Files changed (relative to prior main, `10c73ef`)

- `.github/workflows/ci.yml` — two new steps: fetch base branch on PR events,
  run `pnpm --filter @falcon/wire run lint:additive` on PR events.
- `.gitignore` — ignore entries from the lint tooling.
- `packages/wire/package.json` — added `tsx` as a devDependency; added the
  `lint:additive` script.
- `packages/wire/scripts/check-additive-vs-base.ts` — new CI lint: resolves
  the PR base ref, re-derives the pre-change wire schemas via `git archive`
  extraction of that ref's `packages/wire/src`, and re-runs the existing
  `isCompatible`/`describeShape` logic against them. Closes the hole where a
  commit that both breaks a schema and regenerates the frozen fixture in the
  same commit previously passed `additiveOnly.test.ts` cleanly.
- `pnpm-lock.yaml` — lockfile entry for `tsx` in `@falcon/wire`.
- `plan.md` — Cross-cutting bullet checked off; annotation rewritten to
  describe the actual landing (this task), replacing the stale
  "not an ancestor" narrative from Cycles 24-25.
- `task-summary/P0-cross-wire-schema-lint.md`, `task-summary/P0-land-cross-wire-schema-lint.md`
  — carried over unchanged from the merged branches (historical record).

## Assumptions / notes

- No new code was written by this task beyond conflict resolution in
  `plan.md` — the substantive lint implementation belongs to
  `P0-cross-wire-schema-lint` and the `tsx` fix belongs to
  `P0-land-cross-wire-schema-lint`; this task's job was purely to get both
  onto `main` for real, plus prove it with re-verification.
- Per the task instructions, only the worktree was used for authoring/editing
  files; the merge onto `main` was a plumbing `git merge` operation (no file
  edits), run from the already-clean, already-committed worktree tip.
- Did not touch or resolve anything in the many other unrelated worktrees
  listed under `.worktrees/` — this task only concerns the
  `P0-cross-wire-schema-lint` lineage.
