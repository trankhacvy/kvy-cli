# Auth UX Hardening — Progress

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
