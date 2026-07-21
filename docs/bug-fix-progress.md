# Bug-fix loop progress (docs/bug-fix-plan.md track)

Tracks execution progress for `docs/bug-fix-plan.md`'s "Master TODO checklist (execution
units)". Separate from the repo's other `progress.md` (which tracks `plan-v2.md`'s units) —
do not merge the two.

## Cycle 1 — 2026-07-21

**Merged units:**
- `BF0.1` "scanner-hook-gating" — `7cd50565f6376b78e34f46507b622e7b1c35e8bc`
  (verified via `git merge-base --is-ancestor` against `v2-pty-injection`)

**Parked/failed units:** none this cycle.

**Worktree/branch cleanup:** `.worktrees/BF0.1` removed, `wf/BF0.1` branch deleted.

**Next recommended units:**
- `BF1.1 [inline] "core-loop-trivia"` (Phase 1 — CLI-side sync & render correctness)
- Continue Phase 1 sequentially per `docs/bug-fix-plan.md`'s ordering.

## Cycle 2 — 2026-07-21

**Merged units:**
- `BF1.1` "core-loop-trivia" — `4bb5c464bb7ee731f542f90d81b94123935e4a68`
  (verified via `git merge-base --is-ancestor` against `v2-pty-injection`)

**Parked/failed units:** none this cycle.

**Worktree/branch cleanup:** `.worktrees/BF1.1` removed, `wf/BF1.1` branch deleted.

**Next recommended units:**
- `BF1.2 [bundle] "model-switch-render-fix"` (Issue #4, envelopeMapper/modelChange) — a worktree
  (`.worktrees/BF1.2`) and branch (`wf/BF1.2`) already exist in-tree but are not yet merged; pick
  up and finish this next.
- Continue Phase 1 sequentially per `docs/bug-fix-plan.md`'s ordering thereafter.
