# Falcon — Technical System Design

**Version:** 0.2 (Draft)
**Date:** 2026-07-15
**Companion doc:** `falcon-prd.md` (requirements; FR-x.x references below point there)
**Scope:** MVP = CLI + daemon + relay server + web PWA. Remote sandboxing deferred (schema hooks only).

**v0.2 revision (design review outcome):**
1. **Writes moved off WebSocket onto idempotent HTTP** — WS is now read-only (updates/ephemerals) + RPC wake-ups. (Happy's own roadmap corrects this same mistake.)
2. **Seq scoping fixed** — per-account seq only for header-level changes; message ordering is per-session. Kills the hot-row bottleneck under parallel chatty sessions.
3. **Large payloads (diffs, files) go through encrypted blobs**, not chunked RPC acks.
4. **Postgres-only** — self-host ships as docker-compose with real Postgres; no second SQL dialect to maintain.
5. **Notification fallback channel** (Telegram/ntfy bridge) to cover unreliable iOS web push.
6. **Honest E2E boundary documented** — web client trust caveat (§5.3, §12).
7. Hardening: spawn idempotency keys, first-wins permission answers, event coalescing + message retention, WS backpressure policy, additive-only encrypted-schema policy.
8. Stack updates: **Drizzle ORM** (was Prisma); web = **Next.js PWA + shadcn/ui + Tailwind CSS + TanStack React Query**.

---

## 1. Design Principles

1. **Fidelity over abstraction.** Local mode runs the *real* provider CLI untouched; we observe, we don't re-implement. Every abstraction we add must be invisible at the terminal.
2. **The server is blind.** All user content (messages, metadata, diffs, attachments) is encrypted client-side. The server routes ciphertext and coordination metadata only. No feature may be designed that requires the server to read content.
3. **Derived state over stored state.** Attention, liveness, "thinking" — computed from event streams and timestamps, never persisted as flags that can go stale.
4. **Truth lives in one place per fact.** Provider transcript = conversation truth. Server DB = sync/ordering truth. Daemon = process truth. Clients cache, never own.
5. **Everything reconnects.** Every process (CLI session, daemon, web client) must tolerate the other side vanishing and recover to a consistent state via re-fetch, not replay.
6. **Design for the deferred.** `executionTarget`, checkpoint APIs, and preview namespaces exist in the schema now so sandboxing bolts on without a protocol break.

---

## 2. System Topology

```
┌─────────────────────────────── USER'S MACHINE ───────────────────────────────┐
│                                                                              │
│  Terminal                                                                    │
│  ┌─────────────────────────────┐      ┌──────────────────────────────────┐   │
│  │ falcon CLI (session proc)   │      │ falcon daemon (1 per machine)    │   │
│  │  • provider adapter          │◄────►│  • machine-scoped WS to server   │   │
│  │    - claude local (spawn)    │ HTTP │  • RPC: spawn/stop/resume/git/fs │   │
│  │    - claude remote (SDK)     │ loop-│  • process registry + liveness  │   │
│  │    - codex (app-server RPC)  │ back │  • transcript indexer (adoption) │   │
│  │  • mode state machine        │      │  • session persistence (resume) │   │
│  │  • permission pipeline       │      │  • tmux spawner                  │   │
│  │  • E2E encrypt/decrypt       │      └───────────────┬──────────────────┘   │
│  │  • session-scoped WS         │                      │                     │
│  └──────────────┬───────────────┘                      │                     │
│                 │ ~/.falcon/ (settings, keys, daemon.state.json, sessions)   │
└─────────────────┼──────────────────────────────────────┼─────────────────────┘
                  │ WSS session-scoped        WSS machine-scoped
                  ▼                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  falcon-server (zero-knowledge relay)                                        │
│  Fastify: REST /v1 = ALL WRITES (idempotent) + fetch/pagination              │
│  Socket.IO: WS /v1/stream = READ-ONLY updates/ephemerals + RPC transport     │
│  ├─ auth: OAuth sign-in + Ed25519 challenge/response + JWT                   │
│  ├─ event router: header-seq (account) + msg-seq (session), room fan-out     │
│  ├─ rpc router: room-membership registry, presence-poll dead-peer detect;    │
│  │              small control-plane payloads ONLY (large data → blobs)       │
│  ├─ push: Web Push (VAPID) + fallback bridge (Telegram/ntfy),                │
│  │        presence-suppressed, lifecycle events only                         │
│  ├─ blobs: S3-compatible presigned upload/download (encrypted blobs;         │
│  │         also the path for large diffs/file contents)                      │
│  └─ storage: Postgres 16 (prod AND self-host via docker-compose)             │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ WSS user-scoped (read) + REST (write/fetch)
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  falcon-web (Next.js PWA · shadcn/ui · Tailwind CSS · TanStack React Query)  │
│  sync engine (seq fast-path + refetch) · message reducer/normalizer ·        │
│  session UI (timeline, permission cards, composer) · service worker (push)   │
│  key custody (IndexedDB, crypto worker) · new-session & takeover flows       │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Connection scopes** (one WS namespace, three client types declared at handshake):

| Scope | Who | Purpose |
|---|---|---|
| `user` | Web app | Receive all account updates; issue RPCs to daemons/sessions |
| `session` | CLI session process | Publish session events; receive messages/RPCs for that session |
| `machine` | Daemon | Publish machine state; receive machine RPCs (spawn etc.) |

---

## 3. Monorepo & Tech Stack

```
falcon/
├─ packages/
│  ├─ wire/           # @falcon/wire — Zod schemas: ALL wire messages, events,
│  │                  #   RPC contracts, enums. Zero runtime deps beyond zod+cuid2.
│  ├─ crypto/         # @falcon/crypto — isomorphic (node + browser) key hierarchy,
│  │                  #   AES-GCM / NaCl box+secretbox, base64, recovery codes.
│  ├─ cli/            # `falcon` npm package + standalone binaries.
│  │  └─ src/{index,commands/,claude/,codex/,daemon/,api/,adopt/,ui/,sandbox-stub/}
│  ├─ server/         # falcon-server. Fastify 5 + Socket.IO 4 + Drizzle ORM.
│  │  └─ src/{main,app/{api,auth,events,rpc,push,presence,blobs},db/{schema,migrations}/}
│  ├─ web/            # falcon-web. Next.js (App Router, static/PWA output) + React 19.
│  │  │                #   shadcn/ui + Tailwind CSS; TanStack React Query for REST.
│  │  └─ src/{app/,sync/,reducer/,components/{ui,session,tools}/,crypto-bridge/,push/}
│  └─ shared-render/  # session-timeline components shared with future clients (P2)
├─ docs/              # protocol.md, encryption.md, adoption.md, rpc.md, runbooks/
├─ e2e/               # conformance harness (scripted agent exercise, chaos tests)
└─ deploy/            # docker/{server,standalone}, compose, k8s (later)
```

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript everywhere, Node ≥ 20 for CLI/daemon | One language, shared wire/crypto packages; both reference codebases (Happy/Omnara-class) prove it |
| CLI packaging | npm package + `bun build --compile` standalone binaries (mac arm64/x64, linux x64) | curl-install path without Node; npm path for devs |
| CLI TUI bits | Ink (React) for auth selector + remote-mode status view only | Never wraps the provider TUI |
| Server HTTP | Fastify 5 + zod type-provider — **all writes are HTTP, idempotent** | Typed routes; retryable write semantics beat WS emits (Happy's own v3 migration validates this) |
| Server WS | Socket.IO 4 (websocket transport, polling fallback) — **read-only stream + RPC transport** | Rooms, acks, cluster adapter path; the RPC design below leans on rooms |
| ORM/DB | **Drizzle ORM + Postgres 16 — prod and self-host (docker-compose)** | One SQL dialect, one migration set (drizzle-kit); Drizzle is lightweight, SQL-first, no codegen step |
| Cache/scale-out | None at MVP (single server process); Redis streams adapter ready behind `REDIS_URL` | Don't pay the multi-replica tax until needed; adapter slot reserved |
| Web | **Next.js (App Router) built as a static PWA** + React 19; **shadcn/ui + Tailwind CSS** for the component layer; **TanStack React Query** for REST fetch/mutation + Zustand for the WS-fed stores | Next.js gives routing/code-splitting/PWA tooling for free; shadcn/Tailwind is the fastest credible path to a polished session UI; Query's retry/invalidation model matches the seq+refetch sync design. Web app is statically exported and served from a separate origin (see §12 trust boundary) — no server-side rendering of user content (it's ciphertext to the server anyway) |
| Crypto | libsodium (sodium-native in CLI, libsodium-wrappers in web) + WebCrypto AES-GCM | Audited primitives; matches the published Happy scheme we're adopting |
| Push | Web Push (VAPID) via `web-push` | PWA-first; native push later |
| Blobs | S3-compatible (MinIO in dev/self-host, R2/S3 in prod) | Encrypted blobs only |

---

## 4. Wire Protocol (`@falcon/wire`)

### 4.1 Encryption container (outermost, everything user-content crosses in this)

```ts
// What the server stores/routes for any content field:
type EncryptedBox = { t: 'enc'; v: 1; c: string /* base64 */ };

// Inside c (after AES-256-GCM decrypt): a JSON payload of the schemas below.
// Binary layout of c: [ver(1)=0x01 | nonce(12) | ciphertext | gcmTag(16)]
```

### 4.2 Session event envelope (provider-agnostic, flat stream)

Adapter-minted IDs only. Provider-native ids (`toolu_*`, Codex ids) never cross the wire; adapters keep a local map.

```ts
type SessionEnvelope = {
  id: string;          // cuid2, minted by the adapter
  time: number;        // epoch ms
  role: 'user' | 'agent';
  turn?: string;       // cuid2; agent events without a turn are dropped by renderers
  subagent?: string;   // cuid2; presence ⇒ sidechain/subagent scope
  ev: SessionEvent;
};

type SessionEvent =
  | { t: 'text'; md: string; thinking?: boolean }
  | { t: 'service'; text: string }                                  // status lines, agent-only
  | { t: 'tool-start'; call: string; name: string; title?: string;
      args: unknown; risk?: 'read' | 'write' | 'exec' | 'network' }
  | { t: 'tool-end'; call: string; ok: boolean; output?: unknown }
  | { t: 'file'; ref: string; name: string; size: number;
      image?: { w: number; h: number; thumbhash: string } }         // upload-first
  | { t: 'turn-start' }
  | { t: 'turn-end'; status: 'completed' | 'failed' | 'cancelled' }
  | { t: 'perm-request'; reqId: string; call?: string; name: string;
      args: unknown; modes: PermissionMode[] }                      // options offered
  | { t: 'perm-resolve'; reqId: string; decision: PermDecision }
  | { t: 'mode-switch'; control: 'local' | 'remote'; by: 'terminal' | 'client' }
  | { t: 'sub-start' } | { t: 'sub-stop' };                          // subagent lifecycle

type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
type PermDecision =
  | { kind: 'allow'; scope: 'once' | 'session'; updatedInput?: unknown }
  | { kind: 'deny'; message?: string }
  | { kind: 'mode'; mode: PermissionMode };   // resolve by switching mode
```

### 4.3 Server↔client update stream

Two channels on the WS: **`update`** (persistent, seq-ordered) and **`ephemeral`** (volatile).

```ts
// server → client, persistent.
// seq = account headerSeq for structural updates; ABSENT on message-new
// (message ordering/gap-detection uses the per-session msgSeq instead — §4.3).
type Update = { seq?: number; ts: number; body: UpdateBody };
type UpdateBody =
  | { t: 'session-new';     session: SessionRow }         // rows carry EncryptedBox fields
  | { t: 'session-update';  id: string; metadata?: Versioned<EncryptedBox>;
                            agentState?: Versioned<EncryptedBox>; status?: SessionStatus }
  | { t: 'session-delete';  id: string }
  | { t: 'message-new';     sessionId: string; msgSeq: number; localId?: string;
                            content: EncryptedBox }
  | { t: 'machine-new' | 'machine-update'; machine: MachineRow }
  | { t: 'unmanaged-new' | 'unmanaged-update'; item: UnmanagedSessionRow }  // adoption (Tier 1)
  | { t: 'account-update';  settings: EncryptedBox };

type Versioned<T> = { value: T; version: number };

// server → client, volatile (never persisted, never gap-checked)
type Ephemeral =
  | { t: 'activity'; sessionId: string; working: boolean }        // "thinking" indicator
  | { t: 'machine-presence'; machineId: string; online: boolean }
  | { t: 'attention'; sessionId: string;
      kind: 'perm' | 'question' | 'done' | 'failed' };            // drives in-tab badges
```

```ts
// client → server, over WS: ONLY volatile signals and RPC transport. No writes.
type ClientEmit =
  | { e: 'alive'; sessionId: string; working: boolean }           // volatile keepalive
  | { e: 'rpc-register'; methods: string[] }                      // daemon/session side
  | { e: 'rpc-call'; target: string; method: string; params: EncryptedBox } // ack-based
  | { e: 'app-state'; state: 'active' | 'background' };           // push suppression input

// client → server, over HTTP: ALL persistent writes (idempotent, retryable).
// POST /v1/sessions/:id/messages   {localId, content}            → {seq} | 200-replay on dup
// PUT  /v1/sessions/:id/metadata   {expectedVersion, value}      → {version} | 409 {current}
// PUT  /v1/sessions/:id/state      {expectedVersion, value}      → {version} | 409 {current}
// POST /v1/sessions                {tag, provider, metadata, dek} → create-or-get by tag
```

**Why HTTP for writes:** unambiguous delivery semantics. A WS emit racing a reconnect is "maybe sent"; an HTTP POST with a `localId` idempotency key can be retried blindly until a 2xx arrives (disk-backed outbox in the CLI, Query mutation retry in the web app). WS delivery of the resulting `update` is merely a latency optimization — correctness never depends on it.

**Ordering contract (two-level):**
- **Header stream (account-level `seq`):** only structural changes — session created/deleted/status, machine changes, metadata/state version bumps. Low write rate ⇒ the per-account counter is not a hot row. Clients track `lastSeq`; fast path applies `seq === lastSeq + 1`; any gap ⇒ `GET /v1/sync?since=<seq>`.
- **Message stream (per-session `msgSeq`):** high-rate transcript events order within their session only. `message-new` updates carry `msgSeq`; a per-session gap ⇒ paginated re-fetch of that session only. Parallel chatty sessions never contend on a shared counter.

No server-side event replay; `connectionStateRecovery` stays off. **Backpressure:** ephemerals are droppable — the server coalesces `activity`/`attention` per session (latest-wins) when a client's send buffer exceeds a threshold; persistent updates are never dropped (a slow client just falls back to the refetch path).

**Optimistic concurrency:** metadata/state PUTs return `409 {current: {value, version}}` on mismatch; callers re-read, re-apply, retry (×3).

### 4.4 RPC contracts

RPC method names are scope-prefixed: `m:<machineId>:<method>` and `s:<sessionId>:<method>`. Params/results are `EncryptedBox` (server can't read RPC bodies either).

```ts
// Machine RPCs (registered by daemon)
'spawn'        (SpawnParams)  → { sessionId }        // FR-4.3
'stopSession'  ({sessionId, force?})→ { ok }
'resumeSession'({sessionId})  → { ok }               // re-spawn w/ reconnect env
'listSessions' ()             → { sessions: LocalSessionInfo[] }
'git.status'   ({worktree})   → { branch, ahead, behind, files: FileStatus[] }
'git.diff'     ({worktree, path?, baseRef?}) → { inline?: string; blobRef?: string }
'fs.read'      ({worktree, path, range?})   → { inline?: string; blobRef?: string; truncated }
'adopt.list'   ({workspaceId})→ { items: ProviderSessionSummary[] }   // FR-9.1/9.2
'adopt.take'   ({providerSessionId, mode: 'takeover'|'fork'}) → { sessionId } // FR-9.3/9.4

// Session RPCs (registered by session process)
'message'      ({envelope})   → { queued: boolean }   // remote composer input
'perm.answer'  ({reqId, decision: PermDecision}) → { ok }
'interrupt'    ()             → { ok }
'takeControl'  ()             → { ok }                // triggers local→remote switch
'setMode'      ({mode: PermissionMode}) → { ok }

type SpawnParams = {
  idempotencyKey: string;   // cuid2 minted by caller; daemon replays the prior result
                            // on a retried key — an RPC retry must NEVER double-spawn
  workspaceId: string; directory: string;
  provider: 'claude-code' | 'codex';
  permissionMode: PermissionMode; model?: string;
  branch?: { name: string; createWorktree: boolean };   // P1
  continueFrom?: { providerSessionId: string };          // session import path
};
```

**RPC routing design (server):** a connection "registers" a method by joining Socket.IO room `rpc:<accountId>:<method>`. `rpc-call` resolves the room, forwards with `emitWithAck` (30 s cap). Two hardening rules (from the reference postmortem):
1. If the room is empty, wait a **reconnect grace window** (10 s, 200 ms poll) before failing with `target-offline`.
2. While a call is in flight, run a **presence poll** (1 s interval, 2 misses ⇒ abort with `target-died`) racing the ack — dead peers fail in ~2 s, not 30.

No TTLs, no external registry: room membership (cleaned on disconnect) is the single source of truth.

**Payload size rule:** RPC is control-plane only — params/results must stay under 64 KB. Anything larger (diffs, file contents, transcript mirrors) is encrypted by the producer, uploaded as a blob (presigned PUT), and referenced by `blobRef` in the RPC result. Socket.IO acks have no streaming and poor large-payload behavior; the blob path reuses the attachment pipeline and keeps the relay light. All mutating RPCs (`spawn`, `adopt.take`, `stopSession`) carry idempotency keys with daemon-side result replay.

---

## 5. Encryption Design (`@falcon/crypto`)

### 5.1 Key hierarchy

```
masterSecret (32B, generated client-side at signup; NEVER leaves clients unwrapped)
 ├─ HKDF("falcon-auth")    → ed25519 seed → signing keypair   (server auth challenge)
 ├─ HKDF("falcon-content") → x25519 seed → content keypair    (wraps DEKs)
 ├─ HKDF("falcon-anon")    → anonId (16 hex)                  (analytics identity)
 └─ HKDF("falcon-blob-master") → legacy/global blob key       (rarely used)

Per session / per machine record:
  DEK = random 32B
    • payload encryption: AES-256-GCM  [0x01 | nonce12 | ct | tag16]
    • blob key: HKDF(DEK, "falcon-blobs")   → attachments isolated from text
  wrapped DEK = sealed-box(contentPubKey, DEK) = [ephPub32 | nonce24 | ct]
  stored server-side as opaque `dek` column: [0x00 | sealedBox]
```

- **Unwrap never throws:** decrypt failures return `null`; the record renders as "undecryptable" and sync continues (one bad key must not poison a batch).
- **Recovery:** masterSecret exportable as grouped Base32 (11×5 chars), error-tolerant re-entry (0→O, 1→I, 8→B, 9→G).

### 5.2 Auth flows

**Sign-up (web-first):** browser generates masterSecret → derives keys → OAuth (Google/GitHub/email) binds an identity for recovery/contact → `POST /v1/auth/register {oauthProof, signPubKey, contentPubKey}` → server creates Account keyed by `signPubKey`, returns JWT.

**Sign-in (returning device):** device has masterSecret (or restores via recovery code / pairing) → `POST /v1/auth/challenge` → sign 32B challenge with ed25519 → JWT (1 h, auto-refresh).

**CLI pairing (FR-2.4):**
```
CLI                                    Server                        Web (has keys)
 │ ephemeral x25519 keypair              │                                │
 │ POST /v1/auth/pair {ephPub} ─────────►│ create PairRequest             │
 │ print URL: app.falcon.dev/pair#ephPub │                                │
 │ poll GET /v1/auth/pair/status ───────►│◄── POST /v1/auth/pair/approve ─│
 │                                       │    {box(ephPub, [0x00|masterSecret… or contentKey bundle])}
 │◄── {state:'authorized', box, token} ──│                                │
 │ decrypt with ephPriv → store ~/.falcon/access.key                      │
```
The server relays an opaque box; it cannot read the key material.

### 5.3 What the server can/cannot see (published table, FR-6.4)

| Server CAN see | Server CANNOT see |
|---|---|
| account ids, public keys, OAuth identity | message/metadata/diff/attachment plaintext |
| machine ids, hostnames? — NO: hostname is inside encrypted machine metadata | session titles, prompts, code |
| seq numbers, versions, timestamps, session ids/tags | DEKs (stored wrapped) |
| push subscriptions, app-focus state | RPC params/results |
| workspace *ids* (display names encrypted) | provider tokens (never uploaded at all) |

**Honest trust boundary (must appear in public security docs):** the E2E guarantee is strongest for the **CLI** (installed, checksummed binary — the server can never read or influence its key handling). For the **web app**, encryption protects against database breach and passive operator access, but the client code itself is served — a malicious or compromised server could ship key-exfiltrating JavaScript. Mitigations (required, not optional): web app statically exported and served from a **separate origin** than the API, strict CSP (no inline/eval, no third-party scripts), Subresource Integrity on all bundles, reproducible builds published with checksums, and CLI-as-key-origin as the recommended setup. We do not market "we can't read your code" without this asterisk.

**Encrypted-schema evolution policy:** the server can never migrate ciphertext. Every encrypted payload carries a version; payload schemas are **additive-only, forever** — clients must decode all historical versions, enforced by a wire-schema compat lint in CI and golden fixtures per version. A field is never repurposed; deprecation means ignore-on-read.

---

## 6. Server Design (`packages/server`)

### 6.1 Data model (Drizzle ORM, Postgres, abridged)

```ts
// src/db/schema.ts — drizzle-kit generates migrations from this
export const accounts = pgTable('accounts', {
  id:            text('id').primaryKey().$defaultFn(createId),
  signPublicKey: text('sign_public_key').notNull().unique(),   // hex; identity anchor
  contentPubKey: text('content_pub_key').notNull(),
  oauthProvider: text('oauth_provider'),                       // recovery binding
  oauthSubject:  text('oauth_subject'),
  headerSeq:     integer('header_seq').notNull().default(0),   // account-level: HEADER changes only
  settings:      customType.bytea('settings'),                 // EncryptedBox
  createdAt:     timestamp('created_at').notNull().defaultNow(),
});

export const machines = pgTable('machines', {
  id:                 text('id').primaryKey().$defaultFn(createId),
  accountId:          text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  metadata:           customType.bytea('metadata').notNull(),  // enc: host, os, cliVersion…
  metadataVersion:    integer('metadata_version').notNull().default(0),
  daemonState:        customType.bytea('daemon_state'),        // enc: pid, port, startedAt…
  daemonStateVersion: integer('daemon_state_version').notNull().default(0),
  dek:                customType.bytea('dek').notNull(),       // wrapped DEK
  lastSeenAt:         timestamp('last_seen_at'),
}, (t) => [index().on(t.accountId)]);

export const workspaces = pgTable('workspaces', {
  id:              text('id').primaryKey().$defaultFn(createId),
  accountId:       text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  metadata:        customType.bytea('metadata').notNull(),     // enc: name, paths, baseRef, remote
  metadataVersion: integer('metadata_version').notNull().default(0),
  dek:             customType.bytea('dek').notNull(),
  // ---- deferred sandbox hooks (unused at MVP) ----
  syncEnabled:     boolean('sync_enabled').notNull().default(false),
  sandboxConfig:   customType.bytea('sandbox_config'),
});

export const sessions = pgTable('sessions', {
  id:                text('id').primaryKey().$defaultFn(createId),
  accountId:         text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  workspaceId:       text('workspace_id'),
  machineId:         text('machine_id'),
  tag:               text('tag').notNull(),                    // client-minted; creation idempotency
  provider:          text('provider').notNull(),               // 'claude-code' | 'codex'
  executionTarget:   text('execution_target').notNull().default('local'), // 'sandbox' deferred
  status:            text('status').notNull().default('active'),
  metadata:          customType.bytea('metadata').notNull(),   // enc: title, path, providerSessionId…
  metadataVersion:   integer('metadata_version').notNull().default(0),
  agentState:        customType.bytea('agent_state'),          // enc: pending perms, control mode…
  agentStateVersion: integer('agent_state_version').notNull().default(0),
  dek:               customType.bytea('dek').notNull(),
  msgSeq:            integer('msg_seq').notNull().default(0),  // per-session message counter
  createdAt:         timestamp('created_at').notNull().defaultNow(),
  updatedAt:         timestamp('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex().on(t.accountId, t.tag),
  index().on(t.accountId, t.updatedAt),
]);

export const sessionMessages = pgTable('session_messages', {
  id:        text('id').primaryKey().$defaultFn(createId),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq:       integer('seq').notNull(),                         // per-session, gapless
  localId:   text('local_id'),                                 // sender idempotency
  content:   customType.bytea('content').notNull(),            // EncryptedBox of SessionEnvelope[]
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex().on(t.sessionId, t.seq),
  uniqueIndex().on(t.sessionId, t.localId),
]);

export const unmanagedSessions = pgTable('unmanaged_sessions', {  // adoption Tier 1 (FR-9.1)
  id:          text('id').primaryKey().$defaultFn(createId),
  accountId:   text('account_id').notNull(),
  machineId:   text('machine_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  providerRef: text('provider_ref').notNull(),                 // opaque provider uuid
  summary:     customType.bytea('summary').notNull(),          // enc: title, lastActivity, running?
  dek:         customType.bytea('dek').notNull(),
  updatedAt:   timestamp('updated_at').notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.machineId, t.providerRef)]);

export const pairRequests      = pgTable('pair_requests', { /* id, ephPub unique, state, response bytea, token, expiresAt */ });
export const pushSubscriptions = pgTable('push_subscriptions', { /* id, accountId, channel: 'webpush'|'telegram'|'ntfy', endpoint unique, keys jsonb, createdAt */ });
export const blobs             = pgTable('blobs', { /* id, accountId, sessionId?, size, contentHash, createdAt — content lives in S3, encrypted */ });
```

Notes:
- All `bytea` content columns are `EncryptedBox` payloads (custom Drizzle type `customType.bytea`).
- **Two-level seq allocation:** message ingest bumps only `sessions.msgSeq` (`UPDATE … SET msg_seq = msg_seq + 1 RETURNING msg_seq` — contention scoped to one session row). `accounts.headerSeq` bumps only on structural changes (session create/delete/status, version bumps). Parallel chatty sessions never serialize on a shared counter.
- Ingest transaction: default READ COMMITTED + row-lock via the atomic UPDATE (no Serializable retry storms); dedup on `(sessionId, localId)` returns the existing row (HTTP 200 replay). Post-commit hook emits WS updates — never inside the tx.
- **Event coalescing (write-rate control):** the CLI batches transcript envelopes client-side (flush every 300 ms or 20 events, whichever first) into one `content` payload per POST — one row per flush, not per event. The reducer treats a message's content as `SessionEnvelope[]`.
- **Retention:** `session_messages` will dwarf all other tables. From M4: sessions archived > 90 days get their messages compacted into a single encrypted blob (S3) + tombstone rows; configurable for self-host. Schema reserves `sessions.status = 'compacted'`.

### 6.2 REST surface (`/v1`)

```
POST /auth/register | /auth/challenge | /auth/refresh
POST /auth/pair     GET /auth/pair/status     POST /auth/pair/approve
GET  /sync?since=<headerSeq>            // account snapshot headers (sessions, machines, unmanaged)
GET  /sessions?cursor&changedSince      // paginated
POST /sessions                          // create-or-get by tag (idempotent)
POST /sessions/:id/messages             // THE write path: {localId, content} → {seq}; replay-safe
PUT  /sessions/:id/metadata             // CAS: {expectedVersion, value} → 409 {current} on mismatch
PUT  /sessions/:id/state                // CAS: same contract
GET  /sessions/:id/messages?before=<seq>&limit
POST /sessions/:id/archive   DELETE /sessions/:id
GET  /machines   DELETE /machines/:id
POST /push/subscribe   DELETE /push/subscribe
POST /blobs/request-upload   POST /blobs/request-download     // presigned URLs
POST /version                            // client update gate
GET  /health   GET /metrics (bind-local)
```

### 6.3 Event router

- On connect: join `acct:<id>`; plus `acct:<id>:user` / `acct:<id>:sess:<sid>` / `acct:<id>:mach:<mid>` per scope.
- Recipient filters: `all-user`, `user-clients-only`, `session-interested` (session room ∪ user clients), `machine-only`.
- Presence: `alive` pings + socket connect/disconnect update an in-memory presence cache (write-behind to `lastSeenAt` every 30 s); a sweep marks machines offline after 90 s silence and emits `machine-presence`.

### 6.4 Push pipeline

Trigger points (from session event ingest): `perm-request`, `agent question` (perm-request with `name: 'AskUserQuestion'`), `turn-end(status!=cancelled)` after remote-initiated turns, `session failed`.
Suppression: skip if any user-scoped connection reports `app-state: active` **and** has the session's room joined (visible). Re-notify unanswered `perm-request` at +5 min, +10 min (max 3). Payload contains only `{sessionId, kind}` — title/body are generic ("Falcon: agent needs permission") unless the client opts into locally-rendered rich notifications (service worker fetches + decrypts the detail).

**Fallback channels (iOS reality):** Web Push on iOS Safari requires an installed PWA and is unreliable — and the notification IS the product. `push_subscriptions.channel` supports `webpush | telegram | ntfy`: users can link a Telegram bot (`/start` deep-link pairing) or an ntfy.sh topic as a secondary channel. Same lifecycle-only events, same suppression rules, same generic payloads (`{sessionId, kind}` + deep link — no content). Cheap to build, extremely reliable, buys time until a native app.

### 6.5 Deployment shapes

- **Prod:** Docker → Fly/Render/K8s; managed Postgres 16, S3/R2, single app process at MVP (Socket.IO cluster adapter + Redis reserved behind env flag).
- **Self-host:** **docker-compose, Postgres included** — `server` + `postgres:16` (+ optional `minio`; blobs fall back to local disk when unset). Web app statically served by the server process. One `docker compose up`, config via env only, `migrate` runs on boot. **Rationale:** one SQL dialect and one drizzle-kit migration set forever; a compose file with real Postgres is boring and bulletproof, and self-hosters overwhelmingly run compose anyway. (Embedded-DB single binary reconsidered post-MVP only if demand shows.)

---

## 7. CLI Design (`packages/cli`)

### 7.1 Process anatomy

Each `falcon <provider>` invocation is a **session process**: owns exactly one Session, one session-scoped WS, one provider adapter instance, and the mode state machine. The daemon is a separate long-lived process (§8). Session processes self-register with the daemon over the loopback control API (`POST /session-started` with pid, sessionId, wrapped DEK) so the daemon can track/persist/resume them.

### 7.2 Local state (`~/.falcon/`)

```
settings.json        # schema-versioned; atomic write via lock file (O_CREAT|O_EXCL + rename)
access.key           # {token, masterSecret | contentKey bundle} — 0600
daemon.state.json    # {pid, controlPort, version, startedAt, logPath} + .lock
sessions.json        # finished/active session records incl. wrapped DEKs (resume survival)
logs/…               # file-only logging; NEVER stdout (would corrupt provider TUI)
bin/                 # optional shims (Tier 3 adoption): claude, codex → falcon
```

### 7.3 Provider adapter interface

```ts
interface ProviderAdapter {
  readonly id: 'claude-code' | 'codex';
  detect(): Promise<{ installed: boolean; authenticated: boolean; version?: string }>;
  startLocal(opts: StartOpts): LocalHandle | null;   // null ⇒ provider has no local TUI (codex)
  startRemote(opts: StartOpts & { resume?: string }): RemoteHandle;
  listRecentSessions(dir: string): Promise<ProviderSessionSummary[]>;   // adoption/import
  importTranscript(ref: string): AsyncIterable<SessionEnvelope>;        // JSONL → envelopes
}

interface RemoteHandle {
  send(prompt: UserInput): void;                    // queued if mid-turn
  interrupt(): Promise<void>;
  onEvent(cb: (e: SessionEnvelope) => void): void;
  onPermission(cb: (req: PermRequest) => Promise<PermDecision>): void;  // blocking
  setMode(m: PermissionMode): void;
  stop(): Promise<{ providerSessionId: string }>;   // for later resume
}
```

### 7.4 Claude adapter

**Local mode (fidelity path):**
- Spawn via `cross-spawn`: `node claude_launcher.cjs <passthrough args>` with `stdio: ['inherit','inherit','inherit','pipe']`. Before spawn: `setBlocking(stdin)` (clear `O_NONBLOCK` left by Ink — known garbled-TTY bug class).
- The launcher `require()`s the user's installed Claude CLI; injects `--append-system-prompt` (Falcon context note), a `SessionStart` hook via temp `--settings` file (reports the real provider session UUID to a loopback hook server), and passes through everything else. fd 3 carries `fetch-start/fetch-end` JSON lines from a `global.fetch` patch → working/idle signal (hostname+path only).
- **Transcript tailer:** watch `~/.claude/projects/<slug>/<uuid>.jsonl`; on each appended line → `sessionProtocolMapper` → `SessionEnvelope[]` → **coalescing buffer (flush every 300 ms or 20 envelopes)** → encrypt one batch → `POST /sessions/:id/messages {localId}` via a **disk-backed outbox** (retry with backoff until 2xx; localId makes blind retries safe). Dedup by provider record uuid (`processedKeys` set seeded on start). The mapper implements the Claude→envelope rules: assistant text → `text`; thinking → `text{thinking}`; non-Task `tool_use` → `tool-start`; **Task `tool_use` → subagent registration (no parent tool card)** + orphan buffering until parent known; `tool_result` → `tool-end`; sidechain user strings → subagent `text`.
- Local mode **cannot answer permissions remotely** (prompts live on the provider's TTY). Provider hooks (`Notification`/`Stop` hooks in the temp settings) still fire attention events → dashboard shows "waiting at the terminal" (FR-3.6).

**Remote mode:** `query()` from `@anthropic-ai/claude-agent-sdk` with `resume: providerSessionId`; prompts pushed via an async iterable; `canUseTool` callback = the permission pipeline (§7.6); SDK stream → `SDKToEnvelope` converter → **ordered outgoing queue** (strict incremental order; tool-start release may be delayed until stable). Terminal shows the Ink status view ("controlled from web — Ctrl-T to take back").

### 7.5 Mode state machine

```
        ┌─────────── falcon starts (default local; --starting-mode remote for spawns) ──────────┐
        ▼                                                                                       │
   ┌─────────┐   remote msg arrives / takeControl RPC     ┌──────────┐                          │
   │  LOCAL   │ ────────────────────────────────────────► │  REMOTE  │                          │
   │ real TUI │   1. graceful-stop provider process       │ SDK-driven│                         │
   │ tailer on│   2. mode-switch envelope emitted         │ Ink status│                         │
   └─────────┘   3. startRemote({resume})                 └──────────┘                          │
        ▲                                                        │                              │
        │   Ctrl-T / double-space(confirm)                       │                              │
        └──── 1. remoteHandle.stop() → providerSessionId ────────┘                              │
              2. startLocal(claude --resume <id>)                                               │
              3. mode-switch envelope                                                           │
   Exit paths: Ctrl-C/SIGTERM ⇒ session stays `active` (resumable). Explicit archive ⇒ archived.
   Crash ⇒ status `failed` + error surfaced. Loss-less guarantee: cross-mode dedup ring buffer
   (message text + ids, 5-min window) — SDK writes app prompts to disk too, so the tailer must
   not re-send them.
```

### 7.6 Permission pipeline (remote mode)

```
SDK canUseTool(name, args)
  → auto-rules: plan-mode read-only tools ⇒ allow; acceptEdits ⇒ edits allow;
                bypassPermissions ⇒ allow; AskUserQuestion/ExitPlanMode ⇒ ALWAYS prompt
  → else: reqId = cuid2
      1. write into agentState.requests[reqId] (encrypted, versioned CAS update)
      2. emit perm-request envelope (timeline card)
      3. push notification (kind: perm)
      4. await decision promise
  ← decision arrives via s:<id>:perm.answer RPC (or local timeout policy: re-notify ×3, keep waiting)
  → emit perm-resolve envelope; clear agentState.requests[reqId]; return mapped decision to SDK
```

**First-wins across devices:** two clients may answer the same request concurrently. The session process resolves each `reqId` exactly once (atomic check-and-delete on the pending map); the losing `perm.answer` gets `{ok: false, reason: 'already-answered', decision}` and the client renders "answered on another device" instead of an error.

### 7.7 Codex adapter (M3)

`codex app-server` child, JSON-RPC 2.0 over stdio (hand-rolled client — official SDK lacks approval support). Approvals (`exec:request`, `patch:request`) → same permission pipeline. No local TUI mode: `falcon codex` always runs the programmatic path with the Ink status view; `startLocal()` returns null and the CLI prints an honest note. Thread lifecycle: `newConversation`/`resumeConversation`; events mapped by `codexEnvelopeMapper`.

### 7.8 Adoption module (`src/adopt/`, FR-9.x)

- `falcon adopt [--remote] [--list]`: enumerate provider transcripts in cwd's workspace (`listRecentSessions`), preselect most recent, import history (stream `importTranscript` envelopes with a `imported: true` meta flag), then continue via local `claude --resume` (default) or remote SDK (`--remote`).
- Identity mapping: resume mints a new provider session id → session metadata records `providerSessionLineage: [old, new, …]`; the tailer switches files accordingly.
- Takeover-from-phone: daemon RPC `adopt.take` → find owning pid (process scan matching transcript file handles / cwd) → if running: SIGTERM, wait ≤ 5 s, SIGKILL fallback → spawn `falcon claude --starting-mode remote --continue-from <id>`. `mode: 'fork'` skips the kill and copies the transcript to a fresh lineage.

---

## 8. Daemon Design (`packages/cli/src/daemon/`)

- **Singleton:** atomic lock file (hard-link with pid payload; stale detection via `kill(pid, 0)`).
- **Loopback control API** (Fastify on `127.0.0.1:0`, port in `daemon.state.json`, bearer = local secret): `/session-started`, `/list`, `/spawn-session`, `/stop-session`, `/stop`.
- **Machine WS:** registers machine RPCs (§4.4), heartbeats every 60 s (prunes dead session pids via `kill(pid,0)`), publishes encrypted daemonState with CAS versioning.
- **Spawner:** tmux preferred (`tmux new-session -d -s falcon-<sid>`), detached child fallback. Env allowlist expansion (`${VAR}` from daemon env, fail-fast on unresolved). Auth for spawned sessions: local `access.key` (never through the server).
- **Session registry:** `pid → TrackedSession`; spawn↔self-report matched by pid with 15 s awaiter; finished sessions persisted to `sessions.json` **including wrapped DEK + seq + versions** so resume survives daemon restarts (FR-4.4).
- **Transcript indexer (adoption Tier 1):** fs-watch provider transcript dirs for registered workspace paths; debounce 2 s; on change, upsert `UnmanagedSession` (encrypted summary: title guess, last-activity, running-pid?) — skipping sessions already managed (lineage lookup). Read-only mirror on demand: when a user opens an unmanaged session in the dashboard, the daemon streams the transcript via chunked RPC rather than uploading whole histories eagerly (bandwidth + privacy frugality).
- **Self-update:** watch installed artifact mtime (not version string); restart when idle.
- **Service install (P1):** launchd plist / systemd-user unit / schtasks, all labeled `dev.falcon.daemon`.

---

## 9. Web App Design (`packages/web`)

**Stack:** Next.js (App Router, **static export** — no SSR of user content, it's ciphertext server-side anyway), React 19, **shadcn/ui + Tailwind CSS** for components/theming (dark default), **TanStack React Query** for all REST fetches and mutations, Zustand for WS-fed live stores. Served as a PWA from a separate static origin (§5.3 trust boundary).

### 9.1 State architecture

```
┌ apiSocket (user-scoped WS, READ-ONLY) ─ update/ephemeral ─┐
│                                                           ▼
│   syncEngine (plain TS singleton)                 stores
│   • headerSeq + per-session msgSeq tracking       • Zustand: live session map,
│   • gap ⇒ Query invalidation (/v1/sync,             machines, unmanaged, ephemerals
│     per-session message pages)                    • React Query: REST reads
│   • decrypt boundary (crypto-bridge worker)         (messages pagination, sync
│   • reconnect/focus ⇒ invalidate all queries        snapshot) + write mutations
└───────────────────────────────────────────────────────────┘
   Writes: Query mutations → POST/PUT /v1/… with localId/expectedVersion
   (automatic retry; optimistic timeline insert reconciled by echo update)
```

- **Division of labor:** React Query owns request-shaped state (fetch, cache, retry, pagination, mutations); Zustand owns stream-shaped state (live envelope feed, presence, attention). WS updates land in Zustand for latency; correctness always recoverable via Query invalidation — never depends on WS delivery.
- **Never show a loading error — retry silently** (invalidate on focus/reconnect; Query's `refetchOnWindowFocus` + WS reconnect hook).
- Decryption runs in a **Web Worker** (`crypto-bridge`): keys live in worker memory, loaded from IndexedDB at startup; UI thread sees plaintext view-models only.
- **Reducer** (`src/reducer/`): folds `SessionEnvelope[]` into render items — turn grouping, tool-start/end pairing, perm-request/resolve pairing (by reqId; fallback name+args match), subagent nesting, dedupe by envelope id, imported-history merge (adoption). Pure + idempotent; golden-trace tests (`trace_*.json` fixtures recorded from real sessions).

### 9.2 Screens & key components

| Screen | Components | Notes |
|---|---|---|
| Home | `SessionList` (grouped by workspace, machine badges, attention dots), `UnmanagedSection` | status = derived: working/perm/question/done-unseen/idle/offline |
| Session | `Timeline` (virtualized), `ToolCard` registry (Bash, Edit+diff, Read, Grep, Todo checklist, Task/subagent group, MCP generic), `PermCard` (Allow/Deny/Allow-session/mode), `Composer` (queue-aware), `ControlBar` (interrupt, mode selector, take-control) | all built on shadcn/ui primitives (Card, Dialog, DropdownMenu, Badge, Collapsible…); markdown via unified/remark + shiki; diffs via `@pierre/diffs` or custom unified renderer |
| New session | machine → workspace/dir → provider/model/permission mode → (branch P1) → spawn via RPC | continue-from-recent embedded (import + takeover entries) |
| Machine | daemon status, sessions, stop daemon, remove | |
| Settings | account, recovery code export, notifications, appearance | |

### 9.3 PWA & push

Service worker: precache shell, `push` handler → decrypt-or-generic notification → `notificationclick` deep-link `/session/<id>`. Tab title + favicon reflect max attention state (FR-7.9). `app-state` reported on visibility/focus changes (suppression input).

---

## 10. Key Sequence Flows

### 10.1 Start & mirror (UC1)

```
user: falcon
 CLI ── ensure auth (access.key) ── ensure daemon (spawn if needed)
 CLI ── POST /v1/sessions {tag, provider, enc(metadata), wrappedDEK} ─► server (create-or-get)
 CLI ── WS connect (session-scoped) ── daemon loopback /session-started
 CLI ── adapter.startLocal() ─► real claude TUI up (< 800 ms overhead budget)
 hook: SessionStart → providerSessionId → metadata CAS update
 tailer: jsonl lines → envelopes → coalesce (300 ms) → encrypt →
         POST /sessions/:id/messages {localId} (disk outbox, retry-safe)
 server: msgSeq alloc → insert (localId dedup) → fan-out update{message-new} → web appends
```

### 10.2 Remote permission approval (UC2)

```
[remote mode] SDK canUseTool → pipeline: agentState CAS + perm-request envelope + push
 phone: notification → open session → PermCard → Allow(session)
 web ── rpc-call s:<sid>:perm.answer {reqId, decision} ─► server ─► session proc
 session: resolve promise → perm-resolve envelope → SDK continues
 SLO: decision→continue p95 < 2 s
```

### 10.3 Remote message while local (UC3 → mode switch)

```
web composer → rpc-call s:<sid>:message
 session proc (LOCAL): queue non-empty ⇒ initiate switch:
   graceful-stop claude (SIGINT; transcript already on disk)
   emit mode-switch{control:remote, by:client}
   startRemote({resume: providerSessionId}) → drain queue → turn runs
 terminal: Ink status view replaces TUI
 user back at desk: Ctrl-T → remoteHandle.stop() → claude --resume <newId> → mode-switch{local}
```

### 10.4 Takeover of a plain claude session (UC9)

```
daemon indexer: unmanaged row visible on phone (live read-only mirror via chunked RPC)
 phone: "Take over" → confirm (mid-turn warning if running)
 web ── rpc-call m:<mid>:adopt.take {providerRef, mode:'takeover'}
 daemon: find pid → SIGTERM (≤5 s) → spawn falcon claude --starting-mode remote --continue-from <ref>
 new session proc: import transcript (imported envelopes) → resume via SDK → sessionId back to web
 web: navigates to new managed session; unmanaged row marked adopted (lineage link)
```

### 10.5 Reconnect/resync (any client)

```
WS reconnect → emit app-state → GET /v1/sync?since=headerSeq
 if server returns gap-too-old ⇒ full snapshot refetch
 per-open-session: GET messages?before/after msgSeq cursors → reducer merge (idempotent)
 outbox: HTTP outbox never stopped retrying — nothing special to do on reconnect
 (writes are independent of WS state by design)
```

---

## 11. Failure Modes & Recovery Matrix

| Failure | Detection | Recovery | Data risk |
|---|---|---|---|
| Session proc crash | daemon pid probe; WS drop | status `failed`; resumable via `falcon resume` (transcript intact) | none (transcript on disk) |
| Daemon crash | CLI can't reach loopback; machine offline ephemeral | any `falcon` cmd respawns; registry rebuilt from `sessions.json` + process scan | none |
| Server down | WS drop, REST 5xx | CLI disk outbox keeps retrying POSTs (10 MB cap, backoff); web shows offline banner; Query retries reads | delayed sync only |
| Double perm answer (two devices) | session proc atomic resolve | loser gets `already-answered` + decision; UI shows "answered elsewhere" | none |
| RPC retry after timeout | idempotency key on mutating RPCs | daemon replays stored result; no double-spawn | none |
| Laptop sleeps mid-turn | heartbeat gap ⇒ machine offline | on wake: reconnect, tailer catches up from file offset | in-flight SDK turn aborted ⇒ turn-end{cancelled} |
| Mode-switch race (remote msg + local typing) | state machine serializes via single mode owner | queue holds remote msg until switch completes; dedup buffer kills doubles | none |
| Version mismatch (CAS) | `version-mismatch` response | re-read current, re-apply, retry ×3 | none |
| Wedged provider process | takeover/stop timeout | SIGKILL fallback; `falcon kill sessions` escape hatch | current turn only |
| Undecryptable record | unwrap returns null | render "undecryptable item"; continue batch | isolated record |

---

## 12. Security Considerations

- **Threat model:** honest-but-curious server operator (mitigated by E2E); stolen server DB (ciphertext + wrapped keys only); stolen device token (scoped JWT, revocable per machine); malicious web XSS (CSP strict, keys in worker, no third-party scripts).
- Loopback daemon API: bearer-protected, bound to 127.0.0.1; spawn params validated against registered workspace paths (no arbitrary-directory execution from remote).
- RPC bodies encrypted ⇒ server cannot inject commands even if compromised (client verifies structure post-decrypt).
- Rate limits: auth endpoints, pair polling, msg ingest per session.
- Secrets never in argv (env or stdin); logs scrub tokens; `FALCON_DEBUG` never logs plaintext content.
- Supply chain: lockfiles, provenance-pinned deps, minimal native modules (sodium-native, better-sqlite3), release artifacts signed + checksummed.

---

## 13. Observability & Testing

**Observability:** server Prometheus metrics (WS connections by scope, RPC latency/outcome histograms, seq-allocation rate, push outcomes, presence sweeps); pino structured logs; client-side: file logs (CLI), opt-in error reporting (web). No content, ever.

**Testing strategy:**
1. **Golden-trace reducer tests** — recorded real Claude/Codex transcripts → expected render trees.
2. **Provider contract tests (CI, daily)** — run latest Claude Code against fixture prompts in a container; assert transcript format assumptions (JSONL fields, hook events, resume behavior). Breakage pages the team before users see it.
3. **Conformance harness (`e2e/`)** — scripted 20-step session exercising every primitive (perm allow/deny/allow-session, question, interrupt, mode switch ×2, adoption takeover, reconnect) against a real local stack; run pre-release.
4. **Chaos suite** — kill daemon mid-turn, kill server mid-send, sleep/wake simulation, double-takeover race.
5. **RPC integration tests** — dead-peer fast-fail (<2 s), reconnect grace, presence flap.
6. Unit tests co-located; wire schemas snapshot-tested for backward compat (additive-only lint).

---

## 14. Deferred-Feature Hooks (sandboxing et al.)

- `Session.executionTarget` + `Workspace.syncEnabled/sandboxConfig` columns exist, unused.
- Wire reserves namespaces: `checkpoint:*` (workspace sync), `preview:*` (live previews), `voice:*`.
- `falcon workspace sync|load` commands print "coming soon" and are wired to no-op handlers behind a feature flag, keeping help output honest.
- Daemon RPC surface versioned (`rpc.hello` exchanges `{cliVersion, rpcRev}`); additive evolution policy documented in `docs/rpc.md`.

---

## 15. Engineering Decisions — resolved & open

**Resolved in v0.2:**

| # | Decision | Resolution |
|---|---|---|
| R1 | Write transport | HTTP (idempotent POST/PUT); WS read-only. Non-negotiable after review |
| R2 | Seq model | Two-level: account headerSeq (structural) + per-session msgSeq (messages) |
| R3 | Large RPC payloads | Encrypted blobs + `blobRef`; RPC capped at 64 KB control-plane |
| R4 | ORM | Drizzle (SQL-first, no codegen, one dialect) |
| R5 | Self-host DB | Postgres via docker-compose; no embedded-DB dialect fork |
| R6 | Web stack | Next.js static-export PWA + shadcn/ui + Tailwind + TanStack React Query |
| R7 | Notification reliability | Fallback channels (Telegram/ntfy) alongside Web Push at MVP |
| R8 | Socket.IO vs native ws | Socket.IO stays (RPC design depends on rooms; it no longer carries writes, shrinking the blast radius) |

**Still open:**

| # | Decision | Options | Leaning |
|---|---|---|---|
| 1 | Web key custody default | worker-held IndexedDB vs CLI-first pairing | worker + recovery code; revisit for enterprise |
| 2 | Transcript granularity for unmanaged mirrors | eager blob upload vs on-demand | on-demand (privacy + bandwidth) |
| 3 | Codex depth at M3 | full parity vs beta banner | beta banner |
| 4 | Message compaction cadence & format (§6.1 retention) | blob-per-session vs chunked | decide by M3 with real volume data |
