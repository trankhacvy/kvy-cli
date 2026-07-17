# P3-workspace-registration-wiring — Wire workspace-registration-store adapters into daemon call sites

## Landing addendum (2026-07-17)

This branch (tip `b781297`, cut from cycle-63 `main` tip `c82ef94`) had a real, unmerged
commit sitting in its own worktree/branch — not yet an ancestor of `main`
(`git merge-base --is-ancestor P3-workspace-registration-wiring main` → false at the start
of this pass, since `main` had moved on to `61c2822` via the two `P4-4.2-*` landings in the
meantime). Landed it:

- `git merge main --no-edit -m "merge: land P3-workspace-registration-wiring onto main"`
  from inside the branch — **zero conflicts**. `main` had not touched any of this branch's
  four files (`daemon/commands.ts`, `daemon/machineIntegration.ts`, `workspace/adapters.ts`,
  `CLAUDE.md`) since the `c82ef94` fork point (`git diff c82ef94 main --stat -- <those
  files>` was empty pre-merge); the only overlap in the merge's file list was additive
  churn from `P4-4.2-session-import`/`P4-4.2-sessions-cli` touching unrelated files
  (`commands/{resume,sessionsList}.ts`, `features/new-session/`, etc.).
- Resulting merge commit: `fe5258e` ("merge: land P3-workspace-registration-wiring onto
  main"), parents `b781297` (this branch) and `61c2822` (`main`'s prior tip).
- Re-ran the full workspace suite post-merge: `pnpm typecheck` — 9/9 turbo tasks green;
  `pnpm test` — 9/9 turbo tasks green, 100 `falcon` cli test files / 976 tests, 0 failures,
  no regressions from either side of the merge; `pnpm build` — 5/5 packages, `FULL TURBO`
  cache hit, green.
- `main` was fast-forwarded to `fe5258e` in the primary checkout (not this worktree, which
  cannot itself check out `main`).

This also unblocks the daemon-side half of `adopt.list`, which `P4-4.2-session-import`'s
web wizard step already speaks the wire contract for but has no live handler for yet — that
remains separate follow-up work (a new `adopt.list` machine RPC handler), not something this
wiring task's scope covered.

## Scope recap

`P3-workspace-registration-store` landed `packages/cli/src/workspace/{registry,adapters}.ts`
(`registerWorkspace`/`listWorkspaces`/`unregisterWorkspace`/`isWithinRegisteredWorkspace`,
persisted at `~/.falcon/workspaces.json`) plus two real adapters
(`createWorkspaceRootLookup`, `createTranscriptIndexerWorkspaceLister`) — but additive-only:
nothing called them. This task wires those two adapters into the real daemon boot path.

## What was actually wrong, concretely

- `daemon/commands.ts`'s `createDaemonCommandDeps()` defaulted `resolveWorkspaceRoot: () =>
  null` — every `spawn` RPC's workspace-path validation
  (`workspacePath.ts`'s `validateSpawnWorkspace`) therefore always failed with
  `unknown-workspace`, regardless of what was actually registered.
- **`daemon/transcriptIndexer.ts`'s `startTranscriptIndexer` was never called from any
  production code path at all** — not "wired to a stub", but genuinely dead: the whole
  module (fs-watch, debounce, liveness-scan, upsert) was fully built and unit-tested in
  isolation but had zero live callers. Grepping the package for `startTranscriptIndexer(`
  outside its own test file confirmed this before starting.

## What was wired

1. **`packages/cli/src/daemon/commands.ts`** (composition root / boot sequence):
   - `createDaemonCommandDeps()` now resolves `homeDir` *before* building the returned
     object (honoring an `overrides.homeDir`, exactly like the `homeDir` field itself will
     end up), then defaults `resolveWorkspaceRoot: createWorkspaceRootLookup({ homeDir })`
     and a new `listWorkspaces: createTranscriptIndexerWorkspaceLister({ homeDir })` field.
     This homeDir-first restructuring matters: without it, a test overriding `homeDir` (as
     every existing `commands.test.ts` helper does) would have gotten a default adapter
     silently reading the *real* `~/.falcon/workspaces.json` instead of the test tmpdir.
   - Added `listWorkspaces` to the `DaemonCommandDeps` interface and threaded it through
     `runDaemonStartSync`'s `createMachineIntegrationDeps(...)` call, alongside the
     pre-existing `resolveWorkspaceRoot`.
   - Updated the module's header doc comment (previously claimed no real workspace store
     existed at all).

2. **`packages/cli/src/daemon/machineIntegration.ts`** (the actual composition point that
   builds the callbacks `machineRpc.ts`'s `registerMachineRpcHandlers` registers, and now
   also the transcript indexer's live caller):
   - Added `listWorkspaces` to `MachineIntegrationDeps` (default `async () => []` in
     `createMachineIntegrationDeps`, mirroring `resolveWorkspaceRoot`'s own `() => null`
     default — this module stays registry-agnostic; `commands.ts` supplies the real one).
   - After `registerMachineRpcHandlers(...)` succeeds, `startMachineIntegration` now also
     builds a fresh `unmanagedSessionClient.ts` deps object from this boot's already-derived
     credentials/keyTree (`token`, `contentPublicKey`) and calls
     `startTranscriptIndexer(createTranscriptIndexerDeps({ machineId, listWorkspaces:
     deps.listWorkspaces, upsert: ... }, { logger }))`. The returned handle's `.stop()` is
     called first in `MachineIntegrationHandle.stop()` (before `rpcHandle.stop()`/
     `started.handle.stop()`), matching the existing "stop what was started last, first"
     ordering `commands.ts` already uses for machine integration itself.
   - Updated the module's header doc comment to describe both the workspace-registry
     hand-off and the transcript indexer's new startup call.

3. **`packages/cli/src/workspace/adapters.ts`**: updated the doc comment only (no logic
   change) — it previously said wiring into a live daemon boot was explicitly out of scope;
   now documents that it's done and where.

4. **`CLAUDE.md`**: updated the stale "none of the adapters are wired into a live daemon
   boot sequence yet" note under `packages/cli`'s directory listing.

## Why `machineRpc.ts` itself needed no code changes

The task brief named `daemon/machineRpc.ts`'s "handler construction" as a wiring point. In
the actual code, `registerMachineRpcHandlers` (in `machineRpc.ts`) takes pre-built callback
functions (`spawnSession`, `resumeSession`, `adoptTake`, `adoptMirror`) as `MachineRpcDeps` —
it has no direct reference to `resolveWorkspaceRoot`/`listWorkspaces` at all. Those callbacks
are actually constructed one file up, in `machineIntegration.ts`'s `spawnSessionHandler`
(which already closed over `deps.resolveWorkspaceRoot` and passed it straight into
`spawnSessionCore`/`validateSpawnWorkspace`). So wiring the real adapter as `commands.ts`'s
*default* is what actually flips `spawn`'s workspace-path validation from "always empty" to
"real registry" end-to-end — no `machineRpc.ts` edit was needed or possible without an
unrelated refactor. This is called out explicitly so the gap isn't mistaken for an oversight.

## Why "git-panel base-ref resolution" was left untouched

Checked `gitDiff.ts`/`gitStatus.ts` and the wire schema (`GitStatusParamsSchema`/
`GitDiffParamsSchema`): both RPCs take a plain `worktree` path directly (not a
`workspaceId`), and `git.diff`'s base-ref fallback already reads a real,
already-functional store — `workspaceConfig.ts`'s `~/.falcon/settings.json` `workspaces`
map, keyed by resolved directory path, populated by `falcon workspace config --base-ref`.
That store is unrelated to (and predates) this task's `workspace/registry.ts`; it was never
a stub and needed no wiring. Falcon's design doc (§12 Security Considerations) also only
calls out `spawn` — not `git.status`/`git.diff` — for "no arbitrary-directory execution"
validation, so no new validation was invented for the git RPCs either; that would be new
scope, not wiring.

## Verification

- `pnpm build` — 5/5 packages, green.
- `pnpm typecheck` — 9/9 tasks, green.
- `pnpm --filter falcon test` — 98/98 test files, 963/963 tests, green. Notably:
  - `commands.machineWiring.integration.test.ts` (a real Socket.IO + real `@falcon/server`
    end-to-end test of `spawn`/`resumeSession`/`adopt.take`/`git.status` over the wire)
    still passes with the new transcript-indexer startup call now also running inside
    `startMachineIntegration` during that test — it doesn't override `listWorkspaces`, so
    the real default reads an empty temp `workspaces.json` and the indexer harmlessly
    watches nothing, proving the new code path is inert (not just untriggered) when no
    workspace is registered.
  - `machineIntegration.test.ts`'s existing DEK-survives-a-restart test also passes
    unmodified, confirming the new transcript-indexer startup/stop doesn't disturb the
    machine-registration/DEK-persistence flow it already covers.
  - `commands.test.ts` never exercises the deeper `startMachineIntegration` path (no test
    supplies credentials), so the homeDir-first restructuring of `createDaemonCommandDeps`
    was verified by inspection + the full unit suite for `workspace/registry.test.ts`/
    `workspace/adapters.test.ts` (already-passing, unmodified) rather than a new
    integration test — adding one was judged out of scope for a wiring-only task with an
    already-comprehensive existing integration test covering the boot path.
- `biome check` on the three touched files: clean. A full-repo `biome check .` shows 41
  pre-existing errors/98 warnings, none in the touched files — confirmed via `git diff`
  scoping (same pre-existing, unrelated-to-this-change state `plan.md` already documents
  for this repo's lint baseline).

## Assumptions / deliberate non-changes

- `resolveProviderSession` (used by `adopt.take`/`adopt.mirror`) is intentionally left as
  the `async () => null` stub in both `commands.ts` and `machineIntegration.ts` — this
  matches `workspace/adapters.ts`'s own documented scope boundary (resolving a bare
  provider session id needs transcript-content scanning, not just "which directories are
  registered"; a different, later composition, not this task's job).
- `resolveResumeDirectory` is likewise untouched — out of scope, no workspace-registry
  dependency.
- The transcript indexer's `isManaged` still defaults to `() => false` (no lineage store
  wired) — unrelated to workspace registration and explicitly out of scope per
  `transcriptIndexer.ts`'s own doc comment.
- No new validation was added to `git.status`/`git.diff` RPCs against the registry (see
  above) — the task brief's phrasing was interpreted as referring to the overall workspace
  data flow rather than a literal, currently-nonexistent validation gap in those two RPCs.
