# Known issues

Tracks open issues found during testing/planning — why it's parked and what a real fix
needs. Resolved issues are removed once verified rather than kept as a growing archive;
history for anything previously listed here lives in git (this file's own commit log) and,
for the flows-3/4/5 track, in `docs/plan-flows-3-4-5.md`.

## Flow 3's spawn-dedup guard doesn't survive a daemon restart — PARTIALLY fixed, live repro still fails

**Status:** a real fix for the *persistence* half landed on worktree branch
`worktree-agent-a762cdc54ca15c830` (off `v2-pty-injection`), commit `812fc36` — not yet merged.
Unit-level verification is clean (`pnpm build`/`typecheck` clean; 39/39 new tests; full
`packages/cli` suite 1511/1517, the only 6 reds being the same pre-existing
`scanner.test.ts`/`transcriptIndexer.test.ts` timing flakes documented elsewhere, confirmed
identical on the base branch). **But a live end-to-end re-test of the ORIGINAL bug repro — spawn
→ restart the daemon → resubmit the wizard for the same directory — still produced a genuine
duplicate process.** The persistence fix is necessary but not sufficient; see the next entry
below for why, which this fix does not close on its own. Do not merge this expecting the
original bug report to be resolved — it isn't yet.

**Where:** `packages/cli/src/daemon/{types.ts,sessionRegistry.ts,sessionsStore.ts}`. Found
during the live-verification pass for `FL3.2` ("spawn-directory-dedup",
`docs/plan-flows-3-4-5.md` `TC-F3-3`) — flagged there as a finding adjacent to that test, not
a failure of the test itself (the dedup guard works fine without a restart in between).

**What's broken:** `TrackedSession.directory` (added by `FL3.2` to prevent the wizard from
spawning two processes in the same folder) is an in-memory-only annotation. It's never
written to `~/.falcon/sessions.json` — `PersistedSession` (`sessionsStore.ts`) has no
`directory` field at all. On daemon restart, `resumeSession` re-tracks a restored session by
calling `trackSpawned(pid, directory)` with `directory` omitted
(`sessionRegistry.ts` doc comment confirms this is deliberate: a resume "isn't establishing a
*new* live-directory fact"), so every session that predates the restart comes back with
`directory: undefined`. The dedup check
(`scanForLiveSessionInDirectory`'s `session.directory === realDirectory` match) can then never
match that session again.

**Reproduced live:** spawned a session in a fresh directory, restarted the daemon (a normal,
expected lifecycle event — not exotic; this project's own self-update/heartbeat logic
restarts the daemon routinely), then resubmitted the wizard for the *same* directory. The
daemon spawned a genuine second `falcon claude --starting-mode remote` process — two live
pids, two tmux sessions, same directory, confirmed via `ps`/`tmux ls`.

**What a real fix needs:** persist `directory` as part of `PersistedSession` in
`sessionsStore.ts` (a schema-version bump, same additive-migration pattern the file's other
fields already follow), and have `resumeSession`'s restore path pass the restored directory
through to `trackSpawned` instead of omitting it. Needs a test proving the dedup guard still
catches a duplicate spawn attempt *after* a simulated daemon restart, not just within one
daemon's lifetime.

**Fix plan, designed (not yet implemented):**
1. Add `directory?: string` to `PersistedSession` (`sessionsStore.ts`) — purely additive; an
   old `sessions.json` with no `directory` key still loads fine as `undefined`.
2. Thread `directory` through `sessionRegistry.ts`'s `toPersisted()` and `findResumable()` so
   every persisted/resumable record carries it.
3. Widen `ResumeSessionRegistry.trackSpawned`'s signature (`resumeSession.ts`) to accept an
   optional `directory`, and pass the resolved directory through at the relaunch call site
   (currently `deps.registry.trackSpawned(launched.pid)` with no second argument).
4. Give `resolveResumeDirectory` (currently a hardcoded `() => undefined` in both
   `daemon/commands.ts` and `daemon/machineIntegration.ts`) a real implementation: re-`realpath`
   the persisted directory, fail the resume cleanly if it no longer exists. This is a bonus —
   resume currently cannot work in production at all without it, since it never has a
   directory to relaunch into; this fix is a strict superset that also makes resume functional.
5. Tests: a `sessionRegistry.test.ts` case that persists → discards in-memory state (simulating
   restart) → restores → re-tracks → proves the dedup scan matches again (not just that a
   field round-trips); a `resumeSession.test.ts` spy-based test proving `trackSpawned` is
   called with the resolved directory; a backward-compat case reading an old file with no
   `directory` key.

The implementation followed the re-resolve-via-`realpath` recommendation: a new shared
`resolveResumeDirectoryFromRecord` (`resumeSession.ts`) re-`realpath`s the persisted directory
(or returns `undefined` if unset/unresolvable, failing the resume cleanly rather than
guessing), and both `commands.ts`/`machineIntegration.ts`'s previously-stubbed
`resolveResumeDirectory: () => undefined` now default to it — which as a side effect makes
`resumeSession` actually functional in production for the first time (it previously could never
resolve a directory to relaunch into at all).

## A still-running session that's never explicitly resumed stays invisible to spawn-dedup after a restart

**This is now confirmed to be the actual blocker on the original bug report, not just a
theoretical adjacent gap.** A live test of commit `812fc36` (the persistence fix above) with a
real daemon restart reproduced this exactly: spawned a session (pid `51245`,
`falcon claude --starting-mode remote`, real `directory` now correctly written to
`sessions.json` as `schemaVersion: 2` — the persistence fix genuinely works), restarted the
daemon, immediately resubmitted the wizard for the same directory — the daemon logged
`"[spawn-engine] launched provider process"` (not the dedup "returning it instead" branch) and
spawned a second, distinct pid (`52292`) with a new `sessionId`. Both processes confirmed alive
simultaneously via `ps`, same directory.

**Where:** `packages/cli/src/daemon/sessionRegistry.ts` (`restore()`, `getSessions()`/
`pidToSession`) and `spawnEngine.ts` (`scanForLiveSessionInDirectory`). Found as a deliberately
out-of-scope gap while designing the fix for the entry above ("Flow 3's spawn-dedup guard
doesn't survive a daemon restart") — that fix closes the resume-then-respawn path, but not
this one.

**What's broken:** on daemon boot, `restore()` only seeds the `resumable` map from
`sessions.json` — it never re-adds anything to `pidToSession`, the live map
`scanForLiveSessionInDirectory`/`getSessions()` actually scans. A session whose process is
still genuinely running (a detached child that outlived the restart) only re-enters the live
map once something explicitly calls `resumeSession` for it. Until then, the dedup guard has no
idea that session — or its directory — exists, even though the process is real and live.

**Consequence:** after a daemon restart, submitting the wizard for a directory that already
has a still-running (but never-resumed) session in it will spawn a genuine duplicate process,
even once the entry above is fixed — that fix only protects sessions that get resumed before
someone resubmits the wizard for the same folder.

**What a real fix needs:** a "re-adopt live orphaned children on boot" mechanism — e.g. on
daemon start, for each `resumable` entry, check whether its pid is still alive (and actually
the right process, not a recycled pid) and if so re-add it to `pidToSession` directly, without
waiting for an explicit resume. Confirmed in code exactly why nothing does this today:
`restore()` (`sessionRegistry.ts:123-126`) only calls `resumable.set(id, session)` — it never
touches `pidToSession`, and `resumeSession()` is only ever invoked from one place,
`machineRpc.ts:317`, an explicit client-triggered RPC — there is no boot-time path that calls
it automatically. This is genuinely new scope (process-liveness verification + pid-recycling
safety, not just wiring an existing field through) — not a small addition to the fix above, and
deliberately not bundled with it.

**Status:** open, confirmed via live daemon-restart test as the actual remaining blocker on the
original bug report; not yet designed in detail.

## `falcon resume` (CLI command) ignores the persisted session directory

**Where:** `packages/cli/src/commands/resume.ts:169`. Found while live-testing the
spawn-dedup-restart fix above (a "bonus check" on whether `resolveResumeDirectoryFromRecord`
actually helps `falcon resume`).

**What's broken:** the RPC-triggered resume path (`daemon/commands.ts`,
`daemon/machineIntegration.ts`) now correctly defaults `resolveResumeDirectory` to
`resolveResumeDirectoryFromRecord`, which re-resolves the session's persisted directory. But
the separate CLI command `falcon resume <id>` hardcodes its own
`resolveDirectory: () => deps.workingDirectory` — the CLI invocation's *own* current directory,
not the session's original one. A real test run of `falcon resume` from an arbitrary directory
relaunched the session rooted in that arbitrary directory instead of where it actually started.

**What a real fix needs:** thread the same `resolveResumeDirectoryFromRecord` (or an equivalent
lookup against the session's persisted `directory`) into `commands/resume.ts`'s own dependency
wiring, so both entry points (RPC-triggered and CLI-triggered resume) agree on where a session
resumes.

**Status:** open, not yet fixed. Pre-existing, unrelated to the spawn-dedup fix itself — just
surfaced by testing near it.

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
