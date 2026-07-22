# Known issues

Tracks open issues found during testing/planning — why it's parked and what a real fix
needs. Resolved issues are removed once verified rather than kept as a growing archive;
history for anything previously listed here lives in git (this file's own commit log) and,
for the flows-3/4/5 track, in `docs/plan-flows-3-4-5.md`.

## ~~Flow 3's spawn-dedup guard doesn't survive a daemon restart~~ — RESOLVED

**Status:** fixed in two passes, both merged to `v2-pty-injection`. Full `pnpm build`/
`typecheck` clean; the full `packages/cli` suite passes (the only reds are the pre-existing
`scanner.test.ts`/`transcriptIndexer.test.ts` fs-watch timing flakes, confirmed to reproduce
identically on the unmodified base branch — unrelated to this change).

**Where:** `packages/cli/src/daemon/` — `types.ts` (`TrackedSession.directory`/`.pid`),
`sessionsStore.ts` (`PersistedSession`), `sessionRegistry.ts`, `readoptSessions.ts` (new),
`resumeSession.ts`, `commands.ts`, `machineIntegration.ts`.

**Pass 1 — persistence half:** `FL3.2` ("spawn-directory-dedup") added `TrackedSession.directory`
so the web wizard couldn't spawn two `falcon claude --starting-mode remote` processes in the
same directory (`spawnEngine.ts`'s `scanForLiveSessionInDirectory`, exact-string-equality on
`session.directory === realDirectory`). But that field was **in-memory only**:
`PersistedSession` (`sessions.json`) had no `directory`, so it was never written to disk, and
every session restored after a restart came back with `directory: undefined` and could never
dedup-match again. Fixed by adding `PersistedSession.directory?: string`
(`SESSIONS_SCHEMA_VERSION` 1→2), threading it through `toPersisted()`/`findResumable()`,
widening `trackSpawned(pid, directory?)`, and replacing the `resolveResumeDirectory` stub with
a real `resolveResumeDirectoryFromRecord` (re-`realpath`s the stored directory) — which as a
side effect made `resumeSession` actually functional in production for the first time.

**Pass 2 — boot-time re-adoption, the actual remaining blocker:** Pass 1 alone did NOT fix the
bug end-to-end. `sessionRegistry.ts`'s `restore()` seeds only the durable `resumable` map from
`sessions.json` — it never touches the live `pidToSession` map, and `getSessions()` (what
`scanForLiveSessionInDirectory` scans) returns only `[...pidToSession.values()]`. So after a
daemon restart, a still-running orphaned `falcon claude --starting-mode remote --started-by
daemon` child stayed invisible to spawn-dedup until an explicit `resumeSession` RPC re-tracked
it — and nothing ever triggered that automatically. Resubmitting the web wizard for the same
directory still spawned a genuine duplicate (confirmed live pre-fix: one pid, then a second,
different pid, both alive, same directory). Fixed by:
1. **`sessionsStore.ts`** — added optional `pid?: number` to `PersistedSession` (purely
   additive; `SESSIONS_SCHEMA_VERSION` 2→3, no migration branch, same reasoning as
   `directory`'s v2 bump), with a `typeof` guard in `isPersistedSession`.
2. **`sessionRegistry.ts`** — `toPersisted()`/`findResumable()`'s live branch now also carry
   `pid` through. New `readoptLiveSessions(probe)` method: runs `readoptSessions.ts`'s matcher
   over the restored `resumable` set and inserts every verified-live candidate straight into
   `pidToSession` (carrying `sessionId`/`encryption`/`directory` so dedup, `stopSession`, and
   `findResumable` all see it) — the durable `resumable` entry is deliberately left in place as
   a harmless backstop.
3. **`readoptSessions.ts`** (new, pure/testable) — `findLiveOrphanedSessions()`: for each
   persisted record carrying both a `pid` and a `directory`, checks the pid is still alive in a
   real process scan, that its `ps` command line classifies as a falcon `session`
   (`markers.ts`'s `classifyFalconCommand`) — guarding pid recycling, since liveness alone can't
   tell a reused pid from the real thing — and that its resolved cwd `realpath`-matches the
   persisted directory.
4. **`commands.ts`** — `DaemonCommandDeps` gained injectable `listProcesses`/`resolveProcessCwd`
   (defaulting to `processScan.ts`'s real `ps`/`lsof`-backed implementations).
   `runDaemonStartSync` calls `registry.readoptLiveSessions(...)` right after `restore()`,
   before the control server (and any spawn RPC) starts serving.

**Correction to the original bug write-up carried into this pass:** the write-up assumed boot
re-adoption could just "check whether its pid is still alive," but `PersistedSession` never had
a `pid` field — Pass 1 didn't add one, and `resumeSession` relaunches a **new** process rather
than reconnecting, so no pid was ever persisted to check. This pass added the `pid` field for
exactly this purpose (matching by pid, independently re-verified against `ps` classification +
cwd rather than trusted blindly, over pure cwd-only process discovery).

**Verified:** `pnpm build` + `pnpm typecheck` clean across all packages. New/extended coverage:
`readoptSessions.test.ts` (fake-probe unit cases covering pid-dead, pid-recycled-to-a-non-session,
pid-recycled-to-a-different-falcon-process-kind, cwd-unresolvable, wrong-directory,
realpath-symlink-transparency, deleted/unmounted-directory, and multi-candidate independence —
plus a **real-process black-box** test block that spawns an actual child process with a
falcon-session-shaped argv and runs the matcher against the real `processScan.ts`
`listProcesses`/`resolveProcessCwd`, both for the live and post-kill case, since a fake probe
alone proved the wiring but not genuine `ps`/`lsof` discovery — exactly the gap that let Pass 1
look complete while the bug still reproduced live), `sessionRegistry.test.ts`
(`readoptLiveSessions` re-adds a live orphaned session into the live map post-restart without
dropping the durable backstop, and correctly re-adopts nothing for a dead pid),
`sessionsStore.test.ts` (`pid` round-trip, rejects a non-numeric `pid`, and a `schemaVersion:2`
record with no `pid` key loads as `pid === undefined`). Full `packages/cli` suite: 1533/1535
passing pre-merge (the 2 reds are the pre-existing `transcriptIndexer` fs-watch flakes noted
above, confirmed passing in isolation); independently re-confirmed post-merge with the same
result plus 2 more pre-existing `scanner.test.ts` flakes counted (6 total, all pre-existing).

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
