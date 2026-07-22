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

## Automatic per-session git worktree isolation — deliberately deferred follow-ups

**Where:** `docs/features/worktree-isolation.md` (all 6 phases landed).

**What's open:** four items the feature's own plan flagged as consciously out of scope for
this pass, not bugs:

- **Local `falcon -b <branch>` parity.** `args.ts` still parses `-b`/`--branch` but
  `commands/start.ts` never consumes it — local-mode sessions don't create a worktree at
  all today (only remote `spawn` does, via `gitWorktree.ts`). `index.ts`'s own help text
  advertises the flag, so this is a real CLI/remote parity gap, not just an omission.
  A real fix would call `ensureBranchWorkspace` before launching the local TUI, the same
  way `spawnEngine.ts` does for a remote spawn.
- **No worktree cleanup lifecycle.** Nothing ever runs `git worktree remove` or deletes the
  branch once a session ends — `.worktrees/<branch>` directories (and their branches)
  accumulate forever. The new `.git/info/exclude` entry (Phase 3) only hides them from
  `git status`; it doesn't reclaim disk. This ties to the separate "session lifecycle
  actions" competitive item and should land before the global default (below) flips.
- **`git.branches` is local-only.** The RPC lists `refs/heads` only — no remote-tracking
  branches. Fine for the MVP existing-branch picker (you can only worktree a branch that
  already exists locally on that machine anyway), but worth revisiting if a "check out a
  remote branch" flow is ever wanted.
- **Global default stays `repo-root`.** Settings → Git ships with "Repo root" as the shipped
  default (no silent behavior change), diverging from Omnara's worktree-by-default framing.
  Revisit flipping `git-defaults.ts`'s fallback to `"new-branch"` once the cleanup lifecycle
  above exists — recommending "New worktree" daily without any cleanup story would be a
  worse default, not a better one.

**Status:** all four are scope decisions the feature's plan doc made explicitly, not defects
in what landed — parking them here so the next planner finds them instead of rediscovering
them from scratch.
