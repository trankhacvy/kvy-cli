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

## Cycle 3 — 2026-07-21

**Merged units:**
- `BF1.2` "model-switch-render-fix" — `de676c53ae8613f243cff8b7c7982b720b487252`
  (verified via `git merge-base --is-ancestor` against `v2-pty-injection`)
- `BF1.3` "permission-mode-sync" — `a107aeb5ea3ab3bbfe89843daddaadc8c2f35bc6`
  (verified via `git merge-base --is-ancestor` against `v2-pty-injection`)

**Parked/failed units:** none this cycle.

**Worktree/branch cleanup:** `.worktrees/BF1.2` and `.worktrees/BF1.3` removed, `wf/BF1.2` and
`wf/BF1.3` branches deleted.

**Note:** all non-`[human]` sub-boxes for BF1.2 and BF1.3 flipped to `[x]` in
`docs/bug-fix-plan.md`; the `[human]` live-check sub-boxes remain unchecked per the
false-landing rule.

**Next recommended units:**
- `BF2.1 [bundle] "plan-and-task-cards"` (Issues #6+#7, Phase 2 — web tool-cards & UI polish)
- `BF2.2 [inline] "web-polish-batch"` (three small, disjoint-file web fixes)

## Cycle 4 — 2026-07-21

**Merged units:**
- `BF2.1` "plan-and-task-cards" — `6cdcf69f7aac87b849c60137ce293bcfafe58133`
  (verified via `git merge-base --is-ancestor` against `v2-pty-injection`)
- `BF2.2` "web-polish-batch" — `4c932e66103ca30112284dbabc3771dcdbc547c4`
  (verified via `git merge-base --is-ancestor` against `v2-pty-injection`)

**Parked/failed units:** none this cycle.

**Worktree/branch cleanup:** `.worktrees/BF2.1` and `.worktrees/BF2.2` removed, `wf/BF2.1` and
`wf/BF2.2` branches deleted.

**Note:** all non-`[human]` sub-boxes for BF2.1 and BF2.2 flipped to `[x]` in
`docs/bug-fix-plan.md`; the `[human]` live-check sub-boxes (including BF2.1's Issue #7
fixture-capture precondition) remain unchecked per the false-landing rule.

**Next recommended units:**
- `BF3.1 [bundle] "jwt-expiry-and-reconnect"` (Issues #9+#10, Phase 3 — auth & session robustness)
- `BF3.2 [solo] "recovery-code-restore"` (Issue #12)

## Cycle 5 — 2026-07-21

**Merged units:**
- `BF3.1` "jwt-expiry-and-reconnect" — `3d0d54a72c2464a670731401b2dbf255d2b8e71a`
  (verified via `git merge-base --is-ancestor` against `v2-pty-injection`)

**Parked/failed units:** none this cycle.

**Worktree/branch cleanup:** `.worktrees/BF3.1` removed, `wf/BF3.1` branch deleted.

**Note:** all non-`[human]` sub-boxes for BF3.1 flipped to `[x]` in `docs/bug-fix-plan.md`;
the `[human]` live-check sub-box remains unchecked per the false-landing rule.

**Next recommended units:**
- `BF3.2 [solo] "recovery-code-restore"` (Issue #12)
- Continue Phase 3 sequentially per `docs/bug-fix-plan.md`'s ordering thereafter.

## Cycle 6 — 2026-07-21

**Merged units:** none this cycle.

**Parked/failed units:**
- `BF3.2` "recovery-code-restore" (Issue #12) — failed/parked. Worktree `.worktrees/BF3.2`
  (branch `wf/BF3.2`, tip `368f4a0` "fix: BF3.2 — resolve test issues") left in place for
  human inspection per the false-landing rule; not merged into `v2-pty-injection`.

**Worktree/branch cleanup:** none — no units merged this cycle, so nothing to remove.

**Note:** no `docs/bug-fix-plan.md` checkboxes changed this cycle (no verified merges).

**Next recommended units:**
- Human inspection of `BF3.2` (`.worktrees/BF3.2`) to diagnose and re-attempt Issue #12.
- Continue Phase 3 sequentially per `docs/bug-fix-plan.md`'s ordering thereafter.
