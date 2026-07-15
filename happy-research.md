# Research: The `happy/` Codebase

> Deep-dive analysis of the repository at `vibe-ide/happy/` — what it is, how it works, and its notable design decisions. Compiled 2026-07-14 from a full multi-pass exploration of the source tree (~1,016 TypeScript files across 7 packages) and its unusually rich `docs/` folder.

---

## 1. Executive Summary

**Happy** (GitHub `slopus/happy`, [happy.engineering](https://happy.engineering)) is an open-source (MIT) **mobile and web client for Claude Code and Codex** with **end-to-end encryption**. The pitch: run `happy claude` (or `happy codex`) on your computer instead of `claude`/`codex`, and you can then watch and drive that session from your phone, tablet, browser, or a Tauri desktop app — with push notifications when the agent needs permission or finishes, one-keypress handoff between phone and terminal, and a zero-knowledge sync server that never sees your code or conversations in plaintext.

Distribution: iOS App Store, Google Play, web app (app.happy.engineering), `npm install -g happy`. Founders: Kirill Dubovitskiy (bra1nDump, ex-Robinhood/Meta) and Steve Korshakov (ex3ndr, creator of llama-coder and the Tact language). As of the in-repo community report (2026-04): **17,782 GitHub stars, 502 external contributors** — genuine product-market fit as "the universal mobile frontend for AI coding agents."

The monorepo (pnpm workspaces) contains:

| Package | Role |
|---|---|
| `happy-cli` (npm: `happy`, v1.2.0) | The wrapper CLI + background daemon on your machine |
| `happy-app` | Expo universal app: iOS, Android, web, and Tauri macOS desktop |
| `happy-server` (npm: `happy-server-self-host`) | Fastify + Socket.IO zero-knowledge sync relay |
| `happy-wire` (`@slopus/happy-wire`) | Shared Zod wire-protocol schemas |
| `happy-agent` (npm: `happy-agent`) | Headless remote-control CLI (spawn/send/monitor sessions — scripting, CI, multi-agent orchestration) |
| `codium` | Early-stage Electron desktop agent-chat client (embeds Claude Code + Codex directly) |
| `happy-app-logs` | Tiny dev-only log sink for AI-assisted debugging |

A striking meta-feature: the repo's `docs/` folder contains first-class architecture documentation (encryption, wire protocol, RPC design with postmortems, voice monetization economics), competitive teardowns of OpenCode/Codex/Claude Code/**Superset** (the other repo in this workspace), and the team's experimental "software factory" — a manager-agent that supervises engineer-agents through Happy itself.

> Historical naming note: the product was originally "Handy" — the codename persists in `HANDY_MASTER_SECRET`, the `handy-server` Kubernetes manifests, and `handy://` URL fallbacks.

---

## 2. What It Does (product behavior)

1. **Install** the app on your phone and `npm i -g happy` on your computer.
2. **Pair** by scanning a QR code: the CLI generates an ephemeral X25519 keypair and displays `happy://terminal?<pubkey>`; the phone (which holds the master key) scans it and sends back the account key material, box-encrypted to that ephemeral key. The server only ever brokers ciphertext.
3. **Run `happy claude`** — you get the *real, unmodified* Claude Code TUI in your terminal ("local mode"), while a file watcher streams the session transcript (encrypted) to the server so your phone mirrors everything live.
4. **Take control from the phone** — the session restarts in "remote mode," driven headlessly through the Claude Agent SDK; your terminal shows a minimal Ink status display. Press **double-space or Ctrl-T** in the terminal to take control back (the README's "press any key" is marketing shorthand).
5. **Permissions on the go** — tool-permission requests surface as push notifications and in-app prompts (allow / deny / allow-for-session / mode change); a favicon badge indicates pending permissions on web.
6. **Spawn sessions remotely** — the background daemon on each machine registers RPC handlers, so from the phone you can pick a machine, directory, agent (claude / codex / gemini / agy / openclaw), permission mode, model, and effort, optionally in a fresh **git worktree**, and launch a brand-new session — or fork/rewind/resume existing ones.
7. **Talk to it** — an ElevenLabs-powered realtime voice assistant can summarize sessions, relay your spoken instructions to the agent, and approve/deny permissions by voice (free 20 min/month, subscription via RevenueCat, or bring-your-own ElevenLabs agent for unlimited).
8. Extras: encrypted image attachments, artifacts (encrypted notes), a friends/social layer with an activity feed, usage/cost dashboards, machine management (stop daemon, run bash), 9-language i18n, e-ink display support.

---

## 3. System Architecture

```
┌────────────────────────── YOUR COMPUTER ─────────────────────────┐
│  happy-cli (npm: happy)                                          │
│  ├─ happy claude ──► LOCAL MODE: spawns real Claude Code CLI     │
│  │    (inherited stdio; launcher .cjs monkey-patches fetch →     │
│  │     "thinking" signal on fd 3; JSONL transcript scanner)      │
│  │    REMOTE MODE: drives @anthropic-ai/claude-agent-sdk,        │
│  │     Ink status TUI, ordered outgoing message queue            │
│  ├─ happy codex ──► spawns `codex app-server` (JSON-RPC/stdio)   │
│  ├─ happy daemon ─► lock-file singleton; Fastify control server  │
│  │    on 127.0.0.1; spawns sessions (prefers tmux); persists     │
│  │    finished sessions for restart-surviving resume             │
│  └─ sandbox: @anthropic-ai/sandbox-runtime (macOS Seatbelt)      │
│        every payload encrypted client-side before upload          │
└───────────────┬──────────────────────────────────────────────────┘
                │ Socket.IO /v1/updates (session- & machine-scoped)
                │ + REST /v1..v3  — ciphertext only
┌───────────────▼──────────────────────────────────────────────────┐
│  happy-server (Fastify + Socket.IO + Prisma/Postgres [+Redis])   │
│  ZERO-KNOWLEDGE RELAY: stores opaque encrypted blobs, seq        │
│  counters, routing metadata. Fan-out via Socket.IO rooms;        │
│  client↔client RPC through rooms (no registry store);            │
│  Expo push (presence-suppressed); ElevenLabs token minting;      │
│  RevenueCat entitlements; GitHub OAuth; vendor-key vault.        │
│  Deploys: k8s (3 replicas + Redis streams adapter) OR a          │
│  zero-dependency standalone image (embedded PGlite + web UI).    │
└───────────────┬──────────────────────────────────────────────────┘
                │ Socket.IO (user-scoped) + REST — ciphertext only
┌───────────────▼──────────────────────────────────────────────────┐
│  happy-app (Expo): iOS / Android / web (Metro single bundle) /   │
│  Tauri macOS desktop. Holds the MASTER KEY. Zustand + MMKV,      │
│  message reducer normalizing Claude/Codex/Gemini dialects,       │
│  voice (ElevenLabs over LiveKit/WebRTC), push, QR approver.      │
└───────────────────────────────────────────────────────────────────┘
    happy-agent (headless CLI) and codium (Electron) are additional
    clients speaking the same encrypted protocol.
```

The load-bearing idea everywhere: **the server is a dumb, blind relay**. All meaning lives in encrypted payloads only clients can read; the server sees just sequence numbers, version counters, tags, timestamps, and public keys.

---

## 4. Encryption & Identity (the defining feature)

### Key hierarchy
- **Account = keypair.** No passwords, no email. An account is identified solely by its public key; `POST /v1/auth` verifies an Ed25519-signed challenge (tweetnacl) and mints a bearer token (generated from the server's `HANDY_MASTER_SECRET` via privacy-kit).
- The app derives keys from the 32-byte master secret using a BIP32-like HMAC-SHA512 tree (`deriveKey`, domain-separated by usage strings): a **content keypair** (X25519, for wrapping data keys), an **anonID** (first 16 hex chars — the PostHog analytics ID, so analytics can't be linked to the account key), and a legacy blob key.

### Two encryption generations (both live)
1. **Legacy**: a single shared 32-byte secret; payloads sealed with NaCl `secretbox` (XSalsa20-Poly1305), layout `[nonce(24) | ct]`.
2. **dataKey (v2)**: every session/machine/artifact gets a fresh random 32-byte **DEK**; payloads use **AES-256-GCM** (`[ver(0) | nonce(12) | ct | tag(16)]`); the DEK itself is sealed to the account's content public key with an ephemeral NaCl box (`[ephPub(32) | nonce(24) | ct]`) and stored server-side as an unreadable `dataEncryptionKey` blob. Per-session blob keys are derived separately, so image attachments are cryptographically isolated from message text.

### Pairing (QR device linking)
The **already-authenticated phone is the approver**. The CLI/web-login shows `happy://terminal?<base64url ephemeral pubkey>`; the app scans it and box-encrypts back either the raw secret (V1) or a `[0x00 | contentDataKey]` bundle (V2 — shares the content key, *not* the master secret). Manual backup uses a 1Password-style Base32 string (11 groups of 5) with error-tolerant normalization (0→O, 1→I, 8→B, 9→G).

### The honest boundary of "zero-knowledge"
Documented and real: conversation content, metadata, agent state, artifacts, and KV *values* are E2E-encrypted. **Not** E2E: GitHub OAuth tokens and user-stored vendor API keys (OpenAI/Anthropic/Gemini) — the server encrypts these at rest with its own `HANDY_MASTER_SECRET`-derived KeyTree and can read them (it has to, to hand them back). KV *keys* are plaintext for indexing. External identities are privacy-mapped: ElevenLabs sees only `u_<HMAC-SHA256(userId, masterSecret)>`, never the real account ID.

Robustness detail worth stealing: key-unwrap functions **never throw** — a corrupt or foreign `dataEncryptionKey` degrades to `null` so one bad record can't poison an entire sync batch.

---

## 5. `happy-cli` — the Wrapper (289 files)

npm package `happy`, ESM, bundled with pkgroll; bins `happy` and `happy-mcp` (a Codex MCP stdio bridge). Hand-rolled arg parsing; **all unknown flags pass through to Claude Code verbatim** (`happy --resume` just works), and `--help` appends real `claude --help` output.

### The Claude wrapper — two modes, one state machine (`src/claude/loop.ts`)
- **Local mode** is the genuinely clever part: not a PTY, not the SDK. It `cross-spawn`s a launcher script (`claude_local_launcher.cjs`) with `stdio: ['inherit','inherit','inherit','pipe']` — the user gets the **authentic Claude Code TUI**, unmediated. The launcher `require()`s the globally installed Claude CLI and **monkey-patches `global.fetch`** to emit fetch start/end events on **fd 3**, giving the phone a privacy-preserving "thinking…" indicator (hostname/path only, never content). A JSONL transcript scanner (`sessionScanner.ts`) tails Claude's on-disk session file and relays each new line (encrypted) to the server. Happy injects `--append-system-prompt`, its own MCP server (`--mcp-config`), and a `SessionStart` hook via a temp `--settings` file to learn Claude's real session UUID.
- **Remote mode** drives `query()` from `@anthropic-ai/claude-agent-sdk`, renders an Ink status TUI, converts SDK messages to the wire format through an ordered `OutgoingMessageQueue`, and routes `canCallTool` through a `PermissionHandler` that writes pending requests into encrypted `agentState.requests` + fires a push notification; the app answers via RPC.
- **Switching**: remote→local on double-space (15 s confirm window) or Ctrl-T; local→remote when the app sends a message or hits "take control" (an RPC `switch` handler aborts local Claude so the queued message is picked up). A fix worth noting: `setBlocking(true)` on stdin before spawning local Claude, clearing the `O_NONBLOCK` flag Ink leaves behind (fixed a family of garbled-terminal bugs).

### The Codex wrapper
Spawns **`codex app-server --listen stdio://`** and speaks hand-rolled JSON-RPC 2.0 (~1,600-line client) — hand-rolled because the official `@openai/codex-sdk` can't do interactive approvals. Approvals (`exec:request`, `patch:request`, MCP calls) route to the phone. Supports fork/rollback/inject/interrupt on conversations. There is no "local interactive" Codex mode — it's always app-server-driven.

### The daemon (`src/daemon/`)
Singleton via an atomic hard-link lock file; local Fastify control server on a random localhost port; connects to the sync server as a **machine-scoped** client and registers `spawnSession` / `resumeSession` / `stopSession` RPCs — this is how phones spawn sessions. Prefers **tmux** for spawned sessions (so users can `tmux attach`), falls back to detached processes. Persists finished sessions **with their encryption keys** to `sessions.json` so resume survives daemon restarts; resume-in-place re-attaches a new process to the same server session row via `HAPPY_RECONNECT_*` env vars. Upgrade detection compares `dist/index.mjs` **mtime**, not version strings (a version-string check once caused an infinite restart loop). Uses `caffeinate` on macOS to prevent sleep. Exposes a deliberately small RPC toolbox to remote clients: `bash`, file read/write, ripgrep, difftastic.

### Other CLI specificities
- `happy sandbox`: OS-level sandboxing via `@anthropic-ai/sandbox-runtime` (macOS Seatbelt) with Zod-configured policy (default deny: `~/.ssh`, `~/.aws`, `~/.gnupg`, `.env`); enabling sandbox **forces** `--dangerously-skip-permissions` — the sandbox becomes the security boundary instead of prompts.
- Fork backfill: forked sessions replay the copied Claude JSONL into the new server session (the SDK resumes silently without re-emitting history).
- Ctrl-C deliberately does **not** archive a session (treated as a network blip, stays resumable); only explicit archive or crash does.
- `cross-spawn` everywhere specifically for Windows `.cmd` shim bugs; state in `~/.happy` (`settings.json` with atomic lock-file writes, `access.key`, `daemon.state.json`, `sessions.json`, file-only debug logs).
- Agents beyond Claude/Codex: `happy gemini` (deprecated), `happy agy` ("Antigravity", the Gemini successor), `happy acp -- <cmd>` (generic Agent Client Protocol runner, e.g. OpenCode), `happy openclaw`.
- The package's own `CLAUDE.md` is badly outdated (still describes the "handy-cli" node-pty era) — the docs folder, not CLAUDE.md, is the reliable reference.

---

## 6. `happy-app` — the Universal Client (500 files)

Expo SDK ~55, React 19 / RN 0.83, expo-router (typed routes), one codebase for **iOS, Android, web, and Tauri macOS desktop** (`src-tauri/` bundles the Metro web export into a native window; detected via `window.__TAURI__`). Web is a single-page Metro bundle — not a PWA, not Electron.

- **State**: Zustand + MMKV persistence; credentials in SecureStore/localStorage. The sync engine is a plain singleton class outside React.
- **Sync**: one user-scoped Socket.IO connection; two channels — persistent `update` events (per-user monotonic `seq`; fast-path applies `seq == last+1`, anything else triggers a full re-fetch) and `ephemeral` presence/thinking events (debounced 2 s). Everything refreshable is an `InvalidateSync` that re-fires on foreground and reconnect — the app **never shows a loading error; it just retries**. Offline sends queue in a per-session outbox with a 30 s background watchdog that posts a local "failed to send" notification.
- **The message reducer** (`sync/reducer/reducer.ts`, ~1,250 documented lines) is the heart: a multi-phase pipeline that normalizes **three different agent dialects** (Claude's `tool_use`/`tool_result`, Codex/Gemini's `tool-call`/`tool-call-result`, and the new unified `session` envelope) into one deduplicated structured history — matching permission requests to tool calls by name *and arguments*, linking sidechains (sub-agent Task conversations) to parent tools, tracking todos and token usage. Idempotent, with trace-based regression tests (`__testdata__/trace_*.json`).
- **Rendering**: inverted FlatList chat with hand-rolled message grouping; a large tool registry (`knownTools.tsx`) mapping every known Claude/Codex/Gemini tool to icons, Zod input schemas, and dedicated views (Bash, Edit/MultiEdit, Todo, Task, AskUserQuestion, ExitPlan, Codex patches…); a **custom markdown parser** (not a library) with Mermaid support; diffs via both a custom unified-diff implementation and `@pierre/diffs`; git status parsed client-side from RPC bash output.
- **Voice**: ElevenLabs Conversational AI over LiveKit/WebRTC. A module-level `currentSessionId` routes voice to whatever session you're looking at. Two delivery channels: silent `sendContext()` (contextual updates) vs `sendPrompt()` (triggers agent speech — **queued while anyone is talking**, flushed when VAD says idle; 0.5 threshold, 300 ms silence debounce; agent-speaking beats user-speaking to handle crosstalk). Voice client tools let the assistant send messages to the agent and approve/deny permissions. The ElevenLabs provider is **remounted per session** (generation counter) because LiveKit rooms can't be reused after disconnect.
- **Push**: Expo notifications; the client continuously reports app focus (`appState`, including web tab visibility) so the **server** suppresses pushes when you're already looking; notification taps deep-link to the exact session.
- Web niceties: favicon changes when permissions are pending, dynamic tab titles, ⌘K command palette, browser back/forward integration. Platform-split files (`.web.tsx`) for voice, purchases, crypto, QR, editors.
- Curiosities: an e-ink compatibility Expo plugin; `deriveKey` uses `.slice()` not `.subarray()` because the native libsodium TurboModule validates the *underlying* buffer length; a Metro hack pins `preact` to a single CJS instance to keep `@pierre` rendering alive.

---

## 7. `happy-server` — the Blind Relay (102 files)

Fastify 5 + Zod-typed routes + Socket.IO 4.8 (`/v1/updates`), Prisma 6 over Postgres, optional Redis, optional S3/MinIO, Prometheus metrics, pino logs.

- **Data model**: `Account` (keyed by public key; per-user `seq` counter), `Session` (unique per `(account, tag)` for creation idempotency; encrypted metadata + agentState, each version-counted), `SessionMessage` (encrypted content, `seq`, `localId` dedup), `Machine` (encrypted metadata + daemonState), `Artifact`, `AccessKey`, `UserKVStore` (plaintext keys, encrypted values), friends/feed tables, push tokens, encrypted vendor tokens.
- **Realtime**: connections are user-, session-, or machine-scoped (auth in Socket.IO middleware so no events race the handshake). Fan-out via rooms; every persistent update gets a per-account monotonic `seq` for gap detection. Shared state mutations use optimistic concurrency (`expectedVersion` → `version-mismatch` response). Transactions run at **Serializable** isolation with automatic retry on serialization failures and post-commit event emission (`afterTx`).
- **Client↔client RPC with no registry**: a daemon "registers" a method by joining room `rpc:<uid>:<method>`; callers' `rpc-call` is forwarded via `fetchSockets()` + `emitWithAck`. No Redis keys, no TTLs, no heartbeats. The docs record the four production bugs of the previous TTL-based design (including a silent 60 s expiry that was the smoking gun) and the fix: room membership as the single source of truth, a 10 s reconnect grace poll, and a presence-poll race that aborts dead-peer calls in ~1 s instead of the 30 s ack timeout. Integration-tested against a 2-replica minikube cluster (pod-kill fast-fail: 1.6 s vs 30 s), with a POSTMORTEM.md.
- **Push**: direct HTTP to the Expo Push API (no SDK), batched; per-message pushes were deliberately removed (too noisy) in favor of lifecycle events (`done`/`permission`/`question`), and pushes are suppressed whenever any non-backgrounded client is connected.
- **Voice/payments**: server mints single-use ElevenLabs WebRTC conversation tokens; usage tracking is **stateless** — ElevenLabs itself is queried as the source of truth (last 30 days), keyed by the HMAC-pseudonymous user id. Tiers: free 20 min/30 d → RevenueCat subscription → 5 h hard cap → bring-your-own agent (unlimited, $0). Measured cost: ~$0.01/min.
- **Two deployment shapes from one codebase**: (a) production Kubernetes (3-replica Deployment `handy-server`, Redis streams adapter for cross-replica Socket.IO, Vault ExternalSecrets, MinIO/S3, Prometheus/Grafana overlays) — though the manifest currently ships `replicas: 1` and `connectionStateRecovery` is coded but disabled; (b) a **zero-dependency standalone Docker image** for self-hosters: embedded **PGlite** (WASM Postgres) via a driver adapter, local file storage, a hand-rolled migration runner, and the web app bundled and served statically. Self-hosting is a first-class community concern (npm package `happy-server-self-host`).

### `happy-wire`
A deliberately tiny shared-contract package: Zod schemas for the encrypted message container, the legacy decrypted payload shapes, `MessageMeta` (permission mode, model, tool allowlists), voice API types, and the **unified session envelope** — 9 event types (`text`, `service`, `tool-call-start/end`, `file`, `turn-start/end`, `start`, `stop`) with cuid2 identities, turn ids, and nestable subagent ids. The file header candidly marks it **"UNDER REVIEW / frozen — do not add new consumers"**, noting the team may adopt pi.dev's agent protocol instead. Both legacy and modern formats travel *inside* the encrypted blob; the outer wire role `'session'` marks modern payloads.

---

## 8. The Session Protocol (how agent output becomes phone UI)

Happy is mid-migration from provider-specific formats (`output`/`codex`/`acp`) to one flat, provider-agnostic event stream (docs/session-protocol.md):

- Envelope: `{ id(cuid2), time, role: user|agent, turn?, subagent?, ev }` — agent events without a `turn` are ignored; provider-native ids (Claude `toolu_*`) must never leak into the protocol (adapters mint cuid2s).
- Claude mapping rules are precisely specified: assistant text → `text`; thinking → `text{thinking}`; non-Task tool_use → `tool-call-start`; **Task tool_use emits no parent tool-call** — it registers a subagent mapping and buffers orphan subagent messages until the parent is known; sidechain user strings become subagent `start` + `text`.
- Restart/duplication safety is engineered explicitly: the local JSONL scanner seeds a processed-keys set; remote mode relies on strict queue ordering plus synthetic interrupted tool-results; user prompts typed in a *parallel* `claude --resume` terminal are deduped against app-sent prompts via a 5-minute text ring buffer.
- Transitional state: the Claude mapper currently emits **both** legacy `user:text` and a shadow modern `session:text` for the same prompt — a live migration shadow-write.

Permission modes form a superset (`default | acceptEdits | bypassPermissions | plan | read-only | safe-yolo | yolo`) mapped down to what each SDK supports, with a documented 4-level resolution priority on the app side and an invariant that sandboxed sessions can never re-enable permission prompts mid-flight.

---

## 9. The Rest of the Ecosystem

- **`happy-agent`** — headless control plane: `auth login` (QR), `machines`, `list`, `status`, `spawn --machine`, `resume`, `create`, `send --yolo --wait`, `history`, `stop`, `wait` (exit-code semantics for scripting). Prefix-matching on all IDs. This powers the experimental **software factory** (docs/experimental/): a "Manager" agent dispatches "Engineer" agents into git worktrees and steers them by reading their Happy sessions — the team's own verdict: "hasn't sped up development yet."
- **`codium`** — an early Electron desktop shell that embeds `@anthropic-ai/claude-code`, the Claude Agent SDK, and `@openai/codex` in-process, with Lexical/ProseMirror editors, an embedded terminal (node-pty), Yjs, and a design system reverse-engineered from OpenAI's Codex desktop app via Chrome DevTools sampling (documented in `design-system.md`: ~149 CSS custom properties derived from 5 atomic inputs via `color-mix(in oklab, …)`).
- **`environments/`** — a ~1,000-line homegrown dev-environment orchestrator: `pnpm env:new` allocates ports, seeds a dev account, copies the **lab-rat-todo-project** fixture (a todo app with intentional bugs), and can expose the whole environment to a real phone via **Tailscale funnel**. The fixture ships a **24-step scripted agent-conformance walkthrough** (`exercise-flow.md`) covering every protocol primitive — permissions, subagents, interruption, compaction, resume.
- **`patches/`** — five plain-JS node_modules monkey-patches applied on postinstall (no patch-package): PGlite/Prisma Bytes serialization, an ElevenLabs/LiveKit voice-breaking 404, `@pierre` CSS exposure for WebViews, and two Preact-singleton fixes for Metro.
- **`docs/competition/`** — protocol teardowns of OpenCode ("best end-to-end reference"), Codex ("cleanest typed app-server"), Claude Code ("best agent-team workflow but leaks state to ~/.claude"), and **Superset** ("best orchestration layer + Electric SQL sync reference; 2,100+ commits in 5 months with 3 people") — with an explicit "design direction for Happy" synthesis.

---

## 10. Development Culture & Community

- **Contributing**: review priority is bugs > UI > features > refactors > core refactors (core changes need prior discussion); PRs must include **proof it works** (video/screenshots of a real running app — unit tests alone are insufficient); automated Codex review comments must be addressed before human review.
- **Analytics philosophy** (docs/product-analytics.md): few canonical PostHog events extended by properties (`message_sent` with a `source` property, never per-surface send events); analytics identity is the master-secret-derived anonID.
- **Community** (self-report, 2026-04): 17.8k stars, 502 contributors (70% issue-only), top pain points Session Management (158 issues) and Codex/multi-agent (99); low retention (5.6% return a second month) but high quality; a community champion (leeroybrun) built the entire self-hosting ecosystem; a security researcher filed 7 vulnerabilities in one day (QR auth expiry, wildcard CORS, Docker root, RevenueCat bypass…).
- **Roadmap** (intent): first-class "workspace"/"checkout" concepts (per-machine working copies with daemon-managed worktree lifecycle), a three-column desktop layout with a diff-viewer context panel (`layout-core.md` — mostly aspirational), encrypted attachments everywhere, embedded terminal, scheduled agents/crons, smarter push routing (currently *all* devices get *all* notifications; web push is missing entirely), multi-agent fan-out, and a Bun-compiled single-binary server.

---

## 11. Most Notable Design Decisions (ranked)

1. **E2E encryption as the architecture, not a feature** — key-pair identity with no passwords, per-session DEKs wrapped to a content public key, a blind relay storing only ciphertext + sequence numbers, pseudonymous identities toward every third party (ElevenLabs, PostHog), and a candidly documented boundary (vendor keys and KV keys are not E2E).
2. **Wrap the real thing** — local mode runs the authentic Claude Code TUI with inherited stdio and observes it via transcript tailing + an fd-3 fetch-patch, rather than re-implementing a UI or hiding the agent behind a PTY. Fidelity first; the remote SDK mode exists only when the phone takes over.
3. **RPC over Socket.IO rooms with zero registry state** — after four production bugs with a TTL/Redis design, they rebuilt on room membership as truth, with a presence-poll race for fast dead-peer detection, integration tests against a real 2-replica cluster, and a postmortem in the repo.
4. **One reducer to unify three agent dialects** — Claude, Codex, and Gemini formats normalize into a single structured history with argument-level permission↔tool matching and sidechain reconstruction; the unified session protocol (flat stream, adapter-minted cuid2 ids, buffered orphan subagents) is being migrated in with shadow-writes.
5. **Self-hosting as a product line** — the same server codebase ships as a K8s deployment and as a zero-dependency Docker image with embedded WASM Postgres (PGlite), local storage, and the bundled web app.
6. **Voice with real unit economics** — stateless usage metering (ElevenLabs as source of truth), HMAC-pseudonymous users, a three-tier gate (free/subscribed/BYO-agent), VAD-aware prompt queueing, and a paywall driven by one RevenueCat template + a `flow` variable.
7. **Docs as institutional memory** — architecture docs with named intent-vs-implementation gaps, competitor protocol teardowns steering design, a 24-step manual conformance script, and even an honest write-up of a failed multi-agent "software factory" experiment.
8. **Pragmatic monkey-patching** — five hand-rolled node_modules patches (Metro/Preact/LiveKit/PGlite) applied by a plain postinstall script, each with a war-story comment.
9. **Resume that survives everything** — daemons persist session encryption keys to disk; `HAPPY_RECONNECT_*` re-attachment; fork backfill replaying JSONL; mtime-based upgrade detection; Ctrl-C treated as a blip rather than a death.
10. **Sandbox-or-prompts, never neither** — enabling the OS sandbox (Seatbelt via `@anthropic-ai/sandbox-runtime`) deliberately forces `--dangerously-skip-permissions` and locks that state against mid-session change.

---

## 12. Known Inconsistencies & Loose Ends (from the code and the docs themselves)

- `api.md` lists `POST /v1/voice/token`, but the implementation is `POST /v1/voice/conversations` (api.md is stale).
- `backend-architecture.md` says Redis is "only pinged"; in reality the Redis streams adapter actively powers multi-replica fan-out when `REDIS_URL` is set.
- Multi-process support is merged but production ships `replicas: 1`; `connectionStateRecovery` is implemented but commented out (clients do full REST re-fetch on reconnect by design).
- The `VoiceConversation` Prisma table is dead (usage moved to ElevenLabs-as-source-of-truth) with an explicit removal TODO.
- `sessionProtocol.ts` in happy-wire is frozen pending a decision on adopting pi.dev's protocol; legacy and unified message formats coexist with shadow-writes.
- `happy-cli/CLAUDE.md` describes an obsolete architecture (handy-cli, node-pty, "permissions not implemented") — historical only.
- Push routing is primitive (all devices, no device metadata, no web push) — acknowledged in the roadmap.
- `layout-core.md`'s three-column desktop layout and the provider-envelope redesign are proposals, not implementation.

---

## 13. Happy vs. Superset (the two repos in this workspace)

Both orbit the same problem — supervising CLI coding agents away from the keyboard — from opposite ends:

| | **Happy** | **Superset** |
|---|---|---|
| Center of gravity | Phone/web remote control of *your existing* agent sessions | Desktop IDE orchestrating *many parallel* agents in worktrees |
| Privacy model | End-to-end encrypted; zero-knowledge relay | Cloud control plane with org-scoped row filtering (not E2E) |
| Agent integration | Wraps the real CLI (stdio inheritance + transcript tailing) or drives SDKs | Terminal presets + shell shims + agent hooks in durable PTYs |
| Sync | Encrypted Socket.IO events, per-user seq counters | Electric SQL logical-replication shapes into client SQLite |
| Server | Fastify blind relay; self-hostable single container | Neon Postgres + Next.js API + Fly.io relay + CF Worker |
| License | MIT | Elastic 2.0 |

Notably, Happy's own `docs/competition/superset/` studies Superset's Electric SQL sync as a reference — the two projects are aware of each other.

---

## 14. Quick File Map (for future navigation)

| Area | Start here |
|---|---|
| Product/overview | `README.md`, `docs/README.md`, `docs/roadmap.md` |
| Encryption | `docs/encryption.md`, `packages/happy-cli/src/api/encryption.ts`, `packages/happy-app/sources/sync/encryption/` |
| Wire protocol | `docs/protocol.md`, `packages/happy-wire/src/`, `docs/session-protocol.md` |
| Claude wrapper | `packages/happy-cli/src/claude/{loop.ts,claudeLocal.ts,claudeRemote.ts}`, `scripts/claude_local_launcher.cjs` |
| Codex wrapper | `packages/happy-cli/src/codex/{runCodex.ts,codexAppServerClient.ts}` |
| Daemon | `packages/happy-cli/src/daemon/{run.ts,controlServer.ts}` |
| Pairing/auth | `packages/happy-cli/src/ui/auth.ts`, `packages/happy-app/sources/auth/` |
| App sync engine | `packages/happy-app/sources/sync/{sync.ts,apiSocket.ts,reducer/reducer.ts,typesRaw.ts}` |
| Tool rendering | `packages/happy-app/sources/components/tools/knownTools.tsx` |
| Voice | `docs/voice-architecture.md`, `docs/paid-voice.md`, `packages/happy-app/sources/realtime/` |
| Server core | `packages/happy-server/sources/app/{api/socket.ts,events/eventRouter.ts,api/socket/rpcHandler.ts}` |
| DB schema | `packages/happy-server/prisma/schema.prisma` |
| RPC design + postmortem | `docs/realtime-sync-and-rpc.md`, `docs/multi-process.md`, `packages/happy-server/deploy/integration-tests/` |
| Self-host | `Dockerfile`, `packages/happy-server/sources/standalone.ts` |
| Dev environments | `environments/environments.ts`, `environments/lab-rat-todo-project/exercise-flow.md` |
| Competitive research | `docs/competition/comparison-matrix.md` |
| Community/roadmap | `docs/current-community.md`, `docs/roadmap.md`, `docs/CONTRIBUTING.md` |
