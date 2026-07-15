# Research: The `superset/` Codebase

> Deep-dive analysis of the repository at `vibe-ide/superset/` — what it is, how it works, and its notable design decisions. Compiled 2026-07-13 from a full multi-pass exploration of the source tree (~5,050 TypeScript files, ~100 MB working copy).

---

## 1. Executive Summary

**Superset** ([superset.sh](https://superset.sh), GitHub `superset-sh/superset`) is **"The Code Editor for AI Agents"** — an open-source (Elastic License 2.0) macOS Electron desktop app for orchestrating **swarms of CLI coding agents** (Claude Code, Codex, Gemini CLI, Cursor Agent, Amp, OpenCode, Droid, Copilot CLI, Mastra Code, Pi, Polygraph, …) running **in parallel, each isolated in its own git worktree**.

The core value proposition: run 10+ agents simultaneously on your machine without them stepping on each other, monitor them from one place, get notified when one needs attention, review their diffs in a built-in viewer, and hand off any workspace to your editor/terminal with one click. "Wait less, ship more."

It is far more than an Electron app, though. The monorepo contains a full product ecosystem:

- **Desktop app** (Electron, the flagship — 2,938 TS files)
- **A per-machine background daemon** (`host-service`) plus a **PTY-owning daemon** (`pty-daemon`) so terminals and agent sessions survive app restarts *and even binary upgrades*
- **A cloud control plane** (Next.js 16 API, Neon Postgres, better-auth, tRPC) with **local-first sync via Electric SQL**
- **A globally distributed relay** (Hono on Fly.io, 7 regions) that tunnels remote clients to your laptop
- **A mobile app** (Expo/React Native, iOS-only) to monitor and drive agents from your phone
- **A CLI** (`superset`), a **public TypeScript SDK**, and **hosted MCP servers** so other agents/tools can drive Superset itself
- Marketing site, docs site, admin dashboard, Discord→Linear triage bot

Team: Avi, Kiet, Satya (@avimakesrobots, @flyakiet, @saddle_paddle). Version at this snapshot: **1.15.0**.

> **Snapshot caveat**: this copy has no `.git` index, and several dot-directories referenced by the docs (`.github/workflows`, `.agents/`, `.superset/`, `.mcp.json`, `plans/`) are absent from the checkout. Their behavior is documented below from references in files that do exist.

---

## 2. Repo at a Glance

| | |
|---|---|
| **Monorepo** | Bun 1.3.14 (workspaces) + Turborepo 2.9 |
| **Language** | TypeScript 6.0 everywhere (strict + `noUncheckedIndexedAccess`); plain JS forbidden by `checkJs` |
| **Lint/format** | Biome 2.4 at root level (speed); CI fails on *warnings*, not just errors |
| **UI** | React 19, Tailwind CSS v4, shadcn/ui |
| **Data (cloud)** | Drizzle ORM + Neon Postgres (serverless driver), Electric SQL for sync |
| **Data (local)** | better-sqlite3 + Drizzle (multiple separate SQLite DBs) |
| **RPC** | tRPC everywhere — over HTTP (cloud), over Electron IPC (`trpc-electron`), over a relay tunnel |
| **License** | Elastic License 2.0 (source-available) |
| **Platform** | macOS only for now (Windows/Linux untested) |

### Workspace layout (by size, TS file count)

```
apps/
  desktop        2938   Electron app (the product)
  mobile          433   Expo/React Native iOS app
  marketing       216   superset.sh (Next.js)
  web             121   app.superset.sh — browser companion
  api              89   Cloud control-plane API (Next.js 16)
  docs             63   docs.superset.sh (Fumadocs)
  admin            50   Internal analytics dashboard
  relay            14   Fly.io WebSocket tunnel (Hono)
  electric-proxy    5   Cloudflare Worker auth gateway for Electric SQL
  discord-triage    3   Discord → Linear support bot
  streams           0   Empty placeholder

packages/
  host-service    316   Per-machine local daemon (Hono + tRPC + SQLite)
  ui              123   shadcn design system + ai-elements
  cli              84    `superset` CLI (Ink/React, Bun-compiled binaries)
  trpc             81   Shared cloud tRPC router (19 sub-routers)
  chat             76   Built-in agent chat runtime (Mastra-based)
  shared           72   Cross-cutting types/utils (~40 subpath exports)
  sdk              49   Public Stainless-generated SDK (@superset_sh/sdk)
  mcp / mcp-v2   45/36  Hosted MCP servers (v1 legacy, v2 current)
  panes            42   Generic tabs/splits layout engine
  pty-daemon       32   Standalone PTY-owning daemon process
  workspace-fs     24   Isomorphic filesystem service/protocol
  db               20   Cloud Postgres schema (Drizzle)
  email            25   React Email templates (Resend)
  session-protocol 18   ACP agent-session wire contract
  workspace-client 17   React client → host-service (desktop/web)
  cli-framework    15   File-routed typed CLI framework
  auth             13   better-auth configuration
  port-scanner      9   Dev-server port detection
  local-db          6   Desktop app's SQLite schema
  host-client       6   Framework-free host client (mobile/web)
  macos-process-metrics 1  N-API addon: real memory footprints

tooling/typescript      Shared tsconfig presets (base/electron/next/internal)
```

`AGENTS.md` is the single source of truth for agent contributors; `CLAUDE.md`, `WARP.md`, and `CODEX.md` are all one-line `@AGENTS.md` redirects — a nice cross-agent-tool convention.

---

## 3. What the Product Does

From the docs site (`apps/docs/content/docs/`) and marketing site:

- **Workspaces** — every task gets an isolated git worktree + branch. Create from a prompt, a branch, or a GitHub PR.
- **Parallel agents** — launch any CLI agent into a workspace terminal via **presets** (per-agent command templates, models, prompt transports). "Orchestrate 100+ coding agents in parallel."
- **Attention system** — agent hooks report lifecycle events (started / needs permission / has question / finished); the app surfaces colored status dots, dock badges, sounds, and native notifications, suppressed when you're already looking at that pane.
- **Built-in diff viewer** with inline comments you can **dispatch to an agent** ("fix this line"), a real CodeMirror editor, staging/commit/push/PR creation via `gh`.
- **Built-in terminal** (xterm.js) with tabs/splits, presets bar, and durable sessions.
- **Built-in browser panes** (Electron webview + bundled extension) and port detection/forwarding for dev servers.
- **Remote access** — sign in from web/mobile, reach your machine through the relay, spawn workspaces and chat with agents from your phone, wake sleeping hosts.
- **Automations** — RRULE-scheduled agent runs (cron-for-agents) dispatched from the cloud to your machine.
- **Integrations** — GitHub (App + webhooks), Linear (task sync), Slack (a Slack agent that drives Superset via MCP), Stripe billing.
- **MCP server** — external agents (Claude Desktop etc.) can control Superset via a hosted OAuth-protected MCP endpoint.
- **Setup/teardown scripts** — `.superset/config.json` (`setup`, `teardown`, `run` command arrays) automates env copying and dependency installs per workspace; env vars `SUPERSET_WORKSPACE_NAME`, `SUPERSET_ROOT_PATH` injected.
- **Open anywhere** — one-click handoff of a worktree to VS Code, Cursor, Xcode, JetBrains, or a terminal.

---

## 4. System Architecture (the big picture)

```
                       ┌─────────────────────────── CLOUD ───────────────────────────┐
                       │                                                              │
  ┌──────────┐  HTTPS  │  apps/api (Next.js 16)          Neon Postgres (Drizzle)      │
  │ Web app  │────────▶│   • tRPC appRouter (19 routers)  ├─ auth schema (better-auth)│
  │ Mobile   │         │   • better-auth + OAuth/OIDC     ├─ app schema (tasks, v2_*) │
  │ MCP      │         │   • MCP v1/v2 endpoints          │                           │
  │ clients  │         │   • GitHub/Linear/Slack/Stripe   │  Electric SQL ◀─ logical  │
  └────┬─────┘         │   • Automations (QStash, RRULE)  │  (sync engine)  replication│
       │               │                                  ▼                           │
       │               │  apps/electric-proxy (CF Worker): JWT + org row-level filter │
       │               └──────────────────────────────────┬───────────────────────────┘
       │                                                  │  Electric "shapes" (SSE)
       │    ┌───────── apps/relay (Hono, Fly.io ×7 regions) ─────────┐
       └───▶│  /hosts/{orgId:machineId}/trpc/*  + WS tunnel          │
            │  Upstash Redis host directory, fly-replay cross-region │
            └───────────────┬────────────────────────────────────────┘
                            │ persistent WS tunnel (tunnel-protocol envelopes)
┌───────────────────────────┼──────────────── YOUR MACHINE ────────────────────────────┐
│                           ▼                                                          │
│  apps/desktop (Electron)                                                             │
│  ├─ renderer (React 19): panes UI, xterm, diff viewer, chat, Electric collections    │
│  ├─ main process: tRPC-over-IPC, local SQLite (local-db), worktree lifecycle,        │
│  │   notifications server, auto-update, tray, agent hook installation                │
│  ├─ terminal-host (v1 PTY daemon, Unix socket + NDJSON)  ← legacy local terminals    │
│  └─ HostServiceCoordinator ── spawns one per org ──▶                                 │
│       packages/host-service (Hono/tRPC daemon, own SQLite)                           │
│       ├─ git worktrees, workspaces, PRs, filesystem, ports, chat, ACP sessions       │
│       ├─ relay tunnel client (remote access)                                         │
│       └─ DaemonSupervisor ──▶ packages/pty-daemon (detached process)                 │
│             • owns node-pty PTYs, Unix socket 0600, binary framed protocol           │
│             • survives host-service restarts (adoption) AND its own binary           │
│               upgrades (PTY master-fd handoff to successor process!)                 │
│                     └──▶ your shells → claude / codex / cursor-agent / …             │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Key relationships:

- **Desktop → host-service**: localhost HTTP/WS with a pre-shared secret; deterministic per-org port (FNV-1a hash of orgId into 48000–48999) so the CLI can find it too (plus on-disk manifests).
- **Anything remote → host-service**: through the relay using routing key `orgId:machineId`, JWT-authenticated (RS256, JWKS served by the API).
- **Reads** of cloud data are synced via Electric SQL shapes into client-side SQLite; **writes** go through tRPC mutations that return a Postgres `txid`, and clients wait for that txid to round-trip through Electric before considering the write durable — an elegant optimistic-write/convergence pattern.
- **v1 → v2 migration in flight**: the codebase visibly contains two generations (legacy "devices"/local-only workspaces vs. the v2 "hosts" model where workspace records are host-owned and synced), with migration state tracking and guard scripts enforcing that new code uses the v2 path.

---

## 5. Desktop App (`apps/desktop`)

### 5.1 Process topology

`electron.vite.config.ts` emits **six separate main-process bundles** — the app is really a small distributed system on one machine:

1. `index` — Electron main process
2. `terminal-host` — v1 persistent PTY daemon (survives app restarts)
3. `pty-subprocess` — one child per v1 terminal
4. `git-task-worker` — worker thread for heavy git/status computation
5. `host-service` — the per-org daemon (entry shim around `packages/host-service`)
6. `pty-daemon` — entry shim around `packages/pty-daemon`

All child processes run as `ELECTRON_RUN_AS_NODE=1` under the bundled Electron Node, and every one has a **parent-PID watchdog** so orphans self-exit if Electron dies.

### 5.2 Main process highlights

- **IPC is 100% tRPC** via `trpc-electron` (`src/lib/trpc/routers/` — ~35 sub-routers: workspaces, terminal, changes, notifications, autoUpdate, settings, browser, ports, resourceMetrics, hostServiceCoordinator, …). Subscriptions must use tRPC `observable`s (async generators unsupported — a documented gotcha in `apps/desktop/AGENTS.md`).
- **Workspace creation is fast-path + background**: `workspaces.create` inserts DB rows and returns instantly (`isInitializing: true`); the real `git worktree add` streams progress steps (`syncing → fetching → creating_worktree → copying_config → ready`) via `workspace-init.ts`, with a per-project mutex serializing git operations and robust cancellation/cleanup. Branch names come from a configurable prefix + sanitized/AI-generated names (`friendly-words`).
- **`.superset/config.json`** merge is three-tier: user override (`~/.superset/projects/<id>/config.json`) > worktree config > main-repo config, plus a gitignored `config.local.json` overlay that can `before`/`after`/replace each key. `.superset/` is copied into new worktrees (worktrees don't inherit gitignored files). Setup auto-detection scans lockfiles (bun/pnpm/yarn/npm, poetry/uv, cargo, go, bundler, composer, docker-compose, `.nvmrc`, `.env.example`) to suggest setup commands.
- **PR-based workspaces**: `createFromPr` uses `gh pr checkout` inside a fresh worktree to correctly resolve fork remotes.
- **Git hardening**: worktree deletion renames to a temp path then background `rm -rf` (macOS `fs.rm` hangs); `git worktree add` tolerates failing post-checkout hooks if the worktree actually exists on disk; status parsing uses `--porcelain=v2 --no-optional-locks` with caching.
- **Agent integration** (`src/main/lib/agent-setup/`): a declarative capability table per agent writes **wrapper shims into `~/.superset/bin`** (intercepting `claude`, `codex`, etc.) and installs agent-native hooks (merged into `~/.claude/settings.json` for Claude, `hooks.json` for Codex, plugins for OpenCode/Amp/Pi, hook scripts for Cursor/Gemini/Copilot/Vibe). All hooks funnel into a shared `notify.sh` that curls a local Express server (`127.0.0.1:<port>/hook/complete`) with pane/workspace/session/eventType params — this is the **entire "agent needs attention" mechanism**.
- **Shell wrappers**: rather than editing user rc files, Superset launches shells with `ZDOTDIR`/`--rcfile` wrappers that source the real configs, prepend `~/.superset/bin` to PATH, re-assert PATH after mise/asdf, and emit dual OSC prompt-ready markers (`OSC 777` legacy + FinalTerm `OSC 133;A`).
- **Notifications** (`NotificationManager`): native macOS notifications for "Awaiting Response" (permission/question) and "Agent Complete", suppressed if the pane is visible and focused, deduped per session, with custom ringtones; clicking focuses the exact tab/pane.
- **Persistence**: three separate stores — local SQLite `~/.superset/local.db` (projects/worktrees/workspaces/settings via `packages/local-db`, 42 migrations), a JSON app-state file (tab/pane layout, theme, last-run version), and a second SQLite (`tanstack-db.sqlite`) backing Electric-synced collections for the renderer, with WAL everywhere for crash durability and redundant-write suppression to cut churn.
- **Auto-update**: electron-updater, stable channel from GitHub latest, canary channel from a rolling `desktop-canary` tag with `allowDowngrade`. Crucially, **update installs do NOT tear down the terminal daemon** — PTYs survive and reattach after the app restarts.
- **macOS specificities**: `superset://` deep links (auth + navigation), custom privileged protocols `superset-icon://` and `superset-font://` (serving SF Mono under CSP), Apple Events/Local Network/Full Disk Access permission flows, tray with live per-org host-service status, and a collection of Sequoia GPU-compositor workarounds. Session partition `persist:superset` forces bearer-token (not cookie) auth.

### 5.3 Renderer (React UI)

- **TanStack Router** with Next-style file conventions (`page.tsx`/`layout.tsx`), hash-based *persistent* history (survives reloads in file:// context). Dark theme is the default (`:root` is dark; `.light` overrides).
- **Three state tiers**:
  1. **TanStack DB + Electric SQL collections** (`CollectionsProvider/collections.ts`) — per-org collection sets over ~25 synced tables, persisted to main-process SQLite over IPC, with optimistic writes reconciled by Electric txid round-trip, shared 401→JWT-refresh gating, and read-healing wrappers for malformed persisted rows. The repo-wide **cache-first rule** (AGENTS.md #9): always render existing rows; `isReady` only disambiguates loading-vs-empty.
  2. **Two tRPC planes** — `electronTrpc` (IPC → main process, IndexedDB-persisted query cache) and `workspaceTrpc` (`@superset/workspace-client` → host-service over WS/relay with a typed realtime event bus).
  3. **Zustand** for ephemeral UI state (theme, notifications-seen, editor buffers, drag state, command-palette intents).
- **The pane system** (`packages/panes`) is a standout: a generic, content-agnostic tabs+splits engine — binary-tree layout model, Zustand vanilla store, drag-and-drop between tabs with subtree grafting, "smart open" (reuse unpinned same-kind pane, else split right), pin protection, and a `PaneRegistry` where the desktop injects pane kinds: `file`, `terminal`, `chat`, `browser`, `devtools`, `diff`, `comment`. Layouts are persisted per-workspace into local-first storage and survive restarts.
- **Terminal UI**: xterm 6 beta with WebGL/search/image/ligature addons, kitty keyboard protocol, buffer serialization to `localStorage` for instant restore, a **terminal parking lot** (keeps xterm DOM alive off-screen when panes background), binary-frame WebSocket transport with reconnect/diagnostics, clickable file/URL links resolved into panes, and a TipTap-based rich input overlay.
- **Diff viewer**: `@pierre/diffs` CodeView + `@pierre/trees`, GitHub-style viewed-file checkmarks, in-diff search, base-branch/commit-range selection, and **inline comment threads that can be dispatched to an agent** (pick agent, pick placement split/new-tab, runs `agents.run` into a terminal pane). File editing is a real CodeMirror 6 editor with a shared dirty-document store, external-change watching, and save-on-close guards.
- **Chat pane**: full agent chat surface on AI SDK v6 + `packages/ui/ai-elements` (~45 chat-specific components: reasoning, tool calls, plans, checkpoints, `user-question-tool`, file-diff-tool…), TipTap composer with @-mentions, slash-command preview (discovered from `.claude/commands`), attachments, model picker, MCP controls.
- **Attention/status is derived, never stored**: terminal agent status maps host binding events (`Start→working`, `PermissionRequest→permission`, `Stop→review-if-unseen-else-idle`) against a persisted "last seen" timestamp — avoiding stale-badge bugs by construction.
- **Keyboard system**: ~55 typed hotkey IDs, layout-aware logical bindings via `native-keymap` (⌘Z works on QWERTZ), user overrides with recording UI, and a modular command palette (`cmdk`) with provider modules, sub-palettes, and a fuzzy Quick Open (fuse.js).

---

## 6. The Local Daemon Layer (the most distinctive engineering)

### 6.1 `packages/host-service` — the machine's local backend

A standalone, **Electron-free** Hono + tRPC daemon (a test enforces zero Electron imports), one per organization, with its own SQLite DB. It owns: workspaces/worktrees (v2 model), git operations, a `GitWatcher`, GitHub PRs, filesystem service, port detection, terminal sessions, chat runtime (Mastra), and **ACP agent sessions**. Exposes ~24 tRPC routers plus WebSocket routes (`/events`, `/terminal/*`, `/acp-sessions/*`).

Pluggable **providers** cleanly split local vs. cloud deployment: auth (JWT / device-key / PSK), git credentials (local vs. cloud askpass), and model providers (local API keys vs. cloud).

It connects out to the relay (`connectRelay`) so the same tRPC surface is reachable remotely, and supervises the pty-daemon.

### 6.2 `packages/pty-daemon` — PTYs that refuse to die

A detached process that owns all node-pty PTYs. Runs under **Node, not Bun** (node-pty master-fd handling is incompatible with Bun 1.3 — Bun is only the build tool). Notable properties:

- **Protocol v2**: length-prefixed binary frames `[u32 total][u32 jsonLen][JSON][binary tail]` — PTY bytes ride the binary tail, never base64 (a test, `no-encoding-hops.test.ts`, guards this).
- **Auth = filesystem**: Unix socket mode 0600, no in-band tokens. Socket path hashes the orgId to fit Darwin's 104-byte `sun_path` limit.
- **Survives host-service restarts** trivially (separate process; clients re-subscribe).
- **Survives its own upgrades** via a **PTY master-fd handoff**: the old daemon snapshots state, spawns the successor with live PTY file descriptors inherited through the stdio array + an IPC ack, and only exits once the successor has adopted everything — your shells and their PIDs never notice. Handoff mode is selected by argv (not env) specifically because esbuild dead-code-elimination would strip an env-gated branch.
- **Crash circuit breaker** (3 crashes/60 s), version-drift detection via `hello`/`hello-ack` handshake against a compile-time-derived expected version, and a "restart to update" UX rather than force-restarts.
- Scrollback: an in-memory 64 KB ring buffer per session — just enough to redraw a screen on attach; real scrollback is xterm's job in the renderer.
- Default close signal is **SIGHUP** (not SIGTERM) so interactive `zsh -l` shells actually die.

Interestingly, the desktop currently ships **two coexisting PTY systems**: the older `terminal-host` (NDJSON over Unix socket, xterm-headless state, cold-restore from history after reboot) used for local v1 terminals, and the host-service/pty-daemon stack used for v2/remote/ACP — abstracted behind a provider-neutral `TerminalRuntime` registry. This is a live migration, not an accident.

### 6.3 `packages/session-protocol` — durable agent sessions (ACP)

The wire/state contract for **Agent Client Protocol** sessions (external agents like Claude Code running under the host service):

- Sessions have status `starting | idle | running | awaiting_permission | offline | dead`, where `offline` means "persisted but no live adapter after a host restart — resurrect on demand via ACP `session/load`".
- Every update is journaled with a **per-session gapless monotonic `seq`**; clients subscribe with a cursor, dedupe at-least-once delivery, detect gaps, and resync on `reset` frames (the server journal is a 5,000-entry ring buffer).
- A `fold()` function turns the envelope stream into renderable timeline items (messages, nested tool calls/subagents, permission views); React hooks (`useAcpSession`) sit on top.
- `prompt` acks *admission*, not completion — turns run long; completion is observed on the stream.

This layer is what lets the mobile app attach to a running Claude Code session mid-turn, answer a permission prompt, and detach — with the session surviving app and host restarts.

### 6.4 Supporting packages

- **workspace-fs**: isomorphic FS service (list/read/write-with-precondition/search/watch) with a `workspace-fs://` URI scheme; ripgrep + @parcel/watcher on the host side, transport-injected client side.
- **workspace-client** (desktop/web) vs **host-client** (mobile/web): the former imports host-service router *types* directly (tight coupling, richest DX); the latter is deliberately framework-free fetch+SuperJSON so React Native never pulls in `better-sqlite3`/`node-pty` types. Both re-sign JWTs per reconnect and run a `_whoowns` relay-affinity preflight.
- **port-scanner**: polls `lsof`/procfs for listening ports per terminal process tree, accelerated by regexes over terminal output ("Local: http://…" triggers a fast 500 ms scan).
- **macos-process-metrics**: an N-API addon calling `proc_pid_rusage()` for `ri_phys_footprint` — the same number Activity Monitor shows, unlike RSS — to power the resource monitor.
- **shared**: ~40 subpath exports — host identity (HMAC-salted machine IDs, PII-sanitized hostnames), the relay tunnel protocol, the agent catalog/presets/launch templates, terminal wheel/link/prompt-ready scanners, workspace naming, feature flags.

---

## 7. Cloud Backend

### 7.1 `apps/api` — control plane (Next.js 16 App Router)

Not a "web app" — it's the API host: tRPC endpoint, better-auth catch-all, **hosted MCP servers** (v1 + v2, over `WebStandardStreamableHTTPServerTransport` with OAuth), OAuth2/OIDC discovery endpoints (the API is a spec-compliant authorization server for MCP clients, with dynamic client registration), GitHub App install/webhooks, Linear OAuth/webhooks/sync jobs, an extensive Slack integration (events, interactions, an agent that answers in Slack using MCP tools), Stripe webhooks, chat/LLM streaming routes (Anthropic SDK + durable streams + Tavily web search), automations dispatch (RRULE scheduling; jobs queued through Upstash QStash), and host presence sync. Next 16 note: middleware is `proxy.ts` (renamed from `middleware.ts`), enforced repo-wide.

### 7.2 Data layer

- **`packages/db`**: two Drizzle clients — `db` (Neon HTTP) and `dbWs` (WebSocket pool for transactions). Schemas: `auth` (better-auth: users, sessions, organizations, members, teams, invitations, OAuth-provider tables, API keys with a *generated stored column* extracting orgId from JSON metadata for Electric-friendly filtering, device codes, JWKS) and `public` (tasks + statuses with Linear/GitHub sync snapshots, integration connections, subscriptions, chat sessions/attachments, automations + runs + versioned prompts, and the v2 tables: `v2_hosts` (PK org+machineId, wake commands), `v2_clients`, `v2_users_hosts` (owner/member roles), `v2_projects`, `v2_workspaces`). Everything org-scoped with cascade deletes. Migrations are Drizzle-generated on Neon branches, never hand-edited (a hard rule).
- **`packages/auth`**: better-auth with GitHub/Google social login, 30-day DB sessions, org plugin (teams, max 25, auto personal org, domain-based auto-enroll), Stripe plugin (seat-based pro/enterprise with proration on member add/remove), JWT plugin (RS256, 1 h, org memberships embedded in claims), an OAuth-provider plugin (Superset as IdP for MCP), Expo plugin for mobile, and `mintUserJwt()` for headless services (automations) to act on behalf of users.

### 7.3 Electric SQL local-first sync

The full pipeline: Postgres logical replication → Electric 1.7 → **`apps/electric-proxy`** (Cloudflare Worker) → clients.

The Worker is the security boundary: verifies the RS256 JWT against the API's JWKS, checks org membership, and **rewrites every shape request with a server-side `WHERE organization_id = $1` filter** from a ~30-table whitelist, plus column restrictions that ensure token columns (API keys, integration tokens) never sync to clients. Clients (desktop renderer, mobile) subscribe to shapes and persist rows into SQLite; writes flow through tRPC and reconcile by txid. A Caddy HTTP/2 proxy is required in dev because 10+ Electric SSE streams exhaust the browser's 6-connection HTTP/1.1 limit.

### 7.4 `apps/relay` — remote access tunnel

Hono + Bun on Fly.io, **7 machines in 7 regions** (sjc/iad/fra/nrt/sin/syd/gru). Hosts open a persistent WebSocket tunnel (`/tunnel?hostId=…&token=JWT`); clients call `/hosts/{orgId:machineId}/trpc/*` or upgrade WebSockets. Cross-region routing uses an Upstash Redis host directory (90 s TTL, atomic Lua scripts) + `fly-replay` headers; WS upgrades (which can't be replayed) are bridged over Fly's private IPv6 6PN network. Access control: JWT org check short-circuit, then a `host.checkAccess` call to the API with an LRU allow/deny cache. TCP_NODELAY for interactive latency; graceful drain on deploy.

### 7.5 Other cloud apps

- **`apps/web`** — browser companion: auth flows, OAuth consent for MCP, remote workspace/agent viewing with an in-browser xterm and mobile terminal input, integrations settings, CLI/desktop auth handoff.
- **`apps/admin`** — internal, gated to company email domains: WAU/retention/funnel/revenue analytics, user management.
- **`apps/discord-triage`** — Discord bot filing support messages into Linear Triage, mirroring attachments (Discord CDN URLs expire), optionally rewriting tickets with Claude (vision for screenshots); must run single-machine to avoid double-filing.
- **`apps/streams`** — empty placeholder (durable chat streaming currently lives in the API via `@durable-streams/client`).

---

## 8. CLI, SDK, MCP, Chat Runtime, Mobile

### 8.1 `superset` CLI (`packages/cli` + `packages/cli-framework`)

Ink/React CLI compiled to standalone Bun binaries (darwin-arm64, linux-x64), built on an in-house **file-routed, fully typed CLI framework** (directory tree of `command.ts`/`meta.ts` → command tree; typed options; middleware that makes `ctx.api` a compile-time error in unauthenticated commands; "did you mean" suggestions).

Capabilities: OAuth device-flow login; **start/stop/status of the host service** (the CLI ships a `superset-host` binary — you can run a headless Superset host on a server with no desktop app); workspace create (including `--pr`, `--agent claude --prompt "..."`, attachments); terminals/agents/tasks/automations/projects/orgs CRUD; `hosts wake` (remote wake); and a self-updater that atomically replaces the install root from a rolling `cli-latest` GitHub release tag.

Host targeting mirrors the whole architecture: local manifest + bearer token for the local host, relay URL + JWT for remote hosts.

### 8.2 Public SDK (`packages/sdk`)

`@superset_sh/sdk` — Apache-2.0, **Stainless-generated** from the OpenAPI spec, mirroring the CLI 1:1 (tasks, workspaces, projects, hosts, automations, agents, terminals). `sk_live_…` API keys. The one package with a permissive license.

### 8.3 Built-in chat agent (`packages/chat`)

Superset isn't only a launcher for other CLIs — it embeds its own agent, built on **Mastra** + a harness package `mastracode` (published upstream; the repo explicitly forbids fork tarballs). `ChatRuntimeService` manages per-session Mastra memory, model switching, hooks, and MCP tools (it loads Superset's own cloud MCP into the agent). The harness's question mechanism is the **`ask_user` tool** mandated in AGENTS.md — questions surface as interactive overlays in desktop/mobile rather than plain text. Slash commands are discovered from `.claude/commands` / `.agents/commands` (project then global), with frontmatter, positional/named argument substitution, and built-ins (`/new`, `/model`, `/mcp`, `/review`). Servable three ways: embedded in desktop, as tRPC, or as a Hono server.

### 8.4 Hosted MCP servers (`packages/mcp`, `packages/mcp-v2`)

Superset exposes *itself* as an MCP server so any MCP client can orchestrate agents:

- **v1** (`/api/agent/mcp`): snake_case tools, "device" terminology, direct DB access.
- **v2** (`/api/v2/agent/mcp`): the re-architecture — `defineTool` with Zod I/O schemas, `resource_action` naming, cloud operations via a synthesized better-auth session calling the tRPC router in-process, and **host-local operations tunneled through the relay** to the owning machine's host service. Full toolset: tasks, workspaces, agents, terminals, automations, hosts, projects, members. Used by the Slack agent internally.

### 8.5 Mobile (`apps/mobile`)

Expo/React Native, **iOS-only by policy**. Sign in (better-auth Expo), see all hosts/workspaces (Electric collections), **spawn a workspace + agent from your phone** (project/branch/model pickers), chat with built-in sessions *and* ACP sessions (external CLI agents) via the shared `host-client`/`session-protocol` packages, answer `ask_user`/permission prompts, and review commits/diffs/changed files — all over the relay. Convention: `app/` owns routing only; `screens/` owns UI/logic.

---

## 9. Developer Experience, Tooling, and Release Engineering

### 9.1 Local dev

One command: `./.superset/setup.local.sh` + `bun run dev`. Docker Compose brings up Postgres 17 (logical WAL) + a local Neon HTTP proxy (so the Neon serverless driver works locally) + Electric + Redis + an Upstash REST shim; `.env.local.example` ships fake-but-valid values so env validation passes with zero real accounts; a dev account (`admin@local.test`/`supersetdev`, "Sign in as dev" button) is seeded, gated to `NODE_ENV=development`. Port ranges are allocated **per git worktree** so multiple Superset workspaces of the Superset repo itself can run simultaneously — the team dogfoods its own product to build the product.

### 9.2 Guard scripts (invariants enforced in CI)

`scripts/lint.sh` fails on *any* Biome diagnostic, then runs four bespoke guards — each encoding a hard-won lesson:

- **check-desktop-git-env.sh / check-simple-git-usage.sh**: all git invocations must route through wrappers that inherit the login-shell PATH (Electron apps launched from Dock don't get your shell env).
- **check-git-ref-strings.sh**: bans `startsWith("origin/")`-style string munging outside one `refs.ts` module — because a local branch can legally be *named* `origin/foo`; callers must use a discriminated `ResolvedRef` type.
- **check-cloud-workspace-usage.sh**: CLI/SDK must not mutate cloud workspace records directly — workspaces are host-owned; clients must go through the owning host via the relay.

Other hardening: `bunfig.toml` sets `minimumReleaseAge = 259200` (a 3-day cooldown before new dependency versions are installable — supply-chain protection) and isolated linker mode; `sherif` validates workspace consistency on postinstall; renderer code is sandboxed by Biome rules banning `node:*` and host-only imports.

### 9.3 Release system (`scripts/release/`)

Desktop, host-service, and CLI share **one unified plain-semver version** (currently 1.15.0), CI-gated by `check:versions`. CLI hotfixes may lead desktop by a patch within the same minor. **No prerelease suffixes ever** — a suffix would sort below the release and break both `superset update` and the host-service minimum-version floor. The pty-daemon versions independently on a 0.x track, with a hard block (`guardDaemonBump`) if its source changed since the last bump. Releases are cut from dedicated release branches; tags (`desktop-v*`, `cli-v*`) trigger GitHub workflows; desktop releases draft by default and publishing fires a lockstep CLI release. Canary builds go to a rolling `desktop-canary` tag. The whole system is unit-tested TypeScript run directly by Bun.

### 9.4 Multi-agent development conventions

The repo is built to be worked on *by* coding agents: `AGENTS.md` as the canonical guide with `CLAUDE.md`/`WARP.md`/`CODEX.md` redirects; shared commands/skills in `.agents/` symlinked into `.claude/` and `.cursor/`; a shared `.mcp.json` mirrored into Codex TOML and OpenCode JSON configs (Neon, Linear, Sentry, PostHog, and Superset's own MCP); strict component-folder conventions (one folder per component, co-located tests, barrel exports); PR titles must be conventional commits (squash-merge uses the title); plans live in `plans/`, never at app roots.

---

## 10. The Most Notable Design Decisions (ranked)

1. **PTY master-fd handoff across daemon upgrades** — terminals (and the agents running in them) survive not just app restarts but upgrades of the PTY daemon binary itself, via fd inheritance + snapshot adoption + IPC ack, with restore-on-failure. Argv-gated because esbuild DCE would strip env-gated code. This is rare engineering for a desktop app.
2. **Layered process isolation on the local machine** — Electron main / terminal-host / per-org host-service / pty-daemon / per-terminal subprocess, each restartable independently, each with parent-PID watchdogs, connected by Unix sockets and localhost tRPC. The desktop app is effectively a supervisor UI over a local microservice mesh.
3. **Local-first sync with server-authoritative reconciliation** — Electric SQL shapes into client SQLite for reads; tRPC mutations returning Postgres txids that clients await through the sync stream. Org-scoped row-level security enforced in a Cloudflare Worker, with column-level redaction of secrets.
4. **One tRPC surface, four transports** — the same host-service router is reached over localhost HTTP (desktop), Electron IPC (main-process routers), relay tunnel (web/mobile/CLI/MCP), and in-process caller (MCP v2 → cloud router). Type safety end-to-end everywhere except the deliberately type-decoupled `host-client` for React Native.
5. **The attention system as derived state** — agent status is computed from hook-driven lifecycle events vs. a last-seen clock, never stored, eliminating stale-notification bugs by construction. The delivery mechanism (agent hook → shell script → curl to a local Express server) is charmingly pragmatic.
6. **Shell integration without touching user configs** — ZDOTDIR/rcfile wrapper shims that source real configs, managed binary shims in `~/.superset/bin`, dual OSC prompt markers, PATH re-assertion after version managers.
7. **Superset as an MCP server + agent-operable repo** — the product exposes itself to agents (hosted OAuth MCP), embeds its own Mastra agent, mandates `ask_user` for agent→human questions, and the repo itself is structured for multi-agent contribution. The product, the codebase, and the dev workflow are all agent-native.
8. **Guard scripts encoding institutional knowledge** — git-env inheritance, `origin/`-prefix ref ambiguity, host-owned workspace records, daemon version-bump enforcement: each check is a postmortem fossilized into CI.
9. **Deliberate v1→v2 coexistence** — legacy local-only and new host-owned models run side by side behind feature flags with migration bookkeeping, mismatch guards, and per-surface cutover (mcp-v2 excluded from one guard "until desktop adoption catches up").
10. **Supply-chain caution** — 3-day minimum dependency age, exact versions, trusted-dependencies allowlist for postinstall scripts, isolated linker.

---

## 11. Open Questions / Loose Ends Observed

- `packages/durable-session` is listed in AGENTS.md but doesn't exist — its role is covered by `session-protocol` + host-service journaling; the doc is stale.
- `apps/streams` is an empty placeholder (name reserved; durable streaming currently lives in the API).
- The double PTY stack (terminal-host v1 vs. host-service/pty-daemon v2) and double workspace model are transitional weight; the `TerminalRuntime` registry and v2 guards show the intended end state.
- Windows/Linux support is explicitly untested/absent (macOS-only distribution), though the port scanner and pty layers have cross-platform code paths.
- This snapshot lacks `.git`, `.github/workflows`, `.agents/`, `.superset/`, and `plans/` — CI details and the dogfooding scripts were reconstructed from documentation references only.

---

## 12. Quick File Map (for future navigation)

| Area | Start here |
|---|---|
| Product/positioning | `README.md`, `apps/docs/content/docs/overview.mdx` |
| Contributor rules | `AGENTS.md` (canonical), `DEVELOPMENT.md` |
| Desktop main process | `apps/desktop/src/main/index.ts`, `src/lib/trpc/routers/` |
| Worktree lifecycle | `apps/desktop/src/lib/trpc/routers/workspaces/` (`procedures/create.ts`, `utils/workspace-init.ts`, `utils/setup.ts`, `utils/git.ts`) |
| Agent hooks/attention | `apps/desktop/src/main/lib/agent-setup/`, `src/main/lib/notifications/` |
| Renderer IDE screen | `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/page.tsx` |
| Electric collections | `.../providers/CollectionsProvider/collections.ts` |
| Pane engine | `packages/panes/src/core/store/store.ts` |
| Host daemon | `packages/host-service/src/{serve.ts,app.ts}`, `src/daemon/DAEMON_SUPERVISION.md` |
| PTY daemon | `packages/pty-daemon/src/{Server/Server.ts,protocol/}` |
| ACP sessions | `packages/session-protocol/src/`, `packages/host-service/src/runtime/acp-sessions/` |
| Cloud API | `apps/api/src/app/api/`, `packages/trpc/src/root.ts` |
| DB schema | `packages/db/src/schema/{auth.ts,schema.ts}` |
| Sync security | `apps/electric-proxy/src/{index.ts,where.ts}` |
| Relay | `apps/relay/src/{tunnel.ts,directory.ts,proxy.ts}` |
| CLI | `packages/cli/src/commands/`, `packages/cli-framework/src/` |
| MCP | `packages/mcp-v2/src/{tools/register.ts,caller.ts,host-service-client.ts}` |
| Release system | `scripts/release/README.md`, `scripts/release/lib.ts` |
| Invariant guards | `scripts/check-*.sh`, `scripts/lint.sh` |
