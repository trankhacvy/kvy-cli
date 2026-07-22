# Falcon

pnpm + Turborepo monorepo. This file documents commands and conventions only —
for the "why", read `plan.md` (build plan + phase-by-phase TODO), `falcon-system-design.md`
(architecture/protocol design), and `falcon-prd.md` (product requirements).

## Commands

Run from repo root (Turborepo resolves per-package task graphs via `dependsOn`):

```bash
pnpm install       # installs deps; postinstall builds @falcon/wire first
pnpm build         # turbo run build     — dual CJS/ESM builds via pkgroll (web: `next build` → static out/)
pnpm typecheck     # turbo run typecheck — tsc --noEmit, depends on ^build
pnpm test          # turbo run test      — vitest run, depends on build
pnpm lint          # biome check . (auto-retries once on failure — see note below)
pnpm lint:fix       # biome check --write .
```

`pnpm lint` retries once automatically: running it immediately after `pnpm build`/`pnpm test`
can occasionally hit `[warn] Linter process terminated abnormally (possibly out of memory)`
from transient resource contention (biome daemon warm-up racing the tail end of `next build`/
vitest CPU usage), not a config problem — `.next`/`out` are already excluded in `biome.json`.
The retry absorbs that transient failure; a lint run that fails twice in a row is a real issue.

Scope to one package with `--filter`, e.g. `pnpm --filter @falcon/wire build`.

CI (`.github/workflows/ci.yml`) runs, in order: install (frozen lockfile) → lint →
build `@falcon/wire` → typecheck → test.

## Package layout

```
packages/
├─ wire/      @falcon/wire    zod schemas — the shared wire protocol contract.
│                             Built first (everything else depends on it).
├─ crypto/    @falcon/crypto  E2E encryption primitives, isomorphic (node + browser builds).
├─ cli/       falcon          CLI skeleton: hand-rolled arg parsing (`falcon` / `falcon claude
│                             [args...]` / `falcon codex [args...]` with full flag passthrough),
│                             file-only logger (`~/.falcon/logs/`, never stdout/stderr).
│                             `src/daemon/`: singleton lock (atomic hard-link + stale-PID
│                             detection), `daemon.state.json` read/write helpers, a Fastify
│                             control server (`/session-started`, `/list`, `/stop-session`,
│                             `/spawn-session`, `/stop`), process-scan-based `falcon kill
│                             daemon/sessions/all/all-force` and `falcon doctor [clean]`
│                             (process discovery/categorization, runaway-kill), `falcon daemon
│                             start/start-sync/stop/status`, `ensureDaemonRunning()`
│                             (auto-start wiring called from `start`/`auth`/`sessions`/`resume`,
│                             respects `FALCON_NO_SERVICE=1`), and the machine-scoped WS client
│                             (`daemon/machineClient.ts`: `registerOrResumeMachine`/CAS-retry
│                             sync against `POST /v1/machines`, `startMachineClient` opening
│                             `/v1/stream` as `clientType: "machine-scoped"` with a 60s
│                             heartbeat), and the adoption Tier-1 transcript indexer
│                             (`daemon/transcriptIndexer.ts`: fs-watches every registered
│                             workspace's Claude Code project transcript dir — reusing
│                             `claude/scanner.ts`'s `getProjectPath` — debounced 2s per
│                             session file, parses title/last-activity, derives a
│                             best-effort "running?" liveness signal from
│                             `processScan.ts`'s new `resolveProcessCwd` + `markers.ts`'s
│                             Falcon-process classifier, and upserts via
│                             `daemon/unmanagedSessionClient.ts` against the server's new
│                             `POST /v1/unmanaged-sessions`, design §8/§11 UC9 Tier 1;
│                             `listWorkspaces`/`isManaged` are injectable seams with no
│                             real default yet — workspace registration and managed-session
│                             lineage are separate, later tasks). Durability (design §7.4/§8,
│                             plan.md §16 "3.2 Durability"): `daemon/sessionsStore.ts`
│                             (`~/.falcon/sessions.json` — wrapped DEK + seq + versions,
│                             tmp-write + rename, in-process write-queue serialized per
│                             homeDir, 14-day expiry) and `daemon/sessionRegistry.ts` (the
│                             `pid → TrackedSession` + durable-by-sessionId bookkeeping,
│                             restored from `sessions.json` on `daemon start-sync` boot and
│                             wired straight into `controlServer.ts`'s `getSessions`/
│                             `stopSession`/`onSessionStarted`) are both landed and wired.
│                             `daemon/resumeSession.ts` re-spawns a persisted/tracked session
│                             with `FALCON_RECONNECT_*` env (reusing `processLauncher.ts`/
│                             `spawnAwaiter.ts` exactly like the `spawn` RPC), and
│                             `machineRpc.ts` now also registers `resumeSession` alongside
│                             `spawn` — both real and unit-tested, but (matching `spawn`'s own
│                             precedent from the prior spawn-RPC task) not yet wired to a live
│                             machine WS connection, since `machineClient.ts`'s socket is
│                             itself not yet started from `commands.ts`. `daemon/selfUpdate.ts`
│                             (installed-bundle mtime capture/diff) and `start-sync`'s own
│                             heartbeat (dead-session pruning + "replaced and idle → hand off
│                             to a fresh daemon" restart, mirroring Happy's #1107
│                             mtime-not-version lesson) are wired end-to-end. `daemon/doctor.ts`
│                             backs the new
│                             `falcon doctor` (process discovery/categorization report) and
│                             `falcon doctor clean` (SIGTERM→SIGKILL of runaway daemon +
│                             daemon-spawned processes only, reusing `kill.ts`'s escalation
│                             logic) subcommands. A chaos test suite
│                             (`daemon/durability.chaos.test.ts`) exercises the design's
│                             failure matrix (daemon crash mid-turn, session-process kill,
│                             sleep/wake heartbeat gaps, and — since none of this touches a
│                             server at all — "server restart") against the real registry/
│                             store/resume modules with injected process fakes. Tier 2/3 of
│                             adoption (design §7.8/§8/§10.4, plan.md §16 "3.3 Session adoption
│                             (UC9)") are also landed: `daemon/adoptTake.ts` (`handleAdoptTake`
│                             — the `adopt.take` machine RPC's core: `mode:'takeover'` finds
│                             the live owning `claude` pid via `adopt/liveness.ts`,
│                             SIGTERM≤5s→SIGKILL it, then spawns a continuation via an injected
│                             `spawnSession`; `mode:'fork'` skips the kill; a mid-turn
│                             `warning` is returned when takeover interrupted a still-running
│                             process) and `daemon/transcriptMirror.ts` (`handleAdoptMirror` —
│                             the `adopt.mirror` machine RPC's core: reads an unmanaged
│                             session's transcript in ≤64KB, line-boundary-safe chunks via a
│                             byte cursor; a `blobRef` field is reserved on the wire schema for
│                             a future blob-storage fallback, unset until that subsystem
│                             lands). Both RPCs are registered in `daemon/machineRpc.ts`
│                             alongside `spawn`/`resumeSession`/`fs.list`/`fs.mkdir` (each
│                             wrapped in its own idempotency-key replay cache where one
│                             applies).
│                             `daemon/providerSessionResolver.ts` defines the shared
│                             `resolveProviderSession` seam both handlers depend on (provider
│                             session id → registered workspace; no real default yet, same
│                             "workspace registration is separate work" caveat as above). The
│                             terminal-side half —
│                             `falcon adopt [--remote] [--list]` + `falcon --continue` alias
│                             (`commands/adopt.ts`, wired into `args.ts`/`index.ts`) — lists
│                             plain sessions for cwd's workspace (`adopt/listSessions.ts`,
│                             reusing `transcriptIndexer.ts`'s `parseTranscript`), preselects
│                             the most recent, and continues it: locally via `claude --resume
│                             <id>` (inherited stdio, blocking) with a before/after directory
│                             snapshot to detect the new provider session id `--resume` mints
│                             and record the old→new lineage (`adopt/lineage.ts`, persisted in
│                             `settings.json`'s new `adoptedSessions` map); or, with `--remote`,
│                             a detached tmux-preferred launch of `falcon claude
│                             --starting-mode remote --continue-from <id>` (lineage recording
│                             for that path is deferred — no hook wired to an ad hoc detached
│                             start yet — and prints an explicit note rather than silently
│                             skipping it). `src/persistence.ts`:
│                             `~/.falcon/` local state — schema-versioned `settings.json`
│                             (atomic lock-file-guarded read-modify-write) and
│                             0600-permissioned `access.key` credentials, both tmp-write +
│                             rename so readers never observe a partial write.
│                             **v2 — ACP (Agent Client Protocol) remote layer (plan.md §17,
│                             design v0.3 §7.3/7.4/7.6/7.9/7.10):** remote mode for BOTH
│                             providers runs through one shared stack in `src/acp/`.
│                             `acpConnection.ts` spawns a managed ACP adapter child (via the
│                             adapter manager's verify-before-spawn) and drives it over
│                             NDJSON stdio with `@agentclientprotocol/sdk` (initialize →
│                             session/new|load|resume → session/prompt → session/cancel →
│                             session/set_mode, pre-ready session-update buffering, stderr
│                             ring-buffer on connect/exit errors). `acpToEnvelope.ts` is the
│                             single provider-agnostic `session/update` → `SessionEnvelope`
│                             mapper (text-chunk coalescing + deferred tool-start, both found
│                             via real recorded fixtures in `acp/__fixtures__/`).
│                             `acpPermissionHandler.ts` is the single first-wins permission
│                             pipeline behind `session/request_permission` (auto-rules now
│                             live agent-side). `acpRemote.ts` (`startAcpRemote`) ties them
│                             into the `RemoteHandle`-shaped transport — `adapterId` selects
│                             `claude-code` (Claude meta payload) vs `codex` (codex-acp, no
│                             Claude preset). This replaced the deleted v1 SDK path
│                             (`remote/claudeRemote.ts`, `sdkToEnvelope.ts`,
│                             `pushableAsyncIterable.ts`, `claude/permissionHandler.ts`,
│                             `claude/getToolDescriptor.ts`, and the
│                             `@anthropic-ai/claude-agent-sdk` dep) AND the hand-rolled Codex
│                             app-server client (`codex/codexAppServerClient.ts`,
│                             `codexAppServerTypes.ts`, `codexRemote.ts`, `envelopeMapper.ts`,
│                             `permissionHandler.ts`). `src/codex/` now holds only
│                             `codexProviderAdapter.ts` — `detect()` + `startLocal()` (always
│                             `null`; Codex has no local TUI) + the honest no-local-mode note.
│                             `src/adapters/` is the managed adapter manager (pinned-version
│                             manifest + integrity verify + `~/.falcon/adapters/` npm-prefix
│                             install, `falcon adapters install|upgrade`, `falcon doctor`
│                             health). `src/claims/claimStore.ts` is the send-idempotency
│                             claim store (`~/.falcon/claims/<sessionId>.json`, claim →
│                             tri-state (`queued`/`duplicate`/`outcome-unknown`) → complete).
│                             `commands/start.ts` (`falcon claude`) drives the local↔remote
│                             `loop.ts` with the ACP remote transport; `commands/startCodex.ts`
│                             (`falcon codex`) is a remote-only session process (no loop; Codex
│                             has no local mode). Git panel (design §4.4, plan.md §16 "4.1 Git
│                             panel", falcon-prd.md FR-7.7) is also landed: the `git.status`/
│                             `git.diff` machine RPCs (`daemon/gitStatus.ts` parses `git
│                             status --porcelain=v2 --branch`; `daemon/gitDiff.ts` runs `git
│                             diff <baseRef>` — two-dot, so uncommitted changes are included —
│                             truncating inline at a safe line boundary with `truncated: true`
│                             past a 60KB budget rather than a real blob upload, since that
│                             subsystem doesn't exist yet; `daemon/gitExec.ts` is the shared
│                             `execFile` wrapper both use), registered in `machineRpc.ts`
│                             alongside the rest. `git.branches` (docs/features/
│                             worktree-isolation.md — automatic per-session git worktree
│                             isolation, docs/competitive-notes-omnara.md #2) joins that
│                             same RPC family: `daemon/gitBranches.ts`'s `getGitBranches`
│                             is a structural clone of `gitStatus.ts` — parses `git
│                             for-each-ref refs/heads` (current branch, checked-out-in-
│                             another-worktree path via `%(worktreepath)`, upstream,
│                             last-commit time) into a `GitBranchInfo[]`, registered in
│                             `machineRpc.ts` alongside `git.status`/`git.diff`. It backs
│                             the New Session wizard's existing-branch worktree picker, on
│                             top of the pre-existing `gitWorktree.ts`'s `ensureBranchWorkspace`
│                             (already wired into `spawnEngine.ts` via `SpawnParams.branch`)
│                             — that module gained two hardening pieces of its own: a typed
│                             `GitWorktreeError` when a branch is already checked out in a
│                             different worktree (pre-flighted via the same
│                             `%(worktreepath)` atom, instead of letting git's raw stderr
│                             surface), and an idempotent `.worktrees/` line appended to the
│                             parent repo's `.git/info/exclude` after each worktree
│                             creation (best-effort — a write failure never fails the
│                             spawn). `spawnEngine.ts`'s directory-dedup guard (Flow 3) now
│                             also keys on the *final*, post-worktree `spawnDirectory`
│                             rather than the pre-worktree `realDirectory` — the worktree
│                             directory a session actually launches in is what dedup must
│                             protect, and `ensureBranchWorkspace` being idempotent makes
│                             checking after it safe. Real git write actions (design §4.4,
│                             plan.md §16 "4.1 Git panel", docs/features/git-write-actions.md,
│                             docs/competitive-notes-omnara.md #3) round out the Git panel:
│                             `git.commit`/`git.push`/`git.renameBranch` are the first git
│                             machine RPCs whose whole point is a side effect — unlike their
│                             read-only siblings, they're gated in `machineRpc.ts` on a new
│                             registered-workspace authorizer (`daemon/gitWriteGuard.ts`'s
│                             `createRegistryWorktreeAuthorizer`, backed by
│                             `workspace/registry.ts`'s `isWithinRegisteredWorkspace` — design
│                             §12 "no arbitrary-directory execution from remote"; the read
│                             RPCs stay ungated, a documented follow-up) and wrapped in the
│                             existing `withIdempotencyCache` (a lost-ack retry replays the
│                             prior commit's SHA rather than minting a second commit).
│                             `daemon/gitCommit.ts` defaults one-click commit to `git add -A`
│                             (`stageAll`); `daemon/gitPush.ts` maps `force` to
│                             `--force-with-lease` only — the raw `--force` flag is
│                             deliberately unreachable over the wire; `daemon/
│                             gitRenameBranch.ts` (`git branch -m`, local-only) reuses
│                             `gitWorktree.ts`'s now-exported `assertSafeBranchName`. All
│                             three are registered in `machineRpc.ts` alongside
│                             `git.status`/`git.diff`/`git.branches`. `src/workspaceConfig.ts`
│                             (`~/.falcon/
│                             settings.json`'s new `workspaces` map, keyed by real/symlink-
│                             resolved directory path) backs both `git.diff`'s base-ref
│                             fallback and the new `falcon workspace config [--base-ref
│                             --remote --directory]` command (`commands/workspaceConfig.ts`,
│                             wired into `index.ts`, no daemon interaction — reads/writes
│                             `settings.json` directly). `src/workspace/registry.ts` is the
│                             real "which workspace directories does this machine know about"
│                             store several earlier tasks left as an injected seam with no
│                             default (`workspacePath.ts`'s `WorkspaceRootLookup`,
│                             `transcriptIndexer.ts`'s `listWorkspaces`,
│                             `providerSessionResolver.ts`'s `ProviderSessionResolver`) —
│                             persisted at its own `~/.falcon/workspaces.json` (register/list/
│                             unregister/`isWithinRegisteredWorkspace`, same atomic
│                             lock-file + tmp-write-then-rename pattern as `persistence.ts`,
│                             kept as a separate file/lock on purpose so this task stays
│                             disjoint from sibling `settings.json` writers). `src/workspace/
│                             adapters.ts` wires it into two of those three seams
│                             (`createWorkspaceRootLookup`, `createTranscriptIndexerWorkspaceLister`
│                             — a `workspaceId` *is* a workspace's registered real path);
│                             `ProviderSessionResolver` still has no real default (resolving a
│                             provider session id needs transcript-content scanning, not just
│                             "which directories are registered" — a different, later
│                             composition). `commands/workspaceRegister.ts` backs the new
│                             `falcon workspace register [--directory --name]` / `list` /
│                             `unregister` commands (wired into `index.ts`, no daemon
│                             interaction, matching `workspace config`'s precedent).
│                             `daemon/commands.ts`'s `createDaemonCommandDeps` now defaults
│                             `resolveWorkspaceRoot`/`listWorkspaces` to those two adapters
│                             (homeDir-scoped, so a test's overridden `homeDir` is honored
│                             rather than reading the real `~/.falcon`), flowing through
│                             `daemon/machineIntegration.ts` into the `spawn` machine RPC's
│                             workspace-path validation and into a new
│                             `startTranscriptIndexer` call made once the machine client is
│                             up — the transcript indexer module existed and was fully
│                             tested but had no live boot-time caller until now. Both were
│                             previously honest-but-always-empty stubs; `resolveProviderSession`
│                             (`adopt.take`/`adopt.mirror`) still has no real default, same
│                             reasoning as above. `src/adapters/` (design §7.9, plan.md §16
│                             "17. v2 — ACP migration / Phase 2.0 — foundation": adapter
│                             manager) is landed: `manifest.ts`'s `ADAPTER_MANIFEST` pins each
│                             official ACP adapter's exact npm-scoped package name, version,
│                             and npm-registry `dist.integrity` hash (`claude-code` →
│                             `@agentclientprotocol/claude-agent-acp`, `codex` →
│                             `@agentclientprotocol/codex-acp` — both scoped; the design doc's
│                             unscoped shorthand doesn't exist on the registry); `install.ts`
│                             runs a real `npm install <pkg>@<exact version>` into
│                             `~/.falcon/adapters/` (its own npm prefix, injectable `NpmExec`
│                             seam) and re-verifies before reporting success;
│                             `verify.ts` is the actual check — reads npm's own
│                             `node_modules/.package-lock.json` and compares version +
│                             integrity against the manifest, never throws; `health.ts` wraps
│                             it for `falcon doctor`/`falcon adapters`; `spawn.ts`'s
│                             `resolveAdapterSpawn` is the verify-before-spawn seam Phase
│                             2.1's `acpConnection.ts` will call instead of touching
│                             `paths.ts` directly — no `npx` at session start, ever. Wired up
│                             as `falcon adapters install|upgrade` (`commands/adapters.ts`,
│                             `args.ts`, `index.ts`, no daemon interaction — a local npm-prefix
│                             operation) and into `falcon doctor`'s report (`daemon/doctor.ts`
│                             gained `adapters`/`providers` sections, reusing the existing
│                             `detectClaudeCode`/`detectCodex` `ProviderAdapter.detect()`
│                             implementations rather than duplicating CLI detection).
│                             Standalone module — no dependency on the claim store or
│                             `@falcon/wire` changes from the same phase.
├─ server/    @falcon/server  Fastify 5 app skeleton (zod type-provider, /health, pino
│                             logging) + Drizzle ORM schema (`src/db/schema.ts`) and
│                             migrations (`drizzle/`), migration-on-boot runner + auth
│                             module (src/auth/: JWT HS256 mint/verify, in-memory token
│                             cache, app.authenticate preHandler) + `POST /v1/auth`
│                             challenge/response route, `POST /v1/auth/register` OAuth
│                             (Google/GitHub) sign-in, and `/v1/auth/pair*` device-pairing
│                             routes + Socket.IO on `/v1/stream` (src/app/socket.ts,
│                             src/app/socket/rpcHandler.ts) fanning out through
│                             `src/app/events/eventRouter.ts` (room-scoped emitUpdate/
│                             emitEphemeral, presence ephemerals, backpressure coalescing)
│                             + the HTTP write path (src/app/routes/: POST /v1/sessions,
│                             POST/GET .../messages, PUT .../metadata|state CAS, GET
│                             /v1/sync, GET /v1/sessions, POST /v1/machines — all
│                             idempotent/rate-limited, design §4.3 DELTA D1) fanning out
│                             through that same `eventRouter` post-commit, and lifecycle
│                             push dispatch (src/app/push/: `dispatch.ts`'s
│                             `buildPushDispatcher` — presence-suppressed via
│                             `eventRouter.hasActiveVisibleClient`, fans out to a
│                             pluggable `channels/` registry — `webpush` fully wired via
│                             `web-push` + VAPID config, `telegram`/`ntfy` stubbed for a
│                             later task; wired into `POST /v1/sessions/:id/status`'s
│                             `failed` transition and the new `POST
│                             /v1/sessions/:id/notify {kind: perm|question|done}`) +
│                             `POST`/`DELETE /v1/push/subscribe` (src/app/routes/push.ts) +
│                             `POST /v1/unmanaged-sessions` (src/app/routes/
│                             unmanagedSessions.ts — adoption Tier 1, design §8/§11 UC9):
│                             upsert-by-`(machineId, providerRef)` for the daemon transcript
│                             indexer, fanning out `unmanaged-new`/`unmanaged-update`
│                             through the same `eventRouter`.
└─ web/       @falcon/web     Next.js PWA (App Router, static export). Tailwind + shadcn/ui
                              wired up, dark default theme. Auth pages (OAuth sign-in, key
                              generation, recovery-code export, pairing-approve —
                              src/app/signin, src/app/auth, src/app/pair,
                              src/app/settings/recovery) are landed. Crypto worker bridge
                              (src/crypto/), the transcript reducer (src/sync/reducer/) —
                              folds `SessionEnvelope[]` into ordered `RenderItem[]` (design
                              §9.1) — apiSocket, the user-scoped Socket.IO client with
                              infinite reconnect + app-state reporting, and
                              `src/sync/engine.ts`, the sync engine (design §8.1/§9.1, DELTA
                              D2: headerSeq structural fast-path + per-session msgSeq
                              message fast-path against a TanStack Query cache, gap ⇒
                              `invalidateQueries`, WS reconnect ⇒ invalidate everything), are
                              all wired up (src/sync/). The engine takes an injectable
                              `SyncSocketSource` (`on('update'|'reconnect', ...)`), which the
                              real `apiSocket` satisfies structurally — no adapter needed.
                              `src/features/session-list/`: the Home screen (design §9.2
                              "Home" row, FR-7.1) — sessions grouped by workspace, a derived
                              status dot per session (`status.ts`'s `deriveSessionStatus`,
                              computed from each session's `RenderItem[]` plus live
                              presence/attention signals, never stored — design principle
                              #3) and machine online/offline badges. Takes an injectable
                              `UseSessionListSnapshot` hook (defaults to a static mock
                              snapshot, `mock-source.ts`) so it composes with the real
                              sync-engine-backed hook once the two are wired together, same
                              seam as the sync engine's `SyncSocketSource`. A read-only
                              session timeline screen (`/session/[id]`,
                              `src/components/timeline/`) is also landed: a virtualized
                              `Timeline` that renders the reducer's `RenderItem[]` as a
                              structured chat transcript — markdown via a
                              unified/remark/shiki pipeline compiled straight to React
                              elements (`rehype-react`, `src/lib/markdown.ts` — no
                              `dangerouslySetInnerHTML` anywhere), collapsible thinking
                              blocks, a `ToolCard` registry (Bash, Edit/Write/MultiEdit+diff,
                              Read, Grep/Glob, TodoWrite checklist, Task/subagent nesting,
                              MCP generic fallback), and read-only permission/service/file
                              markers. It runs off a hand-built demo fixture
                              (`src/components/timeline/demo-items.ts`) pending the sync
                              engine wiring. Web Push (src/push/: `subscribe.ts`'s
                              `subscribeToPush`/`unsubscribeFromPush` against an injectable
                              `PushEnvironment`/`PushApiPort`, same testable-seam pattern
                              as `apiSocket.ts`; `public/sw.js`, a plain static service
                              worker — `push` shows a generic kind-keyed notification,
                              `notificationclick` deep-links to `/session/<id>/`) is wired
                              up behind `src/app/settings/notifications/`, a minimal
                              enable/disable toggle. The Phase 2 web control surface
                              (`src/features/session-control/`) is also landed: `Composer`
                              (TanStack `useMutation` → the `message` session RPC, optimistic
                              insert reconciled by echo), `PermCard` (Allow/Deny/
                              Allow-for-session/mode-switch + edit-preview diff,
                              "answered on another device" first-wins-loser state),
                              `ControlBar` (interrupt, permission-mode selector, take-control),
                              derived attention (perm∨question∨done-unseen vs per-device
                              last-seen) driving tab-title/favicon badges, and
                              `sync/sessionRpc.ts`, the typed caller-side client for the five
                              session RPC methods over `apiSocket`'s new `rpcCall()`. All of it
                              still runs off the timeline's existing demo fixture via an
                              injectable `SessionControlActions`/`UseSessionControl` seam
                              (mirrors `features/session-list`'s own mock-source pattern) —
                              wiring the sync engine into the Home screen and timeline (gap
                              detection, TanStack Query invalidation, FR-7.2 live session
                              timeline) plus the real per-session crypto client, and
                              auth-gating the Home route, are still [planned]. The Git panel
                              (`src/features/git-diff/`, plan.md §16 "4.1 Git panel",
                              falcon-prd.md FR-7.7, docs/features/git-write-actions.md) is
                              landed as its own feature area — no longer read-only:
                              `ChangedFilesList` + `UnifiedDiffViewer` (parses `git diff`
                              unified-diff text via the new `lib/unifiedDiff.ts`,
                              shiki-highlights each line via the new `lib/diffHighlight.ts` —
                              `codeToTokens` rendered to plain `<span>`s, same
                              no-`dangerouslySetInnerHTML` rule as `markdown.ts`), plus a
                              `GitToolbar` (inline branch rename, one-click commit — defaults
                              to `git add -A` so untracked files are included — Push, and
                              Force Push behind a confirm dialog; its pure inline-rename/
                              commit-submit logic lives in `git-toolbar-state.ts`) and a
                              `CompareAgainstSelect` ("Compare against": workspace default /
                              `HEAD` (uncommitted) / any local branch / a free-text ref,
                              client-side rejecting a `-`-prefixed custom ref the same way the
                              daemon's `isSafeRevision` does — pure logic in
                              `compare-against-select-state.ts`), all composed by
                              `GitDiffPanel` and driven by `use-git-panel.ts` (three
                              `@tanstack/react-query` queries — `git.status` once per
                              worktree, `git.diff` re-fetched on file selection or
                              `compareRef` change — via the pure `git-diff-query.ts`'s
                              `buildDiffFetchOptions` — and `git.branches` for the compare
                              selector; three `useMutation`s — commit/push/renameBranch —
                              invalidating the status/diff/branches queries on success).
                              `sync/machineRpc.ts` gained `git.status`/`git.diff`/
                              `git.branches`/`git.commit`/`git.push`/`git.renameBranch`
                              alongside `spawn`/`fs.*`. Mounted at the new `/session/[id]/git/`
                              route (linked from the timeline header's "Files changed"
                              button) and, like every other feature here, takes an injectable
                              `UseGitDiffActions` seam (`live-actions.ts`'s
                              `machineRpcToGitDiffActions` vs. the default `mock-source.ts`)
                              — unlike most of the rest of this list, this one IS wired to a
                              live `apiSocket`/per-machine crypto client already
                              (`use-live-git-diff-actions.ts`, gated on
                              `use-machine-crypto.ts`'s DEK unwrap) — a stale claim to the
                              contrary in an earlier revision of this file has been corrected.
                              The New Session wizard
                              (`src/features/new-session/`, `/session/new/`, falcon-system-design.md
                              §9.2 "New session" row, falcon-prd.md FR-7.5/UC5) is a five-step
                              flow — machine → directory picker → optional session-import →
                              options (provider/mode/model/branch) → review — driven by
                              `wizard-state.ts`'s pure step/form logic and an injectable
                              `NewSessionActions` seam (`live-actions.ts`'s
                              `machineRpcToActions` vs. the default `mock-source.ts`, same
                              not-yet-wired-to-a-live-socket state as the rest of this list).
                              Automatic per-session git worktree isolation (docs/features/
                              worktree-isolation.md, docs/competitive-notes-omnara.md #2)
                              surfaces the daemon's `gitWorktree.ts`/`SpawnParams.branch` as
                              a first-class 3-way `branchMode` on the options step — "Repo
                              root" / "New branch" (recommended, auto-generated
                              `wf/<yyyyMMdd>-<4 chars>` name via the new `auto-branch.ts`,
                              worktree-isolated by default) / "Existing branch" (always
                              isolated in a fresh worktree, never switches the main
                              checkout) — backed by the new `git.branches` machine RPC
                              (`sync/machineRpc.ts`, a structural clone of `git.status`) for
                              the existing-branch picker's branch list + disabled
                              already-checked-out-elsewhere rows. `git-defaults.ts` (a
                              strict copy of `favorites.ts`'s per-device `localStorage`
                              pattern) backs a new Settings → Git page
                              (`app/(protected)/settings/git/`, linked from `app-shell.tsx`'s
                              settings nav) that seeds the wizard's starting `branchMode`
                              ("repo-root" or "new-branch" — "existing-branch" is inherently
                              per-session, never a global default).
```

Each package builds with `pkgroll` to dual CJS/ESM + `.d.ts`, and exposes
`build` / `typecheck` / `test` scripts consumed by the root turbo pipeline.

## Database (`packages/server`)

Drizzle ORM + Postgres. Schema lives in `packages/server/src/db/schema.ts`; every
encrypted column uses the shared `bytea` custom type (raw ciphertext bytes, never
decrypted server-side — design §5.3/§6.1). `DATABASE_URL` config env var, defaults to
`postgres://falcon:falcon@localhost:5432/falcon` for local dev.

```bash
pnpm --filter @falcon/server db:generate   # drizzle-kit generate — diff schema.ts, emit drizzle/*.sql
pnpm --filter @falcon/server db:migrate    # apply pending migrations once, standalone
```

Migrations also run automatically on server boot (`src/db/migrate.ts`, called from
`main.ts` before `app.listen` — design §6.5: "migrate runs on boot"). Idempotent: safe
to run against an already-current database.

## Conventions

- **pnpm workspaces** — `pnpm-workspace.yaml` globs `packages/*`. Add new packages there;
  no other wiring needed for pnpm to pick them up.
- **Strict TypeScript** — every package extends root `tsconfig.base.json` (strict mode,
  `noUncheckedIndexedAccess`, `noImplicitReturns`, etc.). Don't loosen these per-package.
- **`@/` path alias** — each package's own `tsconfig.json` maps `@/*` to `./src/*`. Import
  within a package via `@/...`; import across packages via the published package name
  (e.g. `@falcon/wire`).
- **Biome** — single formatter + linter at the root (`biome.json`), not per-package. Run
  `pnpm lint` / `pnpm lint:fix` before committing.
- **`@falcon/wire` builds first** — it has no workspace dependencies and everything else
  depends on its compiled output; this is why CI and `postinstall` (`scripts/postinstall.cjs`,
  skippable via `SKIP_FALCON_WIRE_BUILD=1`) build it explicitly ahead of the general build.

## Docs

- `plan.md` — the build plan and the authoritative phase/task checklist (§16).
- `falcon-system-design.md` — architecture, protocol, and encryption design.
- `falcon-prd.md` — product requirements.
- `docs/protocol.md`, `docs/encryption.md` — short stubs pointing into the design doc.
- `docs/uninstall.md` — user-facing uninstall/cleanup guide: `falcon shim uninstall`,
  `falcon daemon service uninstall`, and the full `rm -rf ~/.falcon` walkthrough
  (falcon-prd.md FR-1.6).
- `deploy/README.md` — self-host walkthrough (`deploy/docker-compose.yml`: server +
  postgres + optional minio, migrate-on-boot, split-origin web with strict CSP + SRI).

Update this file as each phase lands new packages (e.g. once `cli`/`server`/`web` exist,
move them out of "planned" above and add any new root-level commands they introduce).
