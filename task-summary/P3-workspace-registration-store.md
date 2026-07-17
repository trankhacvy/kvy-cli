# P3-workspace-registration-store — Real workspace-registration store for the CLI

§1.3/§3.1/§3.3/§4.1 (CLI — workspace registration). Closes the injected seam
several already-landed tasks (`P3-3.1-web-new-session-flow`,
`P3-3.1-daemon-spawn-rpc`, `P3-3.3-session-adoption-indexer`,
`P3-3.3-adopt-cli-and-take-rpc`) each deliberately left with no real default,
noting a standalone "which workspace directories does this machine know
about" store didn't exist yet.

## What was built

### `packages/cli/src/workspace/registry.ts` (new)

The store itself. Persisted at `~/.falcon/workspaces.json` — a **dedicated
file**, not a new field on `persistence.ts`'s `settings.json`. Several
sibling in-flight/landed tasks already touch `settings.json`/
`workspaceConfig.ts` (`adoptedSessions`, per-workspace git config); the task
brief asked for a self-contained, disjoint file addition, so this module
copies `persistence.ts`'s atomic-write shape (`O_CREAT|O_EXCL` lock file +
tmp-write-then-rename, stale-lock reclaim after 10s, same retry budget)
rather than sharing its implementation or extending its `Settings` type.

Entries are keyed by the workspace directory's real (symlink-resolved)
absolute path — same rationale as `workspaceConfig.ts`'s
`resolveWorkspaceKey`, so a daemon-resolved `realpath` and a raw
`process.cwd()` land on the same entry. That resolved path also **is** the
workspace's `workspaceId` everywhere in this module and its adapters —
matching the simplification `P3-3.1-web-new-session-flow`'s
`live-actions.ts` already assumed ("no workspace registry yet ... the
directory stands in as its own stable workspace identity"), now backed by a
real store instead of an assumption.

Operations:

- `registerWorkspace(directory, {displayName?}, options?)` — creates a new
  entry (`registeredAt` = now) or, if already registered, merges in a new
  `displayName` without touching `registeredAt`. Idempotent — re-registering
  the same directory never duplicates it.
- `listWorkspaces(options?)` — every registered entry, in registration
  order.
- `unregisterWorkspace(directory, options?)` — removes an entry if present;
  returns whether anything was actually removed.
- `isWithinRegisteredWorkspace(directory, options?)` — resolves `directory`
  via `realpath` and returns the registered entry it falls inside of (equal
  to the root, or nested under it), or `null`. Generalizes the same
  containment check `daemon/workspacePath.ts`'s `validateSpawnWorkspace`
  already performs against a single injected root to "any registered root" —
  symlink-safe (a symlink can't be used to appear inside a root it doesn't
  actually resolve into) and prefix-safe (a sibling directory that merely
  shares a path prefix with a root, e.g. `/repo` vs `/repo-sibling`, does not
  match).
- `resolveWorkspacePath(directory)` — the key-resolution helper (real path
  when it exists, else `path.resolve` of the raw input, so an
  about-to-be-created directory can still be pre-registered).

### `packages/cli/src/workspace/adapters.ts` (new)

Real default implementations of two of the three injected seams, built on
top of the registry:

- `createWorkspaceRootLookup()` → `daemon/workspacePath.ts`'s
  `WorkspaceRootLookup` (consumed by `spawn`'s `validateSpawnWorkspace`).
  Since `workspaceId` *is* the registered real path, the lookup is just "is
  this path currently registered".
- `createTranscriptIndexerWorkspaceLister()` → `daemon/transcriptIndexer.ts`'s
  `TranscriptIndexerDeps.listWorkspaces`, mapping every registry entry to the
  `{workspaceId, path}` shape it expects.

**Not adapted** (see "Assumptions / scope boundaries" below):
`daemon/providerSessionResolver.ts`'s `ProviderSessionResolver`.

### `packages/cli/src/commands/workspaceRegister.ts` (new)

The terminal-side surface: `falcon workspace register [--directory <path>]
[--name <display-name>]`, `falcon workspace list`, `falcon workspace
unregister [--directory <path>]`. `--directory` defaults to the current
working directory on both `register` and `unregister` — a bare `falcon
workspace register` just registers "here" (Omnara-style low-friction UX per
the PRD). No daemon interaction, same rationale as the existing `workspace
config` command: reads/writes `~/.falcon/workspaces.json` directly; a real
daemon reads the same store off disk whenever it next needs it.

### Wiring: `args.ts` / `index.ts`

- `args.ts`: new `FalconCommand` variants `workspace-register`,
  `workspace-list`, `workspace-unregister`; `parseWorkspace` dispatches
  `register`/`list`/`unregister` alongside the existing `config`/`sync`.
- `index.ts`: `runWorkspaceRegister`/`runWorkspaceList`/`runWorkspaceUnregister`
  dispatch to the new command module (no `ensureDaemon()` call, matching
  `workspace config`'s precedent); help text updated with the three new
  usage lines.

### Tests

- `workspace/registry.test.ts` (24 tests) — register (new/idempotent/
  displayName-update/symlink-resolution/pre-registration of a nonexistent
  dir/lock-file hygiene/stale-lock reclaim/concurrent-registration
  serialization), list (empty/ordering/corrupt-file recovery/malformed-entry
  filtering), unregister (found/not-found/leaves siblings),
  `resolveWorkspacePath`, `isWithinRegisteredWorkspace` (root itself/
  subdirectory/outside/prefix-sibling-rejection/nonexistent-directory/
  empty-registry).
- `workspace/adapters.test.ts` (5 tests) — both adapters, including "no
  stale caching" (reflects registry changes made between calls).
- `commands/workspaceRegister.test.ts` (8 tests) — all three commands,
  directory defaulting, displayName round-trip, exit codes.
- `args.test.ts` — 9 new cases covering `register`/`list`/`unregister`
  parsing and their error paths.
- `index.test.ts` — 3 new cases: end-to-end register→list→unregister via
  `main()`, the "unregistering a never-registered directory returns 1"
  path, and a `does not call ensureDaemonRunning` guard mirroring the
  existing `workspace config` test.

## Assumptions / scope boundaries

- **Only two of the three seams got a real adapter.**
  `daemon/providerSessionResolver.ts`'s `ProviderSessionResolver` (bare
  provider-session-id → `{workspaceId, directory}`) is **not** wired here.
  Resolving it requires scanning transcript *contents* to find which
  workspace's transcript directory contains a given session id — a
  different, later composition on top of both this registry and the
  transcript-indexing machinery (`claude/scanner.ts`'s `getProjectPath` +
  `adopt/listSessions.ts`'s transcript-parsing conventions), not something
  "which directories are registered" alone can answer. Left as a documented
  follow-up rather than guessed at here.
- **No call site was rewired to use the real adapters.** `daemon/commands.ts`'s
  boot sequence, `daemon/machineRpc.ts`'s handler construction, and
  `daemon/transcriptIndexer.ts`'s actual startup call still take their
  seams as injected parameters with no real default passed in — per the
  task brief, that composition-root wiring is explicitly the sibling task's
  job, not this one's. This module is additive and self-contained: no
  existing file's *behavior* changed, only two new adapter functions were
  added that a future wiring task can pass in.
- **Separate file, separate lock, on purpose.** `workspaces.json` is not a
  new field on `persistence.ts`'s `Settings` — multiple already-landed tasks
  touch `settings.json`/`workspaceConfig.ts` (adoption lineage, per-workspace
  git config), and this task's brief explicitly asked for a disjoint file
  addition to avoid merge conflicts with sibling in-flight work. The
  atomic-write *pattern* (lock file + tmp-write-then-rename) is copied from
  `persistence.ts` rather than shared/imported, for the same reason.
- **`falcon workspace register` has no daemon interaction**, matching
  `falcon workspace config`'s existing precedent (both are pure
  `~/.falcon/*.json` reads/writes) — not gated behind `ensureDaemon()`.
- **`unregisterWorkspace` on a never-registered directory returns `false`
  (CLI: exit code 1)**, not an error — same "a miss is not a failure"
  philosophy as `workspaceConfig.ts`'s reader.

## Verification

From the worktree root (`pnpm install` was needed first — a fresh worktree
checkout with no `node_modules`):

- `pnpm exec turbo run build typecheck test --force` (no turbo cache): **15/15
  tasks green** — `falcon` (cli) 910/910 tests (including all 41 new tests
  from this task), `@falcon/server` 233/233, `@falcon/web` build + typecheck
  green (14 static-export routes, unaffected by this change), `@falcon/wire`
  and `@falcon/crypto` build/typecheck green.
- `node_modules/.bin/biome check --write` on every new/changed file (invoked
  directly rather than via `pnpm lint`, which hit the documented
  `rtk`-hook/linter-OOM issue noted elsewhere in this codebase's `CLAUDE.md`)
  — 6 pure-formatting fixes applied (line-wrapping), 0 remaining errors on
  re-check.
