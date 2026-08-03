# Kvy — Product Requirements Document

**Version:** 0.1 (Draft)
**Date:** 2026-07-15
**Status:** For review
**Product:** Kvy — a command center for CLI coding agents
**MVP scope:** CLI + Remote Control. Remote sandboxing explicitly deferred.

---

## 1. Overview

### 1.1 One-liner

> **Kvy lets you run Claude Code and Codex on your own machine and control them from anywhere.** Start a session in your terminal, walk away, and keep steering it from your phone or browser — get notified when the agent needs permission or finishes, reply, and it keeps going.

### 1.2 Background

Developers running long Claude Code / Codex sessions are tied to the machine they
started on — a permission prompt or a finished task goes unnoticed until they
physically return to the terminal. Kvy closes that gap with a **CLI wrapper +
background daemon** on the developer's machine, a **zero-knowledge sync/relay
backend**, and a **remote web client**.

Kvy's MVP is focused on the two things that create the "magic moment": **a
frictionless CLI** and **best-in-class remote control**.

### 1.3 The magic moment (north star)

> A user types `kvy` instead of `claude`, scans nothing, configures nothing extra, gets the exact Claude Code experience they know — then gets a push/web notification at lunch that the agent needs a permission approval, taps **Allow**, and watches the task finish from their phone browser.

Time-to-magic-moment target: **< 5 minutes** from `npm install -g @vibe-oss/kvy` (or curl installer) to controlling a session from a second device.

---

## 2. Goals & Non-Goals

### 2.1 MVP Goals

| # | Goal | Success signal |
|---|------|----------------|
| G1 | Zero-friction CLI wrapper: `kvy` runs Claude Code (and Codex) with full fidelity | Users report "it feels exactly like claude" |
| G2 | Remote control: monitor + steer any session from the web app in near-realtime | Median event latency terminal→web < 1.5 s |
| G3 | Never miss a "needs you" moment: notifications for permission requests, questions, and completion | > 60% of permission requests answered remotely |
| G4 | Sessions survive: disconnects, laptop sleep, daemon restarts don't kill or corrupt a session timeline | < 1% of sessions end in an unrecoverable state |
| G5 | Trustworthy by default: user code/conversations are not readable by operators (E2E encryption) | Security page can honestly say "we can't read your code" |

### 2.2 MVP Non-Goals (deferred, designed-for)

| Deferred | Why | Design constraint now |
|---|---|---|
| **Remote sandboxing** (cloud execution, Cloudflare containers, checkpoint restore) | Explicitly deferred per scope; large infra lift | Model `executionTarget: local \| sandbox` in the schema from day 1; workspace sync/checkpoint APIs stubbed |
| Native mobile apps (iOS/Android), Apple Watch | Web-first MVP is 80% of the value | Web app must be installable as a PWA with web push |
| Desktop app (Electron/Tauri) | CLI + web covers MVP users | Keep remote client logic in a shared package |
| Voice (two-way conversation, dictation) | Differentiator, not core loop | None |
| Live previews (cloudflared tunnels) | Post-MVP fast-follow | Reserve `preview` message types in protocol |
| Parallel-agent orchestration UI, worktree fan-out | Large, independent feature area; MVP supports worktrees minimally | Worktree is a first-class concept in the data model |
| Additional providers (Gemini, Cursor, OpenCode…) | Claude Code + Codex = market majority | Provider adapter interface from day 1 |
| Teams/organizations, billing | Single-user free product first | Account model keeps an org-id field |

---

## 3. Users & Use Cases

### 3.1 Personas

- **P1 — The Solo Shipper (primary).** Indie hacker / senior engineer running 1–3 Claude Code sessions daily on side projects or work repos. Pain: long agent runs block their evening; permission prompts die silently while they're away. Wants: fire-and-check-in workflow.
- **P2 — The Multi-Tasker.** Engineer who runs an agent, switches to meetings/reviews, and wants a dashboard tab showing all running sessions with attention badges.
- **P3 — The Tinkerer / Self-Hoster (secondary).** Privacy-conscious dev who will only adopt if E2E encryption is real and the server is self-hostable.

### 3.2 Core use cases (MVP)

| ID | Use case | Flow |
|----|----------|------|
| UC1 | Start & mirror | `kvy` in a repo → real Claude Code TUI locally → session appears live in web dashboard |
| UC2 | Answer a permission remotely | Agent hits a tool-permission gate → push/web notification → user taps Allow/Deny/Allow-for-session → agent continues |
| UC3 | Steer from the phone/browser | User sends a follow-up message from web → local session (agent) receives it and continues |
| UC4 | Take over / hand back | User "takes control" remotely (terminal session flips to remote-driven); returns to desk, presses a key, gets the local TUI back |
| UC5 | Spawn a session remotely | From web: pick machine → pick workspace/directory → (optionally new branch/worktree) → new session starts on that machine |
| UC6 | Review the work | From web: view the session transcript, tool calls, and file diffs of the working tree |
| UC7 | Continue a plain CLI session | Import a recent `claude`/`codex` session (run without Kvy) into a new Kvy session with context |
| UC8 | Multi-machine | Same account on laptop + desktop; dashboard lists both machines and their sessions/status |
| UC9 | Adopt a running session | User started plain `claude` (not via Kvy), needs to leave → from terminal (`kvy adopt`) or from phone ("Take over" on the mirrored session), the session moves under Kvy management and becomes remotely controllable |

---

## 4. Core Concepts (domain model)

| Concept | Definition | Notes |
|---|---|---|
| **Account** | A Kvy identity; all devices/machines link to it | MVP: single-user accounts |
| **Machine** | A computer running the Kvy daemon; registered under an account | Has static metadata (host, OS, CLI version) + dynamic state (online, daemon pid/port) |
| **Workspace** | A project/repo Kvy knows about: path(s), config, git remote, base ref | Config includes future sync/sandbox toggles (deferred) |
| **Worktree** | A specific working copy of a workspace: the main checkout or a task branch checkout | MVP: main checkout + optional `-b <branch>` git-worktree creation |
| **Session** | One coding conversation + execution timeline: prompts, agent replies, tool calls, permission events, diffs | Belongs to a workspace + worktree + machine; has a provider |
| **Provider** | The coding engine: `claude-code` or `codex` (MVP) | Adapter interface for future providers |
| **Execution target** | `local` (user's machine — MVP) or `sandbox` (managed cloud — deferred) | Present in schema, only `local` implemented |
| **Remote control** | Observing/steering a *local* session from another device. Execution never moves | Distinct from sandboxing |

**Key clarification (avoid user confusion):**
- Workspace = the project; Session = one run of work inside it.
- Remote control ≠ sandbox: remote control keeps execution on your machine.

---

## 5. Product Requirements — MVP

Requirements are labeled `[P0]` (MVP blocker), `[P1]` (MVP polish — ship within MVP window if possible), `[P2]` (fast-follow).

### 5.1 Installation & Onboarding

- **[P0] FR-1.1** Single-command install: `npm install -g @vibe-oss/kvy` **and** `curl -fsSL https://kvy-cli.tkvy.dev/install.sh | sh` (standalone binary; no Node required for the curl path). Support macOS (arm64/x64) and Linux (x64) at MVP; Windows `[P2]`.
- **[P0] FR-1.2** First run of `kvy` triggers sign-in (see 5.2), machine registration, and daemon auto-start — no separate setup steps.
- **[P0] FR-1.3** Kvy bundles/locates providers: detect an existing Claude Code installation and reuse its login; same for Codex. If a provider is missing, print a one-line install/auth instruction (`kvy-claude /login`-style passthrough, or `ANTHROPIC_API_KEY`).
- **[P1] FR-1.4** `kvy doctor` prints a diagnostic: auth state, provider detection, daemon health, connectivity to backend, version.
- **[P0] FR-1.5** Auto-update check on startup (skippable via `KVY_NO_UPDATE=1`); CLI self-update in place.
- **[P1] FR-1.6** Clean uninstall documented: `kvy daemon stop && kvy kill all-force && rm -rf ~/.kvy` + platform service cleanup (launchd / systemd-user / schtasks).

### 5.2 Authentication

Two distinct layers, kept explicitly separate in UX copy:

**Kvy sign-in (account/sync):**
- **[P0] FR-2.1** `kvy auth login` opens the browser for OAuth-style device flow; supports **Email+password, Google, GitHub** at MVP (Apple `[P2]`). On success the CLI stores a token and the machine is linked to the account.
- **[P0] FR-2.2** `kvy auth logout` clears local credentials; `kvy auth status` shows account, machine id, token validity.
- **[P0] FR-2.3** Token storage encrypted at rest under `~/.kvy/`; automatic refresh; TLS everywhere.
- **[P0] FR-2.4** Same account works across CLI, web dashboard, and future clients. Device linking for E2E keys uses a QR/URL pairing flow: **an already-authenticated client approves the new device** — the new device shows a QR/URL encoding an ephemeral public key; an existing device approves and returns key material sealed to that key. The web-first variant: CLI prints a URL, the browser (holding keys in local storage after first sign-up) approves.
- **[P1] FR-2.5** Manual secret backup: the account content key exportable as a grouped Base32 recovery code (1Password-style), with error-tolerant re-entry.

**Provider authentication:**
- **[P0] FR-2.6** Kvy never proxies provider credentials through its backend for local sessions. Provider auth = whatever the local CLI already has (Claude Code login, `ANTHROPIC_API_KEY`, Codex login).
- **[P0] FR-2.7** Clear failure mode: if Kvy sign-in succeeds but the provider isn't authenticated, the CLI and dashboard show "Provider not authenticated" with the exact fix command — never a silent hang.

### 5.3 The CLI

Command surface (trimmed to MVP):

| Command | Description | Priority |
|---|---|---|
| `kvy` | Start an agent session in the current directory (default provider: last used, else Claude Code) | P0 |
| `kvy claude [args…]` / `kvy codex [args…]` | Start with an explicit provider; **all unknown flags pass through verbatim** to the underlying CLI (`--resume`, `--model`, etc.) | P0 |
| `kvy -b <branch>` | Start the session on a new git worktree/branch | P1 |
| `kvy auth login/logout/status` | Account auth | P0 |
| `kvy daemon start [--no-wait] / stop / status` | Daemon lifecycle | P0 |
| `kvy kill daemon / sessions / all / all-force` | Process management escape hatches | P0 |
| `kvy sessions list` | List active/recent sessions on this machine | P1 |
| `kvy resume <session-id>` | Reattach a terminal to an existing Kvy session | P1 |
| `kvy workspace config [--base-ref --remote --directory]` | Per-workspace settings (base ref for diffs, git remote) | P1 |
| `kvy workspace sync …` | **Stub in MVP** — prints "cloud sync coming soon" (sandboxing deferred) | P2 |
| `kvy notify -p <msg>` | Send a test push to your devices | P2 |
| `kvy --help / --version` | Standard | P0 |

Environment variables: `KVY_BACKEND_URL`, `KVY_FRONTEND_URL`, `KVY_HOME_DIR`, `KVY_DEBUG=1`, `KVY_NO_UPDATE=1`, `KVY_NO_SERVICE=1`, `KVY_STARTUP_CHECK_PROVIDERS=claude_code,codex`.

**Wrapper behavior requirements:**

- **[P0] FR-3.1 Local-mode fidelity.** When run in a terminal, the user gets the **genuine provider TUI** (Claude Code interactive UI), not a re-implementation. Implementation approach: spawn the real CLI with inherited stdio; observe the session by tailing the provider's on-disk transcript (Claude Code JSONL) rather than intercepting the UI. All provider keybindings, slash commands, themes, and flags must work untouched.
- **[P0] FR-3.2 Session mirroring.** Every transcript event (user prompt, assistant text, thinking, tool call, tool result) is normalized and relayed to the backend within ~1 s of appearing, encrypted client-side.
- **[P0] FR-3.3 Codex support.** Codex sessions run via `codex app-server` (JSON-RPC over stdio) since Codex has no equivalent local TUI transcript; approvals route through Kvy's permission pipeline.
- **[P0] FR-3.4 Mode switching (local ⇄ remote).**
  - *Remote takes over:* when a message or "take control" arrives from a remote client, the local interactive process is gracefully stopped and the session restarts in **remote mode** — driven headlessly via the Claude Agent SDK (or Codex app-server), with the terminal showing a minimal status view ("Session controlled from web — press Ctrl-T to take back control").
  - *User takes back:* a documented keypress (Ctrl-T, or double-space with confirm) flips back to the local TUI using the provider's native resume (`claude --resume <id>`), preserving full context.
  - Mode switches must be loss-less: no dropped or duplicated messages across the transition (dedup by message id/content ring buffer).
- **[P0] FR-3.5 Permission interception (remote mode).** In remote mode, tool-permission requests surface as structured events (tool name, args, risk category) that remote clients can answer: **Allow once / Deny / Allow for session / switch permission mode**. Timeout behavior: configurable; default = wait indefinitely, keep re-notifying at 5-minute intervals up to 3 times.
- **[P1] FR-3.6 Permission visibility (local mode).** In local mode Kvy cannot answer prompts on the agent's TTY; the dashboard shows "waiting for input at the terminal" state, and a notification is still sent (via provider hook events) so the user knows to return. (Full remote answering requires remote mode — make this an explicit, honest UX distinction.)
- **[P0] FR-3.7 Crash & exit semantics.** Ctrl-C / terminal close does **not** archive a session (it remains resumable); explicit archive from a client or `kvy sessions archive` ends it. Agent crash marks the session `failed` with the error surfaced remotely.
- **[P1] FR-3.8 "Thinking" indicator.** Remote clients see a live working/idle indicator. Local mode may derive it from transcript activity (and optionally a fetch-level activity probe); remote mode derives it from SDK stream state.

### 5.4 The Daemon

- **[P0] FR-4.1** A per-machine background daemon: singleton (atomic lock file with PID), local control server on `127.0.0.1:<random port>` recorded in `~/.kvy/daemon.state.json`, auto-started by any `kvy` command, installable as a login service (launchd / systemd-user) `[P1]`.
- **[P0] FR-4.2** Maintains a persistent, machine-scoped realtime connection to the backend; registers RPC handlers: `spawnSession`, `stopSession`, `resumeSession`, `listSessions`, plus a minimal utility surface for the dashboard: `gitStatus`, `gitDiff`, `readFile` (for diff viewing), `listRecentProviderSessions` (for session import). Heartbeats every 60 s; machine presence (online/offline) visible in the dashboard.
- **[P0] FR-4.3 Remote spawn:** given workspace path (validated against registered workspaces), provider, permission mode, and optional branch, the daemon launches `kvy <provider> --starting-mode remote --started-by daemon`, preferring **tmux** when available so users can attach a real terminal later; detached process otherwise.
- **[P0] FR-4.4 Durability:** daemon restart must not orphan sessions — it re-discovers running session processes (pid tracking + liveness probe) and reconnects them; finished sessions are persisted (including their session keys) so **resume survives daemon and machine restarts**.
- **[P1] FR-4.5** Version drift: daemon detects a newer installed CLI via artifact mtime rather than a version string (a version-string comparison is unreliable across install methods) and self-restarts safely when idle.
- **[P0] FR-4.6** Kill-switch commands work even when the daemon is wedged (`kvy kill all-force` scans processes directly).

### 5.5 Backend (Sync & Relay Service)

- **[P0] FR-5.1 Zero-knowledge relay.** The backend stores and routes **only ciphertext** for user content: session messages, metadata, agent state, diffs. Plaintext it may hold: account ids/public keys, machine ids, sequence numbers, version counters, timestamps, push tokens, workspace display names (user-controlled toggle `[P1]`). This is both an ethics posture and a breach-liability reducer — and table stakes for the self-hosting community.
- **[P0] FR-5.2 Transport.** One realtime endpoint (WebSocket; Socket.IO or equivalent) with three connection scopes: `user` (dashboard), `session` (CLI session process), `machine` (daemon). REST for fetch/pagination and auth.
- **[P0] FR-5.3 Ordering & sync model.** Every persistent update carries a per-account monotonic sequence number. Clients apply `seq == last+1` fast-path; any gap triggers a re-fetch. Shared mutable state (session metadata, agent state) uses optimistic concurrency (`expectedVersion` → conflict response). On reconnect, clients re-fetch rather than relying on server-side event replay — simpler and avoids event-sourcing complexity at MVP.
- **[P0] FR-5.4 Client↔client RPC.** Dashboard→daemon and dashboard→session calls are routed through the relay as RPC (register/call with ack + timeout). Room-membership (connection registry) is the single source of truth for routing — no TTL-based registries, since TTL-expiry races are a well-known source of stale-target bugs; fast dead-peer detection (presence poll racing the ack, target ~1–2 s failure detection, not 30 s timeouts); a short reconnect grace window (~10 s) for daemons that are briefly offline.
- **[P0] FR-5.5 Idempotency.** Message ingest deduped by `(sessionId, localId)`; session creation deduped by `(account, tag)`.
- **[P1] FR-5.6 Self-hostable single container.** One Docker image with embedded storage (SQLite/PGlite) and the web app bundled — zero external dependencies. Production shape: Postgres + Redis. Same codebase, two entrypoints.
- **[P0] FR-5.7 Attachments** (images in prompts): encrypted blob upload with pre-signed URLs; per-session blob keys derived from the session key so attachments are cryptographically isolated. `[P1]` if timeline pressure demands.

### 5.6 Encryption (MVP-inclusive, not deferred)

Rationale: retrofitting E2E later is effectively impossible without breaking the
protocol, and privacy — genuinely not being able to read a user's code — is a real
product differentiator worth building in from day one, not bolting on later.

- **[P0] FR-6.1** Account = keypair. Registration generates a master secret client-side; the server authenticates by public-key challenge/response (Ed25519 signature) plus the OAuth identity for account recovery mapping.
- **[P0] FR-6.2** Per-session **data encryption keys** (32-byte, AES-256-GCM for payloads), wrapped to the account content public key (X25519 sealed box) and stored server-side as opaque blobs. Key-unwrap failures degrade to `null` — one corrupt record must never poison a sync batch.
- **[P0] FR-6.3** All session content, metadata, agent state, and attachments encrypted client-side before upload. Wire format: `{t: "encrypted", c: <base64>}` containers with versioned layouts.
- **[P0] FR-6.4** Honest boundary, documented: things the server *can* see (routing metadata, seq numbers, push tokens) are enumerated publicly.
- **[P1] FR-6.5** Web client key handling: keys held in IndexedDB (non-extractable where platform allows), with the recovery-code flow (FR-2.5) as the escape hatch.

### 5.7 Remote Control Web App (the MVP client)

A responsive web app (desktop + mobile browser), installable as a PWA.

- **[P0] FR-7.1 Session list (home).** All sessions across machines, grouped by workspace; live status per session: `working / waiting-for-permission / waiting-for-input / idle / completed / failed / offline`; attention badges; machine online/offline indicators.
- **[P0] FR-7.2 Session view (chat timeline).** Rendered structured transcript — not a terminal dump: user prompts, assistant markdown (code blocks with syntax highlighting), collapsible thinking, **tool-call cards** (Bash command + output, file Edit/Write with inline diff, Read, Grep/Glob, WebFetch/WebSearch, TodoWrite as a checklist, Task/subagent groups), permission events, mode switches. The normalization layer must handle both Claude and Codex dialects: dedupe by ids, match permissions to tool calls by name + arguments, link subagent sidechains to parent tool calls.
- **[P0] FR-7.3 Composer.** Send follow-up messages to a session (queued if the agent is mid-turn); quick actions: **Stop/Interrupt**, permission-mode selector (`default / acceptEdits / plan / bypassPermissions` mapped per provider), take-control.
- **[P0] FR-7.4 Permission approval UX.** Permission requests render as blocking cards with Allow / Deny / Allow-for-session and (for edits) the proposed change preview. Answering from web resolves the CLI-side promise within 1 s.
- **[P0] FR-7.5 New session flow.** Machine picker (online machines) → workspace/directory picker (daemon-provided) → provider, permission mode, model → optional new branch/worktree `[P1]` → spawn (UC5).
- **[P0] FR-7.6 Notifications.** Web Push (service worker) for: permission request, agent question, session completed, session failed. Notification tap deep-links to the exact session. **Presence-aware suppression:** no push when the user has the session visibly open in a focused tab (client reports app/tab focus state; server suppresses). Do this at MVP — notification fatigue is the top churn risk, so per-message pushes are explicitly out.
- **[P1] FR-7.7 Git panel.** For the active session's worktree: file-level diff list vs configured base ref, per-file unified diff view (executed on the machine via daemon RPC, streamed encrypted), plus real one-click Commit, Push, and Force Push (`--force-with-lease` only, behind a confirm dialog), inline branch rename, and a "Compare against" selector accepting any local branch, `HEAD` (uncommitted), or a free-text ref. "Create PR" ships as a manual "Open PR on GitHub" compare-URL link (primary, always visible once pushed) plus an agent-assisted "Ask agent to open PR" action that hands the session's own agent a prompt to commit/push/`gh pr create` itself — no direct-API "create PR" RPC yet (backlogged).
- **[P1] FR-7.8 Session import (UC7).** "Continue from a recent CLI session": daemon lists recent plain `claude`/`codex` sessions for the workspace (from provider transcript dirs), user picks one, Kvy imports the JSONL history into a new Kvy session and resumes with context.
- **[P1] FR-7.9** Tab title + favicon reflect pending-attention state (cheap, high-value web ergonomics).
- **[P2] FR-7.10** Command palette, keyboard shortcuts, session search.

### 5.8 Notifications & Attention Model

- **[P0] FR-8.1** Attention states are **derived, never stored**: a session needs attention iff (pending permission ∨ pending question ∨ completed-and-unseen), computed from event stream vs per-device last-seen timestamps. Deriving rather than storing this state eliminates stale-badge bugs by construction.
- **[P0] FR-8.2** Event taxonomy for notifications: `permission_request`, `agent_question`, `turn_completed`, `session_failed`. No per-message notifications, ever.
- **[P1] FR-8.3** Per-account quiet controls: mute a session, mute all, notification schedule.

### 5.9 Session Adoption — start in plain `claude`, move to Kvy (UC9)

The most common real-world entry path: the user opens plain `claude` (muscle memory), works a while, then needs to leave and wants remote access to *that* session.

**Technical basis.** A plain provider process owns its TTY — no remote input injection is possible. But Claude Code continuously persists its full transcript to `~/.claude/projects/<project>/<session-id>.jsonl`, and native resume (`claude --resume` / SDK `resume`) gives lossless continuation. Therefore adoption = **mirror from the transcript (read-only, instant)** + **resume under Kvy (to gain control)**. Codex equivalent uses its session/rollout files where available; Codex adoption may ship as import-of-finished-sessions only at MVP.

Three tiers:

**Tier 1 — Ambient visibility (P0-lite):**
- **[P0] FR-9.1** The daemon passively indexes provider transcript directories for registered workspaces. Plain (non-Kvy) sessions appear in the dashboard as **unmanaged sessions** with a live read-only mirror (same JSONL-tailer code path as managed sessions) and a liveness state derived from a process scan ("running in your terminal on <machine>" vs "finished"). Encrypted like all other session content. Opt-out per workspace.

**Tier 2 — Explicit takeover (the core flow):**
- **[P0] FR-9.2 `kvy adopt` (terminal-side).** In a workspace directory: lists recent plain sessions (most recent preselected), imports the JSONL history into a new managed Kvy session, and continues it via provider-native resume — local TUI by default (`kvy adopt --remote` to start detached). `kvy --continue` aliases the most-recent case. This subsumes UC7 (import of finished sessions) — same machinery, trivial case.
- **[P1] FR-9.3 Phone-side takeover.** An unmanaged session card offers **Take over**: the daemon gracefully terminates the original process by PID, then resumes the session in remote mode via SDK. If the process is mid-turn, show a warning first ("taking over interrupts the current step; all work up to now is preserved") **[P0** within this feature**]**.
- **[P0] FR-9.4 Divergence guard.** Takeover requires stopping the original process — never two live continuations of the same history. Offer **"Fork instead"** as the explicit non-destructive alternative (leaves the terminal session running; creates an independent Kvy session from the same history).
- **[P0] FR-9.5 Identity mapping.** Provider resume mints a new provider session-id; the importer maps old→new ids so the Kvy session presents one continuous timeline (dedupe imported vs. live-resumed messages by content/id ring buffer, same mechanism as mode switching FR-3.4).

**Tier 3 — Make the problem disappear (recommended default):**
- **~~[P1] FR-9.6 Shell shim (opt-in at onboarding).~~ Descoped.** Was: install a `claude`/`codex` PATH shim in `~/.kvy/bin` so plain invocations transparently become Kvy-managed sessions. Removed — the shim gated every invocation behind a round-trip to Kvy's own backend/daemon with no fallback, so any Kvy-side outage silently broke the user's plain `claude`/`codex` command instead of degrading to it (the opposite of "transparent"). Kvy must never shadow those commands; Tiers 1–2 remain the only adoption path (explicit `kvy claude`/`kvy codex`).

**Honest limitation (UX copy requirement):** takeover-from-phone leaves the original terminal detached; regaining the local TUI uses the standard take-back-control flow (FR-3.4 / `kvy resume <id>`).

---

## 6. Technical Architecture (recommended)

### 6.1 Topology

```
┌────────────────────────── USER'S MACHINE ─────────────────────────┐
│  kvy CLI (npm: kvy; standalone binaries via bun/pkg)        │
│  ├─ Provider adapters:                                            │
│  │   • claude-code: local mode = spawn real CLI (inherited stdio) │
│  │     + JSONL transcript tailer; remote mode = Claude Agent SDK  │
│  │   • codex: app-server JSON-RPC (always programmatic)           │
│  ├─ Session process: normalizes events → encrypts → relays;       │
│  │   handles permission pipeline + mode switching                 │
│  └─ kvy daemon: singleton, machine-scoped connection,          │
│      spawn/stop/resume RPCs, git/file RPCs, tmux-preferred spawn, │
│      session persistence (keys + state) for resume                │
└──────────────┬────────────────────────────────────────────────────┘
               │  WSS (session- & machine-scoped) + REST — ciphertext only
┌──────────────▼────────────────────────────────────────────────────┐
│  kvy-server (zero-knowledge relay)                             │
│  auth (OAuth + pubkey challenge) · seq-numbered update fan-out ·  │
│  client↔client RPC via connection rooms · push dispatch (web push,│
│  presence-suppressed) · encrypted blob store                      │
│  Deploy: prod (Postgres+Redis) & self-host (single container)     │
└──────────────┬────────────────────────────────────────────────────┘
               │  WSS (user-scoped) + REST — ciphertext only
┌──────────────▼────────────────────────────────────────────────────┐
│  kvy web app (PWA): session list, chat timeline, permission    │
│  cards, composer, new-session flow, git diffs, web push           │
└───────────────────────────────────────────────────────────────────┘
```

### 6.2 Monorepo layout

```
kvy/
├─ packages/
│  ├─ kvy-cli      # wrapper + daemon (TypeScript, Node ≥20; bins via bundler)
│  ├─ kvy-server   # Fastify (or Hono) + WS + Prisma/Drizzle
│  ├─ kvy-web      # React PWA (Vite); shared session-render components
│  ├─ kvy-wire     # THE shared package: Zod schemas for every wire message,
│  │                  # session envelope, permission modes, RPC contracts
│  └─ kvy-crypto   # encryption primitives + key hierarchy (isomorphic)
└─ docs/              # architecture docs from day 1
```

`kvy-wire` is non-negotiable: every consumer imports the same schemas, which
prevents silent drift between server/CLI/web. Session events use a **flat,
provider-agnostic envelope** from day 1: `{id (cuid2), time, role, turn?, subagent?, ev}` with event types `text / tool-call-start / tool-call-end / file / turn-start / turn-end / service / start / stop` — adapter-minted ids only, provider-native ids never cross the wire.

### 6.3 Key implementation decisions (with rationale)

| Decision | Choice | Rationale |
|---|---|---|
| Local-mode strategy | Spawn real provider CLI + transcript tailing (NOT PTY re-render, NOT SDK-only) | Fidelity is the product — users get the exact CLI they already know, not a re-implementation |
| Remote-mode strategy | Claude Agent SDK / Codex app-server | Only way to programmatically answer permissions |
| RPC registry | Connection/room membership as truth; no TTLs | Avoids a well-known class of stale-registry bugs; fast dead-peer detection via presence-poll race |
| Sync model | Per-account seq + client re-fetch on gap; no server event replay | Simpler, proven; avoids event-sourcing complexity at MVP |
| Crypto | libsodium: Ed25519 auth, X25519 sealed-box key wrap, AES-256-GCM payloads | Well-reviewed, standard primitives for E2E encryption |
| Spawned sessions | Prefer tmux | Users can always attach a real terminal; huge trust win |
| Session dedup | `(sessionId, localId)` for messages; content ring-buffer for cross-mode dedup | Prevents duplicates across local⇄remote switches |
| Web push | Service worker + presence-suppression at server | The notification experience is the product's spine |
| Self-host | Single-container image with embedded DB | Community wedge; forces clean config discipline |

### 6.4 Explicit stubs for deferred features

- `executionTarget` field on sessions/worktrees (`local` only at MVP).
- `kvy workspace sync` command group reserved; checkpoint API surface designed but unimplemented.
- Wire protocol reserves `preview:*` (live previews) and `checkpoint:*` message namespaces.
- Workspace settings schema includes `sandbox: {enabled, envVars, setupScript}` (hidden in UI).

---

## 7. Milestones

| Phase | Duration (est.) | Scope | Exit criteria |
|---|---|---|---|
| **M0 — Skeleton** | 2 wk | Monorepo, kvy-wire schemas, server with auth + WS echo, CLI that spawns Claude Code with passthrough | `kvy` runs Claude Code indistinguishably; account sign-in works |
| **M1 — Mirror** | 3 wk | Transcript tailing → encrypted relay → web session list + read-only timeline; daemon + machine presence | UC1: watch a live session from the browser |
| **M2 — Control** | 4 wk | Remote mode (SDK), permission pipeline, composer, mode switching, notifications (web push + suppression) | UC2, UC3, UC4 end-to-end; magic moment demo |
| **M3 — Fleet** | 3 wk | Remote spawn (UC5), tmux, session resume/durability, kill commands, Codex adapter, `kvy doctor`, **session adoption Tiers 1–2** (`kvy adopt`, unmanaged-session mirror, phone takeover) | UC5, UC8, UC9; chaos tests pass (kill daemon mid-session, sleep laptop) |
| **M4 — Ship** | 2 wk | Git diff panel, session import polish, ~~shell shim (Tier 3)~~ *(descoped, see FR-9.6)*, PWA polish, self-host image, docs site, installers | Public beta; onboarding < 5 min measured |

Fast-follows post-MVP (ordered): git commit/push/PR → live previews (cloudflared) → native mobile app → voice → remote sandboxing.

---

## 8. Success Metrics

**Activation:** install → first session ≥ 70%; first session → second-device control within 48 h ≥ 40% (the aha metric).
**Engagement:** WAU/MAU ≥ 40%; median sessions/active user/week ≥ 5; % permission requests answered remotely ≥ 60%.
**Reliability:** terminal→web event latency p50 < 1.5 s, p95 < 4 s; permission answer→agent continue p95 < 2 s; unrecoverable session rate < 1%; notification delivery success ≥ 98%.
**Trust:** self-host deployments (tracked via opt-in ping) and zero plaintext user content server-side (audited).

---

## 9. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Provider CLI/SDK breaking changes (Claude Code updates transcript format or SDK) | High | High | Adapter layer isolates providers; pin tested version ranges; transcript-format contract tests run in CI daily against latest provider releases |
| Mode-switch edge cases (dropped/duplicated messages, wedged TTY) | High | Med | Dedup ring buffers; a `setBlocking(stdin)` fix for a known stdin-blocking-mode issue when switching between raw and cooked terminal modes; a scripted 20-step conformance test run before every release |
| Notification fatigue → uninstall | Med | High | Lifecycle-only events, presence suppression, per-session mute at MVP |
| Terms-of-service friction with providers (wrapping/driving their CLIs) | Med | High | Local-first design uses the user's own auth; monitor Anthropic/OpenAI policies; SDKs are the sanctioned path for remote mode |
| E2E crypto slows MVP | Med | Med | Reuse a well-reviewed, standard encryption scheme rather than designing new primitives; `kvy-crypto` built and tested in M0 |
| RPC/presence bugs at scale | Med | Med | Careful room-membership design from day 1; integration tests with kill-the-daemon chaos scenarios |
| Web push unreliability on iOS Safari | High | Med | Honest platform messaging; native app is the durable fix (post-MVP); email fallback `[P2]` |
| Category competition (well-funded and open-source alternatives exist) | High | — | Wedge: OSS + genuinely self-hostable + E2E + best CLI fidelity; speed |

---

## 10. Open Questions (need decisions before M1)

1. **Business/licensing:** fully permissive OSS (e.g. MIT) vs source-available (e.g. a non-compete license)? Recommendation: MIT client + wire, decide server later — the community wedge depends on it.
2. **Backend stack final call:** Fastify+Socket.IO+Prisma (maximum reference reuse) vs Hono+plain WS+Drizzle (lighter). Recommendation: former for speed, latter only if team has strong preference.
3. **Web-only key custody UX:** is browser-held key material acceptable for MVP sign-up (with recovery codes), or must the CLI be the key-origin device? Affects FR-2.4 flow order.
4. **Permission answering in local mode (FR-3.6):** ship "notify-only" honestly, or invest in provider hook-based approval injection? Should be probed by hands-on testing.
5. **Codex depth at MVP:** full parity, or Claude-first with Codex marked beta at M3?
6. **Name/trademark check** for "Kvy" in dev-tools (crowded namespace: Kvy framework, CrowdStrike Kvy).
