# FL3.2 — spawn-directory-dedup

Implements plan.md §16 / `docs/plan-flows-3-4-5.md`'s "Flow 3 — Kick something off
remotely", **Piece B** (dedup). Piece A (register-workspace, the `unknown-workspace`
fresh-folder fix) already landed as FL3.1 — confirmed via `git log v2-pty-injection..HEAD`
before starting; this unit only had to build the dedup guard on top of it, not redo it.

No prior commits existed for FL3.2 itself (only FL3.1's, already merged into this branch),
so this was a from-scratch implementation, not a gap-fill.

## What changed, sub-task by sub-task

**1. `TrackedSession.directory` (`packages/cli/src/daemon/types.ts`).** Added an optional
`directory?: string` field — the resolved real (symlink-followed) directory a daemon-spawned
pid is running in. `sessionRegistry.ts`'s `trackSpawned(pid, directory?)` now accepts and
stores it; `onSessionStarted`'s existing `{ ...existing, sessionId, metadata, encryption }`
merge already carries it through untouched once the webhook lands (no separate change needed
there — the spread was already generic).

**2. `findLiveSessionInDirectory` seam + dedup check (`packages/cli/src/daemon/
spawnEngine.ts`).** `SpawnEngineDeps` gained two new optional deps:
- `findLiveSessionInDirectory?: (realDirectory) => string | null | undefined` — consulted in
  `spawnSession` right after workspace validation resolves `realDirectory`, **before** any
  branch/worktree resolution or launch attempt. A match short-circuits to
  `{ sessionId: existingSessionId }` without ever calling the launcher.
- `trackSpawned?: (pid, directory) => void` — called right after a successful launch with
  `launched.pid` and `spawnDirectory` (mirrors `resumeSession.ts`'s own
  `registry.trackSpawned(launched.pid)` call after its relaunch).

Also exported `scanForLiveSessionInDirectory(sessions: TrackedSession[], realDirectory):
string | null` — the real default implementation's core logic, standalone and unit-testable.
It only matches a `TrackedSession` that already has a `sessionId` (i.e. the `/session-started`
webhook has landed) — a pid tracked pre-webhook can't be dedup'd against, since the next
spawn would just race it.

No `@falcon/wire` change was needed: `SpawnResult.sessionId` already carries the existing
session's id, exactly as the plan's proposed fix notes ("needs **no** wire-schema change").

**3. Wiring through `machineIntegration.ts` (`spawnSessionHandler`, ~line 299-306 in the
drifted current file — the plan cited "295 to 302", pre-FL3.1-merge line numbers).**
`MachineIntegrationDeps.registry`'s type was widened from `ResumeSessionRegistry` to
`ResumeSessionRegistry & { getSessions(): TrackedSession[] }` — the *real* registry
(`sessionRegistry.ts`'s `createSessionRegistry`) already implements `getSessions()`, so this
is a type-only widening, not a behavior change; `commands.ts`'s composition and
`machineIntegration.test.ts`'s `{} as never` registry fake both needed no changes.
`spawnSessionHandler` now passes:
```ts
findLiveSessionInDirectory: (realDirectory) =>
  scanForLiveSessionInDirectory(deps.registry.getSessions(), realDirectory),
trackSpawned: deps.registry.trackSpawned,
```
ahead of `...deps.spawnEngineOverrides` (so tests can still override cleanly).

**4. Client-side pre-check (optional, scoped down).** The plan's own citation
(`packages/wire/src/rpc.ts:86`'s `LocalSessionInfoSchema.workspaceId`) points at machinery
that doesn't exist end-to-end yet: the `list`/`ListSessionsResult` machine RPC is defined in
`@falcon/wire` but was never registered as a daemon machine-RPC handler, and web's
`sync/machineRpc.ts` has no `list` method either — wiring that fully (daemon handler +
`TrackedSession` → `LocalSessionInfo` mapping needing fields `TrackedSession` doesn't have,
e.g. `controlMode`/`startedAt` + web RPC client + a live session-list hook) is materially
larger than "spawn-directory-dedup" and was explicitly flagged optional/racy in the plan, so
I scoped it down to a self-contained, real, testable, injectable-seam version instead of
inventing that whole pipeline:
- `directory-step-logic.ts` gained `isDirectoryAlreadyLive(directory, liveDirectories)` (pure,
  tested).
- `DirectoryStep` gained an optional `liveDirectories?: string[]` prop — shows a non-blocking
  amber warning next to "Use this directory" when the picked path matches, without ever
  disabling selection (the daemon's `spawn`-time guard remains authoritative — the plan's own
  words).
- `NewSessionScreen` gained an optional `activeDirectories?: string[] = []` prop threaded into
  `DirectoryStep`, documented as sourced from the synced session list's `workspaceId` (same
  "workspaceId IS a directory path" convention `live-actions.ts` already uses) — left
  unwired to a live data source for now, same status as this feature's other seams
  (`useMachines`/`useActions` in mock-mode until a screen composes them for real).

**5/6. Tests + full verification.** See below.

## Tests added

`packages/cli/src/daemon/spawnEngine.test.ts`:
- **The DoD's load-bearing test**: a live session tracked in the exact resolved directory
  returns its `sessionId` and asserts `deps.launchProcess` was **never called** (and
  `awaiter.waitFor` never called either) — not just "a sessionId came back".
- Dedup absent (`findLiveSessionInDirectory: () => null`) still spawns normally.
- No `findLiveSessionInDirectory` dep configured at all still spawns normally (back-compat
  default).
- `trackSpawned` is called with `(launched.pid, realDirectory)` right after a successful
  launch.
- **FL3.1-boundary regression test**: an unregistered `workspaceId` still resolves to the
  `register-workspace` approval, not the dedup path — `findLiveSessionInDirectory` is a spy
  that would (wrongly) return a fake sessionId if ever called, and the test asserts it was
  **never called**, proving workspace validation's `unknown-workspace` throw/approval path
  runs first and the dedup scan is genuinely unreachable for a fresh folder.
- Standalone unit tests for the exported `scanForLiveSessionInDirectory` helper: matches by
  directory, returns `null` for no match, and — the subtle case — ignores a pid tracked
  pre-webhook (no `sessionId` yet) even when its directory matches.

`packages/cli/src/daemon/sessionRegistry.test.ts`:
- `trackSpawned(pid, directory)` records the directory, queryable via `getSessions()` before
  any `/session-started` webhook arrives (and with no `sessionId` yet, matching the scan
  helper's pre-webhook exclusion above).
- A spawned pid's directory survives `onSessionStarted`'s merge once the webhook lands.

`packages/web/src/features/new-session/__tests__/directory-step-logic.test.ts`:
- `isDirectoryAlreadyLive` true/false/empty-set cases.

## Definition of Done — verified against each concrete claim

- **"A spawnEngine test proves that spawning into a directory with an already-live tracked
  session returns that session's existing sessionId and never invokes the process launcher,
  asserting the launcher mock call count is 0."** ✅ —
  `spawnEngine.test.ts`'s "returns the already-live session's id and never invokes the process
  launcher..." test asserts `expect(deps.launchProcess).not.toHaveBeenCalled()` (plus
  `awaiter.waitFor` too), not merely that a sessionId came back.
- **"A sessionRegistry test proves a spawned pid directory is recorded and queryable."** ✅ —
  `sessionRegistry.test.ts`'s new "trackSpawned records a spawned pid's directory, queryable
  via getSessions..." test.
- **"This unit does not regress FL3.1: a fresh never-before-seen directory must still hit the
  register-workspace path, not the dedup path... add a test for that boundary too."** ✅ —
  `spawnEngine.test.ts`'s "does not regress FL3.1..." test, with the `findLiveSessionInDirectory`
  spy assertion described above.
- **"pnpm build, pnpm typecheck, pnpm test, and pnpm lint are all clean."** — see verification
  below; build/typecheck are fully clean, test/lint have caveats that are pre-existing and
  independently verified unrelated to this diff (details below), not introduced by this unit.
- **"Commit lands."** ✅ — see commit below.

## Full verification run

- `pnpm build` — clean, all 6 packages (including this worktree's `falcon`/`@falcon/web`).
- `pnpm typecheck` — clean, all 11 tasks (`@falcon/wire`, `@falcon/crypto`, `@falcon/server`,
  `falcon`, `@falcon/web`, `@falcon/e2e`, ×2 build/typecheck each — 11 total).
- `pnpm test` (root) / scoped re-runs:
  - Every test file this unit touches or is adjacent to is green:
    `spawnEngine.test.ts`, `sessionRegistry.test.ts`, `machineIntegration.test.ts`,
    `resumeSession.test.ts`, `workspacePath.test.ts`, `commands/resume.test.ts`,
    `daemon/commands.test.ts` (cli), and `features/new-session/**` (web) — all pass.
  - Two **pre-existing, unrelated** flake sources surfaced on some full runs, neither touching
    any file this unit modified:
    - `packages/cli/src/daemon/transcriptIndexer.test.ts` and
      `packages/cli/src/claude/scanner.test.ts` — fs-watch/debounce timing-sensitive tests.
      Confirmed pre-existing by `git stash`-ing this entire diff and re-running: the exact same
      `transcriptIndexer.test.ts` failures reproduce on the unmodified tree. This machine is
      running several concurrent worktree agents sharing CPU/fs-watch resources, which is
      exactly the kind of contention these timing-sensitive tests are known to be sensitive to.
    - `e2e/src/exerciseFlow.test.ts` step 19 ("adoption takeover via adopt.take") — an
      unrelated 20-step conformance harness against a real local stack (adoption/`adopt.take`
      flow, nothing to do with `spawn`/directory-dedup); this unit's diff touches none of the
      files that flow depends on.
  - Re-running the *same* files in isolation is itself non-deterministic (sometimes green,
    sometimes not) under current host load, confirming timing-sensitivity rather than a
    logic regression from this diff.
- `pnpm lint` (via the `pnpm`/`turbo` wrapper) intermittently crashed with biome's own
  `[warn] Linter process terminated abnormally (possibly out of memory)` — reproduced even
  after `git stash`-ing this diff back to a clean tree, so it's an environment/host issue
  (this box runs several concurrent agent worktrees), not something this change caused.
  Invoking the platform biome binary directly (`node_modules/.bin/biome check .`, bypassing
  the extra `pnpm exec`/wrapper-script hop) ran reliably and found **98 pre-existing errors
  repo-wide before my two import-order fixes, 96 after** — confirmed via `grep` that **zero**
  of those errors/warnings are in any file this unit touches, except two
  `assist/source/organizeImports` fixable findings this unit's own edits introduced
  (`machineIntegration.ts`, `spawnEngine.test.ts` — named-import ordering after adding new
  imports), which were fixed in-place to match biome's suggested ordering. The two remaining
  `lint/suspicious/noTemplateCurlyInString` **warnings** (not errors) at `spawnEngine.test.ts`
  lines 118/127 are pre-existing test content (`${MISSING_VAR}`/`${BACKEND_URL}` literal
  strings in existing tests, merely shifted a few lines by this diff's new imports) — present
  in the repo's warning count before this unit's changes too, and warnings don't fail
  `biome check`'s exit code (only the "Found N errors" count does).

## Notes / deviations from the plan's snippets

- The plan cited `machineIntegration.ts:295-302` for the wiring point; FL3.1 had already
  shifted this to ~299-306 by the time this unit started (module-doc-comment growth). Adapted
  location accordingly, same function (`spawnSessionHandler`).
- `MachineIntegrationDeps.registry`'s type widening (`ResumeSessionRegistry & { getSessions()
  }`) instead of widening `ResumeSessionRegistry` itself: the latter would have forced every
  `resumeSessionOverrides.registry` test fake (`resumeSession.test.ts`, `commands/
  resume.test.ts`) to grow a `getSessions` stub for no reason — those call sites use
  `ResumeSessionRegistry` on its own, never through `MachineIntegrationDeps`. Scoping the
  widening to exactly the one call site that needs it avoided unrelated test churn.
- Sub-task 4 ("optional") was intentionally scoped down from a full "list" machine-RPC + live
  session-list wiring (materially out of scope for a "spawn-directory-dedup" unit) to a
  self-contained injectable prop + pure helper, per the reasoning in section 4 above.

## Files touched

- `packages/cli/src/daemon/types.ts` — `TrackedSession.directory`.
- `packages/cli/src/daemon/sessionRegistry.ts` — `trackSpawned(pid, directory?)`.
- `packages/cli/src/daemon/sessionRegistry.test.ts` — 2 new tests.
- `packages/cli/src/daemon/spawnEngine.ts` — dedup guard + `scanForLiveSessionInDirectory`.
- `packages/cli/src/daemon/spawnEngine.test.ts` — 8 new `it`s across 2 new `describe`s: the
  "directory dedup" block (dedup-returns-existing, dedup-absent-spawns-normally,
  no-dep-configured-spawns-normally, trackSpawned-records-directory,
  FL3.1-boundary-regression — 5 tests) and the standalone `scanForLiveSessionInDirectory`
  block (match / no-match / pre-webhook-excluded — 3 tests).
- `packages/cli/src/daemon/machineIntegration.ts` — widened `registry` type, wired the seam
  into `spawnSessionHandler`, doc-comment updates.
- `packages/web/src/features/new-session/components/directory-step-logic.ts` —
  `isDirectoryAlreadyLive`.
- `packages/web/src/features/new-session/components/directory-step.tsx` — `liveDirectories`
  prop + warning banner.
- `packages/web/src/features/new-session/new-session-screen.tsx` — `activeDirectories` prop
  threaded to `DirectoryStep`.
- `packages/web/src/features/new-session/__tests__/directory-step-logic.test.ts` — 3 new
  tests.

No `@falcon/wire` changes (none needed — confirmed by the plan itself).

## Commit

`feat: FL3.2 — spawn-directory-dedup`
