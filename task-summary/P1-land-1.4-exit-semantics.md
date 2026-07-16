# P1-land-1.4-exit-semantics — Land exit-semantics classification onto main

## Task

Land the already-implemented, self-verified branch `P1-1.4-exit-semantics` (tip
`835843d`, adds `packages/cli/src/claude/sessionExit.ts`,
`packages/cli/src/api/sessionStatus.ts`,
`packages/server/src/app/routes/sessionStatus.ts`, and the `server.ts`
route-registration touch) onto the shared `main` ref.

## Correction to a prior claim in this worktree

Before this pass, this worktree's `plan.md` and `HEAD` (`1dddaa0`) already claimed the
work was "landed ... directly onto the shared `main` ref from the primary
(non-worktree) checkout." That claim was false. Verified independently with
`/usr/bin/git` (not the `rtk` hook, which this repo's own history documents as
occasionally mangling plain git/shell output):

```
git cat-file -e main:packages/cli/src/claude/sessionExit.ts
  → fatal: path ... exists on disk, but not in 'main'
git cat-file -e main:packages/server/src/app/routes/sessionStatus.ts
  → fatal: path ... exists on disk, but not in 'main'
```

Neither file exists on the real `main` ref. The prior commit's narrative and
checkbox flip were written from inside this worktree branch, which — per this
task's own operating rules ("do NOT merge or push — just commit in the
worktree"; "ALL file edits MUST be in the worktree") — cannot itself move the
shared `main` ref. `plan.md`'s "Exit semantics" bullet has been reverted from
`[x]` back to `[ ]` with a note explaining the correction, matching the pattern
this same file already uses elsewhere (e.g. the `P1-land-1.5-daemon-worktrees-final`
false-claim callout under §1.5).

## What this pass actually did

1. Re-checked drift: `git merge-base --is-ancestor main HEAD` (before this pass)
   returned **false** — `main`'s tip had moved to `fba3ae0` since the branch was
   last touched, via the unrelated `P1-land-1.3-falcon-home-persistence` land
   (adds `packages/cli/src/persistence.ts` + test, `packages/server/src/db/
   testDbAvailable.ts`, `vitest.config.ts`, edits to two unrelated server test
   files, `CLAUDE.md`, and `plan.md`). Confirmed via `git diff 78f22af main
   --stat` — zero overlap with any file this branch touches, other than
   `plan.md`'s shared narrative section.
2. Reconciled with `git merge --no-ff main -m "merge: reconcile
   P1-land-1.4-exit-semantics with main tip fba3ae0 before landing"` — clean,
   one auto-merged file (`plan.md`'s narrative section only; `git grep` for
   conflict markers across the tree returned zero hits post-merge).
3. Re-ran the full workspace build/typecheck/test, forced (no turbo cache) on
   typecheck/test:
   - `pnpm build`: **5/5** tasks green.
   - `pnpm exec turbo run typecheck --force`: **8/8** tasks green.
   - `pnpm exec turbo run test --force`: **9/9** tasks green —
     `@falcon/wire` 61/61, `@falcon/crypto` 65/65, `@falcon/web` 56/56,
     `falcon` (cli) **236/236** (incl. `api/sessionStatus.test.ts`,
     `claude/sessionExit.test.ts`, and the newly-merged-in
     `persistence.test.ts`), `@falcon/server` **145/145** (incl.
     `app/routes/sessionStatus.test.ts`).
4. Independently re-confirmed via the `Read` tool (not just shell output) that
   `packages/cli/src/claude/sessionExit.ts` and
   `packages/server/src/app/routes/sessionStatus.ts` contain real, complete
   implementations, and that `packages/server/src/app/server.ts` imports and
   registers `buildSessionStatusRoutes`.
5. Corrected `plan.md`'s "Exit semantics" bullet (see above) and rewrote this
   task-summary to reflect the true, current state instead of the prior false
   "already landed" claim.

## Current state / what remains

- `git merge-base --is-ancestor main HEAD` → **true** (post-reconciliation).
  This branch (tip after this pass) is a genuine, zero-drift, conflict-free
  fast-forward/merge candidate for `main`'s current tip.
- `git cat-file -e main:packages/cli/src/claude/sessionExit.ts` /
  `main:packages/server/src/app/routes/sessionStatus.ts` still both **fail** —
  the actual fast-forward onto the shared `main` ref has **not** happened as
  part of this task. Per this task's own sandboxing rules, actually moving the
  shared `main` ref (fast-forward or `--no-ff` merge performed from the
  primary, non-worktree checkout) is a follow-up step outside this worktree
  session's write access — the same constraint every other genuine
  `P1-land-*` task in this repo's `plan.md` history has flagged.
- Once that fast-forward happens, `plan.md`'s "Exit semantics" bullet should be
  flipped back to `[x]` with a note pointing at the real merge commit on
  `main` (mirroring the `P1-land-1.5-daemon-worktrees`/`P1-land-1.3-cli-scaffold`
  pattern of correcting a false claim once the real land is verified).

## Assumptions / judgment calls

1. Did not attempt to update the `main` branch ref directly from this worktree
   (e.g. via `git fetch . HEAD:main`) — `main` is checked out in the primary
   (non-worktree) repo directory, and this task's own rules explicitly forbid
   merge/push from a worktree session. Every precedent in this repo's
   `plan.md` history (`P1-land-1.3-claudelocal-spawn`,
   `P1-land-1.5-ensure-daemon-running`, `P1-land-1.5-daemon-worktrees`, etc.)
   follows the same convention: the worktree session reconciles and verifies;
   a separate process with write access to the primary checkout performs the
   actual fast-forward.
2. Used `/usr/bin/git` directly (not bare `git`, which may be intercepted by
   this environment's `rtk` hook) for every fact-verification command in this
   summary, per the pattern this repo's own `plan.md` history has repeatedly
   found necessary.
