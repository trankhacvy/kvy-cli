# flow3-spawn-dedup-restart-full-fix

## What

Closes the remaining half of "Flow 3's spawn-dedup guard doesn't survive a daemon restart":
boot-time re-adoption of live orphaned sessions.

Branched from `worktree-agent-a762cdc54ca15c830` (commit `812fc36`), which already landed the
*persistence* half (`PersistedSession.directory`, `SESSIONS_SCHEMA_VERSION` 1→2, `toPersisted`/
`findResumable` threading `directory`, `trackSpawned(pid, directory?)`, and
`resolveResumeDirectoryFromRecord`). That half was necessary but not sufficient: `restore()`
(`sessionRegistry.ts`) only ever seeded the durable `resumable` map from `sessions.json`, never
the live `pidToSession` map that `spawnEngine.ts`'s `scanForLiveSessionInDirectory` actually
scans (via `getSessions()`). So a still-running session process a prior daemon spawned — but
this daemon's restart never got a chance to re-track — stayed invisible to spawn-dedup until an
explicit `resumeSession` RPC arrived, and nothing ever triggered that automatically. Resubmitting
the web wizard for the same directory after a daemon restart still spawned a genuine duplicate
process.

## Why (design, and the one correction made to it)

The design (a prior Opus research pass) proposed persisting the session's pid and verifying it
via a real process scan at boot, rejecting the alternative (pure cwd-only process discovery)
because pid-based matching is unambiguous and still independently verified against `ps`
classification + directory, so a recycled pid can't be mistaken for the session.

One correction carried in from the design write-up itself: it originally assumed boot
re-adoption could "check whether its pid is still alive," but `PersistedSession` never had a
`pid` field before this pass — `812fc36` did not add one, and `resumeSession` relaunches a
**brand-new** process rather than reconnecting to the old one, so there was no pid to check.
This pass adds the `pid` field for exactly this purpose.

## Changes

1. **`packages/cli/src/daemon/sessionsStore.ts`** — added optional `pid?: number` to
   `PersistedSession` (purely additive; guarded with a `typeof` check in `isPersistedSession`).
   Bumped `SESSIONS_SCHEMA_VERSION` 2→3 (an honest on-disk marker only — no migration branch,
   same reasoning the v2 comment already used for `directory`).
2. **`packages/cli/src/daemon/sessionRegistry.ts`** — `toPersisted()` and `findResumable()`'s
   live branch now also carry `pid` through (`session.pid`/`live.pid` — `TrackedSession.pid` is
   always set). New `readoptLiveSessions(probe: ReadoptProbeDeps): Promise<number>` method: runs
   `readoptSessions.ts`'s matcher over the restored `resumable` set and, for every verified-live
   candidate, inserts a full `TrackedSession` (carrying `sessionId`/`provider`/`metadata`/
   `encryption`/`directory`) into the live `pidToSession` map. The durable `resumable` entry is
   deliberately left in place afterward (not deleted) — it's the same logical session, just now
   also live-tracked; `findResumable` already prefers the live copy, and `pruneDeadSessions`
   re-graduates it back to resumable-only if the process later dies.
3. **`packages/cli/src/daemon/readoptSessions.ts`** (new) — pure, unit-testable matcher:
   `findLiveOrphanedSessions(persisted, probe)`. Filters persisted records to those with both a
   `pid` and a `directory`, lists live OS processes, and for each candidate: confirms the pid is
   still present, that its `ps` command line classifies as a falcon `session`
   (`markers.ts`'s `classifyFalconCommand`, not merely "alive" — guards pid recycling, since a
   reused pid could be an unrelated process or a *different* falcon session in a different
   directory), resolves its cwd, and `realpath`-canonicalizes both the live cwd and the persisted
   directory before comparing. Any failure at any step (dead pid, wrong process kind, unresolvable
   cwd, mismatched directory, or a `realpath` that throws because the directory no longer exists)
   just excludes that candidate — never throws.
4. **`packages/cli/src/daemon/commands.ts`** — `DaemonCommandDeps` gained injectable
   `listProcesses: () => Promise<ProcessEntry[]>` and
   `resolveProcessCwd: (pid: number) => Promise<string | null>`, defaulted in
   `createDaemonCommandDeps` to `processScan.ts`'s real `ps`/`lsof`-backed implementations.
   `runDaemonStartSync` now calls `registry.readoptLiveSessions({ listProcesses, resolveCwd:
   resolveProcessCwd })` immediately after the existing `restore()` call and before
   `startControlServer`/`startMachineIntegration` — so the live map is fully populated before any
   spawn RPC can possibly be served, matching the existing "restore before serving" ordering
   `commands.ts` already established for `restore()` itself.

No changes were needed to `spawnEngine.ts`, `machineRpc.ts`, or `machineIntegration.ts` — they
already read `getSessions()` and now see the re-adopted sessions for free.

## Assumptions / judgment calls (per the design, followed as given)

- **Persist pid (chosen) over pure cwd-only discovery** — see "Why" above.
- **Pid-recycling safety is mandatory**: `kill(pid, 0)`-style liveness alone is never enough after
  a reboot; the matcher requires both `classifyFalconCommand(...).kind === "session"` AND a
  `realpath`-equal cwd.
- **Classify strictness**: requires `kind === "session"` but *not* `spawnedByDaemon === true` — a
  session started some other way in the exact recorded directory is still legitimately the live
  occupant; tightening to `spawnedByDaemon` is left as a documented future knob if a false match
  is ever observed.
- **Leave the resumable entry in place** on re-adoption, unlike `onSessionStarted` (which deletes
  it because a genuinely new pid supersedes an old one) — here it's the same logical session, and
  keeping it is a harmless durable backstop.
- **Module placement**: the matcher is a new pure `daemon/readoptSessions.ts` (unit-testable
  without a real registry, mirroring `spawnEngine.ts`'s exported `scanForLiveSessionInDirectory`);
  only the map insertion lives in `sessionRegistry.ts`.
- **Real-process integration test is included** (not deferred): `readoptSessions.test.ts` has a
  `describe("findLiveOrphanedSessions (real process discovery)")` block that spawns an actual
  child process with a falcon-session-shaped argv (`falcon claude --starting-mode remote
  --started-by daemon`) in a real temp directory and runs the matcher against the genuine
  `processScan.ts` `listProcesses`/`resolveProcessCwd` (real `ps`/`lsof`), for both the still-live
  and the already-killed case — per the design's explicit "a fake probe proves wiring but not real
  discovery" acceptance gate. A full live-daemon manual repro (spawn via the web wizard, restart
  the daemon, resubmit the same directory) was not additionally performed in this pass; the
  real-process black-box test plus the full unit/registry/store suite were treated as sufficient
  automated coverage of the same gap.

## Deviations from the design

None. The design's file list, interfaces, and implementation shapes (`ReadoptProbeDeps`,
`ReadoptCandidate`, `findLiveOrphanedSessions`, `SessionRegistry.readoptLiveSessions`, the
`commands.ts` wiring point and ordering) were followed as specified; the only correction was the
one the design write-up itself flagged and told this pass to make (no pid field existed yet, so
add one — which this pass did).

## Verification

- `pnpm build` — clean across all packages (wire, crypto, server, web, cli, e2e).
- `pnpm --filter falcon typecheck` — clean.
- `pnpm --filter falcon test` — 1533/1535 passing. The 2 reds are
  `transcriptIndexer.test.ts`'s pre-existing fs-watch timing flakes (confirmed passing in
  isolation, `packages/cli/src/daemon/transcriptIndexer.test.ts` run standalone: 13/13 green) —
  unrelated to this change, which touches nothing on that path.
- New/extended test files: `packages/cli/src/daemon/readoptSessions.test.ts` (new),
  `packages/cli/src/daemon/sessionRegistry.test.ts` (extended),
  `packages/cli/src/daemon/sessionsStore.test.ts` (extended).
- `known-issues.md` updated in place (the existing "Flow 3" entry, which had only documented
  Pass 1, now documents both passes and the correction).

## Files touched

- `packages/cli/src/daemon/sessionsStore.ts`
- `packages/cli/src/daemon/sessionsStore.test.ts`
- `packages/cli/src/daemon/sessionRegistry.ts`
- `packages/cli/src/daemon/sessionRegistry.test.ts`
- `packages/cli/src/daemon/readoptSessions.ts` (new)
- `packages/cli/src/daemon/readoptSessions.test.ts` (new)
- `packages/cli/src/daemon/commands.ts`
- `known-issues.md`
