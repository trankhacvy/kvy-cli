# Auth UX Hardening — Progress

## Cycle 6

**Merged units (ancestry-proven on `v2-pty-injection`):**
- AH10 "pin-copy-this-browser-only" — `9b13e34366f653e5e2ceed6c9e8beac644156d64`
- AH11 "known-issues-cleanup" — `628240e538aa0ed54e1a0388127a4c7d9407096a`
- AH12 "password-signin-pending-pair" — `6fa8b11a4c98a805eff9462d26fb503162594112`

All three verified via `git merge-base --is-ancestor <sha> v2-pty-injection`. Non-`[human]`
sub-boxes (none of these units have any) and the unit boxes flipped to `[x]` for AH10, AH11,
AH12 in `docs/auth-ux-hardening-plan.md`. Worktrees `.worktrees/AH10`, `.worktrees/AH11`,
`.worktrees/AH12` and branches `wf/AH10`, `wf/AH11`, `wf/AH12` removed post-merge-verification.

**Parked units this cycle:** none.

**`pnpm typecheck` on `v2-pty-injection`:** passed (11/11 tasks successful, full turbo;
`@falcon/web:build` ran clean, `@falcon/web:typecheck` was a cache hit).

**Sequencing gates re-confirmed:** AH11 required AH1 merged+verified — AH1 was already
`[x]` before ticking AH11. AH2-before-AH3 gate not implicated this cycle (both already
checked in an earlier cycle).

**Cumulative status:** every `AH*` unit box in the Master TODO checklist is now `[x]`
(non-`[human]` sub-boxes). Only `[human]` live-verification sub-boxes remain unticked
across AH1–AH12.

**Next recommended units:** none remain unchecked/available in the Master TODO checklist —
all AH units are merged and ticked. Remaining work is limited to the `[human]` live-check
sub-boxes (e.g. AH2's live Google/GitHub OAuth round-trip), which require a human to
execute and are out of scope for automated ticking. If new AH units are added to the plan,
resume from there.

## Cycle 5

**Merged units (ancestry-proven on `v2-pty-injection`):**
- AH7 "session-expiry-reason" — `60898bc4ac8cecf76c276739fd8b70a1d994df24`
- AH8 "machine-status-reauth" — `85c6681515ebb567adf69b03935c68826f3848a6`
- AH9 "remove-leaked-doc-strings" — `efb76ce5a60f5078efe82889f5bc9ea130b9cf5a`

All three verified via `git merge-base --is-ancestor <sha> v2-pty-injection`. Non-`[human]`
sub-boxes (none of these units have any) and the unit boxes flipped to `[x]` for AH7, AH8,
AH9 in `docs/auth-ux-hardening-plan.md`. Worktrees `.worktrees/AH7`, `.worktrees/AH8`,
`.worktrees/AH9` and branches `wf/AH7`, `wf/AH8`, `wf/AH9` removed post-merge-verification.

**Parked units this cycle:** none.

**`pnpm typecheck` on `v2-pty-injection`:** passed (11/11 tasks successful, full turbo).

**Cumulative status:** AH1, AH2, AH3, AH6, AH7, AH8, AH9 verified-merged. AH10, AH11 open.

**Next recommended units (respecting sequencing gates):**
1. AH10 `[inline]` "pin-copy-this-browser-only" — independent, no gate; small copy-only change.
2. AH11 `[inline]` "known-issues-cleanup" — unblocked (AH1 merged+verified); note a stale
   `wf/AH11` branch may already exist locally from a prior attempt — inspect before restarting.

No unit remains blocked on the AH2-before-AH3 gate (both merged) or the AH1-before-AH11 gate
(AH1 merged) — those sequencing constraints are already satisfied.

## Cycle 4

**Merged units (ancestry-proven on `v2-pty-injection`):**
- AH3 "gate-password-prod" — `9f7ebb0be120b2de31c13c01dfa4ef4973a07ccb`

Verified via `git merge-base --is-ancestor 9f7ebb0be120b2de31c13c01dfa4ef4973a07ccb
v2-pty-injection`. Non-`[human]` sub-boxes flipped to `[x]` for AH3 in
`docs/auth-ux-hardening-plan.md` (AH3 has no `[human]` sub-box). Sequencing gate
re-confirmed: AH2 was already checked before AH3 was ticked. Worktree
`.worktrees/AH3` and branch `wf/AH3` removed post-merge-verification.

**Parked units this cycle:** none.

**`pnpm typecheck` on `v2-pty-injection`:** passed (11/11 tasks successful, full turbo).

**Next recommended units (respecting sequencing gates):**
1. AH8 `[bundle]` "machine-status-reauth" — independent of AH1-AH7 (a worktree/branch
   already exists from a prior attempt at `.worktrees/AH8` / `wf/AH8`; inspect before
   restarting).
2. AH11 `[inline]` "known-issues-cleanup" — now unblocked (AH1 is merged+verified);
   note branch `wf/AH11` already exists locally (no `.worktrees/AH11` dir seen) —
   inspect before restarting.

AH9 also remains independently eligible; a stale worktree/branch already exists at
`.worktrees/AH9` / `wf/AH9` — inspect before restarting.

## Cycle 3

**Merged units (ancestry-proven on `v2-pty-injection`):** none this cycle.

**Parked units this cycle:** none.

No units landed this cycle — nothing to verify with `git merge-base --is-ancestor`,
no worktrees/branches to remove, and no checkboxes flipped in
`docs/auth-ux-hardening-plan.md`.

Note: stale in-progress worktrees/branches exist from prior attempts and were left
untouched (not this cycle's MERGED/FAILED lists, so out of scope for cleanup here):
`.worktrees/AH3` (`wf/AH3`), `.worktrees/AH8` (`wf/AH8`), `.worktrees/AH9` (`wf/AH9`).

**`pnpm typecheck` on `v2-pty-injection`:** see result below.

**Next recommended units (respecting sequencing gates):**
1. AH8 `[bundle]` "machine-status-reauth" — independent of AH1-AH7 (a worktree/branch
   already exists from a prior attempt at `.worktrees/AH8` / `wf/AH8`; inspect before
   restarting).
2. AH9 — independent (a worktree/branch already exists at `.worktrees/AH9` / `wf/AH9`;
   inspect before restarting).

AH3 remains eligible (gated on AH2, already merged) but has a stale in-progress
worktree/branch (`.worktrees/AH3` / `wf/AH3`) that should be inspected/resolved before
restarting.

## Cycle 2

**Merged units (ancestry-proven on `v2-pty-injection`):**
- AH5 "devices-revoke-confirm" — `51aafa82ef17d8c33c9d87ab7046d1c8555da545`
- AH6 "capture-oauth-email" — `80a9ff2db81a47e03c8d2c37a8594dec1dd11afe`

Both verified via `git merge-base --is-ancestor <sha> v2-pty-injection`. Non-`[human]`
sub-boxes for both units flipped to `[x]` in `docs/auth-ux-hardening-plan.md` (neither
unit has a `[human]` sub-box). Worktrees `.worktrees/AH5`, `.worktrees/AH6` and branches
`wf/AH5`, `wf/AH6` removed post-merge-verification.

**Parked units this cycle:** none.

**`pnpm typecheck` on `v2-pty-injection`:** passed (11/11 tasks successful, full turbo).

**Next recommended units (respecting sequencing gates):**
1. AH7 `[inline]` "session-expiry-reason" — independent, no gate.
2. AH8 `[bundle]` "machine-status-reauth" — independent of AH1-AH7.

AH3 (gated on AH2, already merged) and AH11 (gated on AH1, already merged) remain
eligible too; note a stale `.worktrees/AH3` / `wf/AH3` worktree already exists from a
prior attempt and should be inspected before restarting that unit.

## Cycle 1

**Merged units (ancestry-proven on `v2-pty-injection`):**
- AH1 "pair-silent-refresh" — `64eb15a6baa422af63d75b6310a9acf6321d21bb`
- AH2 "oauth-stepup-reset-keys" — `ae2c22c3d561d59821f27fa274d830604e25997a`

Non-`[human]` sub-boxes for both units flipped to `[x]` in
`docs/auth-ux-hardening-plan.md`. AH2's `[human]` live-Google/GitHub-round-trip
box intentionally left unchecked. Worktrees `.worktrees/AH1`, `.worktrees/AH2`
and branches `wf/AH1`, `wf/AH2` removed post-merge-verification.

**Parked units this cycle:** none.

**`pnpm typecheck` on `v2-pty-injection`:** passed (11/11 tasks successful, full turbo cache hit).

**Next recommended units (respecting sequencing gates):**
1. AH3 `[solo]` "gate-password-prod" — now unblocked (AH2 is merged+verified).
2. AH11 `[inline]` "known-issues-cleanup" — now unblocked (AH1 is merged+verified).

Both AH3 and AH11 can be picked up next cycle; AH3 also depends on human
verification maturity for AH2's OAuth step-up (though the plan only gates it on
"AH2 merged+verified", not on the `[human]` box, per plan wording).
