# Known issues

Tracks open issues found during testing/planning — why it's parked and what a real fix
needs. Resolved issues are removed once verified rather than kept as a growing archive;
history for anything previously listed here lives in git (this file's own commit log) and,
for the flows-3/4/5 track, in `docs/plan-flows-3-4-5.md`.

## Flow 4 ("pair with a teammate") is blocked on a human design review — `FL4.1`

**Where:** `docs/plan-flows-3-4-5.md`, execution unit `FL4.1`
("session-sharing-design-review"), Phase 2.

**What's open:** Flow 4 — letting a genuinely different person view/approve your session
from their own account/device — is not implemented and, more importantly, not yet
*designed*. There's no schema, no authorization model, and no invite flow decided for it.
The two implementation units that would build it (`FL4.3` schema/authz, `FL4.4`
socket/web UI) are explicitly blocked on `FL4.1` and must not start until it's done.

**What a real fix needs:** a written design doc (recommended path:
`docs/design-session-sharing.md`) that settles, at minimum:

- Threat/trust model for a second identity accessing someone else's session.
- The sharing schema (a `session_shares`-style table — per-session vs per-workspace scope,
  what roles exist: view-only vs. can-approve).
- The authorization-helper mechanism that replaces the ~15 existing
  `eq(sessions.accountId, accountId)` checks server-side.
- The RPC-routing fix for `packages/server/src/app/socket/rpcHandler.ts` — its rooms are
  keyed by the *caller's* account today, so a teammate's `perm.answer`/`message`/interrupt
  calls would silently resolve to nothing without this.
- The invite/handshake flow (how the owner learns a teammate's `contentPubKey`).
- Revocation semantics, including the honest fact that a key already delivered to a
  teammate's device can't be un-taught by revoking server-side access alone.

One piece is already de-risked and needs no new design: the crypto primitive
(`wrapDek`/`unwrapDek` in `packages/crypto/src/dek.ts`) already supports wrapping a
session's DEK to any content public key, not just the owner's — confirmed by a real
round-trip test (`FL4.2`, already landed).

**Status:** open, waiting on a human-authored and human-approved design doc. Not something
an automated workflow can produce or check off.
