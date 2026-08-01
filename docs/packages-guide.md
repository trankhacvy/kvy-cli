# Kvy packages — detailed guide

Complete overview of each package's internals. Start with CLAUDE.md's quick reference; this file is for deep dives.

## packages/wire — @kvy/wire

Zod schemas — the shared wire protocol contract. Built first (everything else depends on it).

## packages/crypto — @kvy/crypto

E2E encryption primitives, isomorphic (node + browser builds).

## packages/cli — kvy

CLI skeleton with hand-rolled arg parsing (`kvy` / `kvy claude [args...]` / `kvy codex [args...]` with full flag passthrough), file-only logger (`~/.kvy/logs/`, never stdout/stderr).

### Daemon (`src/daemon/`)

Singleton lock (atomic hard-link + stale-PID detection), `daemon.state.json` read/write helpers, and a Fastify control server (`/session-started`, `/list`, `/stop-session`, `/spawn-session`, `/stop`). Process-scan-based `kvy kill daemon/sessions/all/all-force` and `kvy doctor [clean]` (process discovery/categorization, runaway-kill).

**Daemon lifecycle:** `kvy daemon start/start-sync/stop/status`, `ensureDaemonRunning()` (auto-start wiring called from `start`/`auth`/`sessions`/`resume`, respects `KVY_NO_SERVICE=1`).

**Machine connection:** Machine-scoped WebSocket client (`daemon/machineClient.ts`): `registerOrResumeMachine`/CAS-retry sync against `POST /v1/machines`, `startMachineClient` opening `/v1/stream` as `clientType: "machine-scoped"` with a 60s heartbeat.

**Session tracking:** Adoption Tier-1 transcript indexer (`daemon/transcriptIndexer.ts`): fs-watches every registered workspace's Claude Code project transcript dir, debounced 2s per session file, parses title/last-activity, derives a best-effort "running?" liveness signal from `processScan.ts`'s `resolveProcessCwd` + `markers.ts`'s Kvy-process classifier, and upserts via `daemon/unmanagedSessionClient.ts` against `POST /v1/unmanaged-sessions`. `listWorkspaces`/`isManaged` are injectable seams with no real default yet.

**Durability:** `daemon/sessionsStore.ts` (`~/.kvy/sessions.json` — wrapped DEK + seq + versions, tmp-write + rename, in-process write-queue serialized per homeDir, 14-day expiry) and `daemon/sessionRegistry.ts` (pid → TrackedSession + durable-by-sessionId bookkeeping, restored from `sessions.json` on `daemon start-sync` boot). `daemon/resumeSession.ts` re-spawns a persisted/tracked session with `KVY_RECONNECT_*` env. `daemon/selfUpdate.ts` (installed-bundle mtime capture/diff) and `start-sync`'s own heartbeat (dead-session pruning + restart logic) are wired end-to-end.

**Admin tools:** `daemon/doctor.ts` backs `kvy doctor` (process discovery/categorization report) and `kvy doctor clean` (SIGTERM→SIGKILL of runaway daemon). Chaos test suite (`daemon/durability.chaos.test.ts`) exercises failure matrix against the real registry/store/resume modules with injected process fakes.

**Session adoption:** Tier 2/3 — `daemon/adoptTake.ts` (`handleAdoptTake`: mode:'takeover' finds the live owning claude pid via `adopt/liveness.ts`, SIGTERM≤5s→SIGKILL it, then spawns a continuation; mode:'fork' skips the kill) and `daemon/transcriptMirror.ts` (`handleAdoptMirror`: reads unmanaged session's transcript in ≤64KB, line-boundary-safe chunks via byte cursor). Both RPCs registered in `daemon/machineRpc.ts` alongside `spawn`/`resumeSession`/`fs.list`/`fs.mkdir`. Terminal-side half: `kvy adopt [--remote] [--list]` + `kvy --continue` alias (`commands/adopt.ts`).

**Local state:** `src/persistence.ts` — `~/.kvy/` holds schema-versioned `settings.json` (atomic lock-file-guarded read-modify-write) and 0600-permissioned `access.key` credentials, both tmp-write + rename.

### ACP remote layer (v2)

Remote mode for both providers runs through shared stack in `src/acp/`. `acpConnection.ts` spawns a managed ACP adapter child (via adapter manager's verify-before-spawn) and drives it over NDJSON stdio with `@agentclientprotocol/sdk` (initialize → session/new|load|resume → session/prompt → session/cancel → session/set_mode, pre-ready session-update buffering, stderr ring-buffer on connect/exit errors).

`acpToEnvelope.ts` is the single provider-agnostic `session/update` → `SessionEnvelope` mapper (text-chunk coalescing + deferred tool-start). `acpPermissionHandler.ts` is the single first-wins permission pipeline behind `session/request_permission`. `acpRemote.ts` (`startAcpRemote`) ties them into the `RemoteHandle`-shaped transport — `adapterId` selects `claude-code` (Claude meta payload) vs `codex` (codex-acp, no Claude preset).

`src/codex/codexProviderAdapter.ts` — `detect()` + `startLocal()` (always `null`; Codex has no local TUI).

### Adapter manager

`src/adapters/` — pinned-version manifest + integrity verify + `~/.kvy/adapters/` npm-prefix install. `manifest.ts`'s `ADAPTER_MANIFEST` pins each official ACP adapter's exact npm-scoped package name, version, and npm-registry `dist.integrity` hash. `install.ts` runs a real `npm install <pkg>@<exact version>` into `~/.kvy/adapters/` and re-verifies. `verify.ts` reads npm's own `node_modules/.package-lock.json` and compares version + integrity. `spawn.ts`'s `resolveAdapterSpawn` is the verify-before-spawn seam. Wired as `kvy adapters install|upgrade` (`commands/adapters.ts`).

### Claim store

`src/claims/claimStore.ts` — send-idempotency claim store (`~/.kvy/claims/<sessionId>.json`, claim → tri-state (`queued`/`duplicate`/`outcome-unknown`) → complete).

### Git panel

Real git read/write surface: `git.status`/`git.diff` (`daemon/gitStatus.ts`, `daemon/gitDiff.ts`), `git.branches` (`daemon/gitBranches.ts`), `git.commit`/`git.push`/`git.renameBranch` (all registered in `daemon/machineRpc.ts`). Git write actions are gated on registered-workspace authorizer (`daemon/gitWriteGuard.ts`) and wrapped in idempotency cache.

Automatic per-session git worktree isolation: `gitWorktree.ts`'s `ensureBranchWorkspace` (idempotent). `spawnEngine.ts`'s directory-dedup now keys on post-worktree `spawnDirectory`.

### Workspace management

`src/workspaceConfig.ts` — `~/.kvy/settings.json`'s `workspaces` map, keyed by real/symlink-resolved directory path. Backs `git.diff`'s base-ref fallback and `kvy workspace config [--base-ref --remote --directory]` command.

`src/workspace/registry.ts` — persisted at `~/.kvy/workspaces.json` (register/list/unregister/`isWithinRegisteredWorkspace`). `src/workspace/adapters.ts` wires it into daemon seams. `commands/workspaceRegister.ts` backs `kvy workspace register [--directory --name]` / `list` / `unregister`.

### GitHub integration

`daemon/githubChecks.ts`'s `getGithubChecks` resolves workspace's remote → owner/repo, current branch, open PR, and PR head commit's check-runs via GitHub REST API. Authenticated with machine-local GitHub token (`github/githubAuth.ts`'s `~/.kvy/github.key`, 0600). `kvy github login [--token] [--client-id <id>] | logout | status` command uses GitHub OAuth device authorization flow (`github/deviceFlow.ts`).

### Preview tunnels

`daemon/portScan.ts` (`lsof -nP -iTCP -sTCP:LISTEN` parsed into listening-port list) and `daemon/cloudflaredResolve.ts` (cloudflared version detection). `daemon/tunnelRegistry.ts` — in-memory `TunnelRegistry` plus durable `~/.kvy/tunnels.json` pid journal. `daemon/previewTunnel.ts`'s `handlePreviewOpen` spawns `cloudflared tunnel --url http://localhost:<port> --no-autoupdate`. All four `preview.*` RPCs (`ports`/`tunnels`/`open`/`close`) registered in `machineRpc.ts`. Wired into `machineIntegration.ts`.

### Sleep inhibit

`daemon/sleepInhibit.ts`'s `createSleepInhibitManager` owns a `caffeinate` child (macOS only; `-s` = AC-only, `-i` = idle, both with `-w <daemon pid>` leak-safety guard). Registered as `sleepInhibit.get`/`sleepInhibit.set` in `machineRpc.ts`. Persisted via `sleepInhibit` field on `persistence.ts`'s `Settings`.

### Setup/Run scripts

Per-workspace store gains `setupScript`/`runScript` fields, surfaced via `kvy workspace config --setup-script/--run-script <script>`. Script DEFINITION stays CLI-only (design §12's local-consent boundary).

`gitWorktree.ts`'s `ensureBranchWorkspace` reports `createdWorktree: boolean`. `spawnEngine.ts` uses it to fire-and-forget `daemon/setupScript.ts`'s `runSetupScript` (cross-spawn under `daemon/shellCommand.ts`'s `buildShellInvocation` — `/bin/sh -c`/`cmd.exe /c` — with stdout/stderr to `~/.kvy/logs/setup-<hash>.log`).

`daemon/runStateStore.ts` (`~/.kvy/run-state.json`, same durability pattern) persists setup outcome and run state, keyed by worktree's real path. `daemon/runProcess.ts` is the subsystem's core: `resolveRunContext` (design-§12 auth gate + config-key resolver) backs `handleRunStart`/`handleRunStop`/`handleRunStatus`/`handleRunSetup`. `run.start` reuses `processLauncher.ts`'s `launchProviderProcess` (tmux-preferred), wrapping script with log-redirect. Liveness probed lazily via `tmux has-session`/`process.kill(pid,0)`.

`daemon/workspaceConfigRpc.ts`'s `handleWorkspaceGetConfig` is the read-only surface for web Workspace Settings UI.

## packages/server — @kvy/server

Fastify 5 app skeleton (zod type-provider, /health, pino logging) + Drizzle ORM schema (`src/db/schema.ts`) and migrations (`drizzle/`). Migration-on-boot runner.

**Auth:** JWT HS256 mint/verify, in-memory token cache, `app.authenticate` preHandler. `POST /v1/auth` challenge/response route, `POST /v1/auth/register` OAuth (Google/GitHub) sign-in, `/v1/auth/pair*` device-pairing routes.

**Real-time:** Socket.IO on `/v1/stream` (`src/app/socket.ts`, `src/app/socket/rpcHandler.ts`) fanning out through `src/app/events/eventRouter.ts` (room-scoped emitUpdate/emitEphemeral, presence ephemerals, backpressure coalescing).

**HTTP write path:** `src/app/routes/` (POST /v1/sessions, POST/GET .../messages, PUT .../metadata|state CAS, GET /v1/sync, GET /v1/sessions, POST /v1/machines — all idempotent/rate-limited) fanning out through `eventRouter` post-commit.

**Push dispatch:** `src/app/push/dispatch.ts`'s `buildPushDispatcher` — presence-suppressed via `eventRouter.hasActiveVisibleClient`, fans out to pluggable `channels/` registry (`webpush` fully wired via `web-push` + VAPID config, `telegram`/`ntfy` stubbed). Wired into `POST /v1/sessions/:id/status`'s `failed` transition and `POST /v1/sessions/:id/notify {kind: perm|question|done}`. `POST`/`DELETE /v1/push/subscribe` (`src/app/routes/push.ts`).

**Unmanaged sessions:** `POST /v1/unmanaged-sessions` (`src/app/routes/unmanagedSessions.ts` — adoption Tier 1): upsert-by-`(machineId, providerRef)` for daemon transcript indexer.

## packages/web — @kvy/web

Next.js PWA (App Router, static export). Tailwind + shadcn/ui, dark default theme.

**Auth pages:** OAuth sign-in, key generation, recovery-code export, pairing-approve (src/app/signin, src/app/auth, src/app/pair).

**Crypto & sync:** Crypto worker bridge (`src/crypto/`), transcript reducer (`src/sync/reducer/`) — folds `SessionEnvelope[]` into ordered `RenderItem[]`. `apiSocket` (user-scoped Socket.IO client with infinite reconnect + app-state reporting). `src/sync/engine.ts` — sync engine (design §8.1/§9.1, headerSeq structural fast-path + per-session msgSeq message fast-path against TanStack Query cache).

**Home screen:** `src/features/session-list/` — sessions grouped by workspace, derived status dot, machine online/offline badges. Takes injectable `UseSessionListSnapshot` hook.

**Session timeline:** `/session/[id]` (`src/components/timeline/`) — virtualized `Timeline` rendering `RenderItem[]` as structured chat transcript. Markdown via unified/remark/shiki pipeline compiled to React elements (no `dangerouslySetInnerHTML`). Collapsible thinking blocks, `ToolCard` registry (Bash, Edit/Write/MultiEdit+diff, Read, Grep/Glob, TodoWrite checklist, Task/subagent nesting, MCP generic fallback). Runs off demo fixture pending sync engine wiring.

**Web Push:** `src/push/` — `subscribeToPush`/`unsubscribeFromPush` against injectable `PushEnvironment`/`PushApiPort`. `public/sw.js` — static service worker (push shows generic kind-keyed notification, notificationclick deep-links to `/session/<id>/`). Wired behind Settings → Notifications.

**Settings:** Single dialog (not routes) — `src/features/settings/sections.tsx`'s `SETTINGS_SECTIONS` registry (Agent/Appearance/Git/Providers/Machines/Notifications/Recovery/Support). `src/components/settings-dialog.tsx` renders it (wide left-nav desktop, drill-in bottom sheet mobile). Opened from sidebar footer's account menu (`src/components/nav-user.tsx`).

**Session control:** `src/features/session-control/` — `Composer` (TanStack useMutation → message RPC, optimistic insert), `PermCard` (Allow/Deny/Allow-for-session/mode-switch + edit-preview diff), `ControlBar` (interrupt, permission-mode selector, take-control). Derived attention (perm∨question∨done-unseen vs per-device last-seen) driving tab-title/favicon badges. `sync/sessionRpc.ts` — typed caller-side client for five session RPC methods.

**Git panel:** `src/features/git-diff/` — `ChangedFilesList` + `UnifiedDiffViewer` (parses `git diff` unified-diff text via `lib/unifiedDiff.ts`, shiki-highlights via `lib/diffHighlight.ts`). `GitToolbar` (inline branch rename, one-click commit — defaults `git add -A` — Push, Force Push). `CompareAgainstSelect` (workspace default / HEAD / any local branch / free-text ref). Driven by `use-git-panel.ts` (three queries: `git.status`, `git.diff`, `git.branches`; three mutations: commit/push/renameBranch). Mounted at `/session/[id]/git/`.

**New Session wizard:** `src/features/new-session/`, `/session/new/` — five-step flow (machine → directory picker → optional session-import → options → review). `wizard-state.ts`'s pure step/form logic, injectable `NewSessionActions` seam.

**Git worktree isolation:** `branchMode` on options step — "Repo root" / "New branch" (recommended, auto-generated `wf/<yyyyMMdd>-<4 chars>` via `auto-branch.ts`) / "Existing branch". Backed by `git.branches` machine RPC. `git-defaults.ts` backs Settings → Git section.

**GitHub checks:** `src/features/github-checks/` — `ChecksPanel` + `CheckRunRow` (status/conclusion icon, relative duration, external detailsUrl link). Driven by `use-checks-panel.ts`'s `useQuery` (60s refetchInterval). Mounted at `/session/[id]/checks/`.

**Preview tunnels:** `src/features/preview/` — `PreviewPanel` (header "N ports detected · M tunnels active"), `PortsList` (per-port Open button, or tunnel URL + Copy/Preview/Open-in-new-tab/Close), `OpenTunnelConfirmDialog` (per-open consent gate). Driven by `use-preview-panel.ts` (two queries: `preview.ports` 15s, `preview.tunnels` 5s; open/close mutations). Mounted at `/session/[id]/preview/`.

**Machine settings:** `src/features/machine-settings/` — `SleepInhibitCard` per machine (Off / While on Power / Always). Driven by `use-machine-settings.ts` (useQuery for `sleepInhibit.get` + useMutation for `sleepInhibit.set`).

**Setup/Run panel:** `src/features/run-panel/` — `RunPanel`/`RunPanelBody` (play/stop button, run-state badge, setup section with exit code + "Re-run setup" button, monospace log tail). Driven by `use-run-panel.ts` (`workspace.getConfig` once per worktree, `run.status` polled every 5s while running). Mounted at `/session/[id]/run/`.
