# Flows (3/4/5) execution progress

Tracks cycles run by the `falcon-dev-loop`-style executor against
`docs/plan-flows-3-4-5.md`. See that file for the authoritative checklist.

## Cycle 1 — 2026-07-21/22

**Merged (ancestry-proven onto `v2-pty-injection`):**

- `FL5.1` "notify-callsite-guard" — `3757c66b57a2ba8c7d1ee44a69223e5c60468704`
- `FL5.2` "acp-headless-attention-wiring" — `528b2a01fcd8b971bd837dd27d86db163b97c07b`

Both verified via `git merge-base --is-ancestor <sha> v2-pty-injection`. Worktrees
`.worktrees/FL5.1` / `.worktrees/FL5.2` and branches `wf/FL5.1` / `wf/FL5.2` removed
after verification.

**Parked this cycle:** none.

**Post-cycle checks on `v2-pty-injection`:**

- `pnpm typecheck` — clean (11/11 tasks successful, full turbo cache hit).

**Next recommended units (in doc order, all real/automatable):**

1. `FL3.1 [bundle] "spawn-fresh-folder-register"` (Piece A)
2. `FL3.2 [bundle] "spawn-directory-dedup"` (Piece B)
3. `FL4.2 [inline] "sharing-crypto-roundtrip-test"`

**Blocked / human-only (not to be picked up by the automated loop):**

- `FL5.3 [human]` — flow-5-live-verify + boundary decision (needs live device testing).
- `FL3.3 [human]` — flow-3-live-verify.
- `FL4.1 [human]` — session-sharing-design-review. **Not checked off** per standing
  instruction; this is a human design-review gate.
- `FL4.3 [solo]` and `FL4.4 [solo]` are explicitly **BLOCKED on FL4.1** in the plan
  doc itself and must not be started (and must never be ticked) until that human
  review lands.

Once `FL3.1`, `FL3.2`, and `FL4.2` are landed, the only remaining unchecked,
non-`[human]` units left in this track will be `FL4.3`/`FL4.4` — and both are
gated on `FL4.1`'s human design review, not on any further automatable work. At
that point this track is effectively blocked on a human step, not on the executor.
