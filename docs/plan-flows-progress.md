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

## Cycle 2 — 2026-07-21/22

**Merged (ancestry-proven onto `v2-pty-injection`):**

- `FL3.1 [bundle]` "spawn-fresh-folder-register" — `4487e1f`
- `FL4.2 [inline]` "sharing-crypto-roundtrip-test" — `6426d70cdfd83c74fa5d7cd7ffd7c1a09e5c98d4`

Both verified via `git merge-base --is-ancestor <sha> v2-pty-injection`. Worktrees
`.worktrees/FL3.1` / `.worktrees/FL4.2` and branches `wf/FL3.1` / `wf/FL4.2` removed
after verification.

**Parked this cycle:** none.

**Plan checkboxes flipped in `docs/plan-flows-3-4-5.md`:** `FL3.1`'s unit box and
all non-`[human]` sub-boxes, and `FL4.2`'s unit box and all sub-boxes. `FL3.3
[human]` left unchecked.

**Post-cycle checks on `v2-pty-injection`:** see typecheck result recorded by the
workflow at commit time.

**Next recommended units:**

1. `FL3.2 [bundle] "spawn-directory-dedup"` (Piece B — now unblocked, FL3.1 is in).
2. `FL3.3 [human] "flow-3-live-verify"` — flag to a human once FL3.2 lands too.

**Blocked track note — Flow 4:** `FL4.2` (the only automatable Flow 4 unit) is now
done. Every remaining unchecked, non-`[human]` unit in Phase 2 (`FL4.3`, `FL4.4`)
is gated on `FL4.1 [human] "session-sharing-design-review"`, which requires a
human-authored, human-approved design doc this workflow cannot produce. `FL4.1`,
`FL4.3`, and `FL4.4` remain unchecked and must stay that way until a human
completes and approves that review. **Flow 4 beyond FL4.2 is now blocked purely
on FL4.1's human design review — there is no further automatable work available
on this track.** Continue with Flow 3 (`FL3.2`) or Flow 5 in the meantime.

## Cycle 3 — 2026-07-22

**Merged (ancestry-proven onto `v2-pty-injection`):**

- `FL3.2 [bundle]` "spawn-directory-dedup" — `cfb654119ce8678cc8b7197810f3e42d90f56761`

Verified via `git merge-base --is-ancestor cfb654119ce8678cc8b7197810f3e42d90f56761
v2-pty-injection`. Worktree `.worktrees/FL3.2` and branch `wf/FL3.2` removed after
verification.

**Parked this cycle:** none.

**Plan checkboxes flipped in `docs/plan-flows-3-4-5.md`:** `FL3.2`'s unit box and
all non-`[human]` sub-boxes. `FL3.3 [human]` left unchecked, as required.

**Post-cycle checks on `v2-pty-injection`:** `pnpm typecheck` — see result recorded
at commit time below.

**Status:** every non-`[human]` unit in `docs/plan-flows-3-4-5.md` is now checked
(FL5.1, FL5.2, FL3.1, FL3.2, FL4.2 all `[x]`). The only unchecked boxes remaining
in the whole document are:

- `FL5.3 [human]` "flow-5-live-verify + boundary decision"
- `FL3.3 [human]` "flow-3-live-verify"
- `FL4.1 [human]` "session-sharing-design-review"
- `FL4.3 [solo]` "session-shares-schema-and-authz" — **BLOCKED on FL4.1**
- `FL4.4 [solo]` "session-shares-socket-and-web" — **BLOCKED on FL4.3**

**This entire track is now blocked on human input, not on further automatable
work.** `FL5.3` and `FL3.3` each need a human to live-verify against a real
second machine and a real daemon; `FL4.1` needs a human to author and approve
`docs/design-session-sharing.md` (threat/trust model, `session_shares` schema,
authorization mechanism, and the `rpcHandler.ts` account-keyed-room routing
fix) before `FL4.3`/`FL4.4` can even be attempted. Per standing instructions,
this workflow must never check `FL4.1`, `FL4.3`, or `FL4.4`.

**Next recommended steps (both require a human, not this workflow):**

1. A human live-verifies `FL3.3` and `FL5.3` against a real daemon/second
   machine.
2. A human authors and approves the `FL4.1` design doc, which unblocks
   `FL4.3` for a future automated cycle.

No further automatable units exist in this track until one of the above
human steps lands.
