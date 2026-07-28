# Falcon — Research Notes

Deep-dive research into this repository, compiled 2026-07-27. This is a snapshot of a
fast-moving branch (`trankhacvy/dushanbe`, tracking `main`) — treat file/line references as
current as of this read, not guaranteed to stay exact.

## 1. What Falcon is

Falcon is a **command center for CLI coding agents** — internally described as an
"Omnara-class clone" (`docs/falcon-prd.md`). One-liner: *"Falcon lets you run Claude Code and
Codex on your own machine and control them from anywhere. Start a session in your terminal,
walk away, and keep steering it from your phone or browser."*

The core interaction: type `falcon` instead of `claude`, get an identical local experience,
then get a push notification when the agent needs a permission decision, answer it from a
phone, and watch the session continue. Target: end-to-end second-device control set up in
under 5 minutes.

Three personas drive the product: the **Solo Shipper** (fire off a session, check in later),
the **Multi-Tasker** (dashboard across several parallel sessions), and the
**Tinkerer/Self-Hoster** (wants real end-to-end encryption and a self-hostable stack, not a
SaaS that can read their code).

MVP scope is deliberately **CLI + Remote Control only**; remote/cloud sandboxed execution is
a designed-for-but-deferred capability (schema already reserves an `executionTarget: local |
sandbox` field). Two prior projects shaped the design directly: **Happy** (MIT-licensed,
E2E-encrypted CLI wrapper/daemon/relay — many Falcon modules are direct, credited ports) and
**Superset** (an Electron worktree orchestrator, referenced for derived-state/attention
modeling).

## 2. Monorepo layout

```
packages/
├─ wire/    @falcon/wire    Zod schemas — the sole shared wire-protocol contract. Builds first.
├─ crypto/  @falcon/crypto  Isomorphic E2E encryption primitives (node + browser builds).
├─ cli/     falcon          CLI + daemon + ACP adapter + git/workspace/github/preview subsystems.
├─ server/  @falcon/server  Fastify 5 + Socket.IO 4 + Drizzle/Postgres "zero-knowledge relay".
└─ web/     @falcon/web     Next.js static-export PWA.
```

Every package builds to dual CJS/ESM + `.d.ts` via `pkgroll`. `@falcon/wire` has no
workspace dependencies and everything else imports its *compiled* output, so both
`scripts/postinstall.cjs` and CI build it explicitly before the general build
(`SKIP_FALCON_WIRE_BUILD=1` opts out).

Six governing design principles (`falcon-system-design.md` §1): fidelity over abstraction,
the server is blind, derived state over stored state, "truth lives in one place per fact"
(provider transcript = conversation truth, server DB = sync truth, daemon = process truth),
everything reconnects by re-fetching rather than replaying, and design for the deferred
(sandboxing hooks exist unused today).

### Topology

On the user's machine: a `falcon` **session process** (spawns the real Claude Code TUI
locally and tails its on-disk JSONL transcript for fidelity, or drives a headless **ACP
adapter** child process in remote mode) plus a per-machine **daemon** (singleton, owns a
machine-scoped WebSocket, exposes spawn/stop/resume + git/fs RPCs, prefers tmux for
detached spawns, indexes unmanaged sessions for adoption). Both talk to **falcon-server**,
a "zero-knowledge relay": all writes go over REST `/v1` (idempotent HTTP, not WebSocket —
a deliberate correction of a mistake in the Happy reference design), while Socket.IO
`/v1/stream` is **read-only** (persistent `update` events + volatile `ephemeral` events)
plus an RPC transport. The server fans out to **falcon-web**, the Next.js PWA.

## 3. The encryption / E2E model (the most distinctive part of the system)

This is designed and documented in `falcon-system-design.md` §5 and `docs/encryption.md`,
implemented in `packages/crypto` and consumed end-to-end by `cli` and `web`.

### Key hierarchy

A client-generated 32-byte `masterSecret` never leaves a client unwrapped. It's expanded via
a pure-JS HMAC-SHA512 construction (built on `tweetnacl.hash`, the same shape BIP32 uses for
its root key) into domain-separated 32-byte seeds:

- `HKDF("falcon-auth")` → **Ed25519 signing keypair** — answers the server's login challenge.
- `HKDF("falcon-content")` → **X25519 content keypair** — wraps/unwraps DEKs.
- `HKDF("falcon-anon")` → a 16-hex-char pseudonymous analytics id.
- `HKDF("falcon-blob-master")` → a legacy/rarely-used global blob key.

`deriveDomainSeed(masterSecret, label)` is deterministic, so the same `masterSecret` always
regenerates the same tree on any device. A separate `deriveBlobKey(dek)` roots a per-object
blob key in a session/machine's own DEK rather than the master secret — cryptographically
independent of that same object's text/metadata ciphertext despite sharing a DEK ancestor.

### Data encryption

Every session/machine/workspace record gets its own random 32-byte **DEK**
(AES-256-GCM for payload content). The DEK itself is sealed (NaCl sealed-box, i.e.
`libsodiumEncryptForPublicKey`) to the account's X25519 content public key and stored
server-side only as an opaque wrapped blob (`dek` bytea column) — the server can route it,
never open it.

All user-content fields cross the wire as an `EncryptedBox = {t:"enc", v:1, c:base64}`
(`@falcon/wire`'s `EncryptedBoxSchema`). Every decrypt/open primitive in `@falcon/crypto`
follows a strict **never-throw** contract: malformed input, wrong key length, tampered
ciphertext/auth-tag, or an unknown version byte all collapse to `null` rather than throwing
— extensively regression-tested (`edge-cases.test.ts`) since the underlying `tweetnacl`
library itself throws on bad input and every wrapper has to catch and normalize that.

Primitives, node vs. browser implementation (byte-identical wire formats, proven by
`cross-impl.test.ts`):

| Function | Algorithm | Node | Browser |
|---|---|---|---|
| `encryptWithDataKey`/`decryptWithDataKey` | AES-256-GCM | `node:crypto` | WebCrypto `crypto.subtle` (async-only) |
| `encryptLegacy`/`decryptLegacy` | XSalsa20-Poly1305 (NaCl secretbox) | `tweetnacl` | `libsodium-wrappers` |
| `encryptBlob`/`decryptBlob` | XSalsa20-Poly1305 (raw bytes) | `tweetnacl` | `libsodium` |
| `libsodiumEncryptForPublicKey`/`Decrypt...` | X25519 NaCl sealed box | `tweetnacl.box` | `libsodium crypto_box_easy` |
| `authChallenge` | Ed25519 detached sign | `tweetnacl.sign` | `libsodium crypto_sign_detached` |

AES-GCM wire layout: `[version(1)=0x00 | nonce(12) | ciphertext | authTag(16)]`. Sealed-box
layout: `[ephemeralPubKey(32) | nonce(24) | ciphertext]`.

### What the server can and cannot see (published table, FR-6.4)

Can see: account/machine/session ids, public keys, sequence numbers, schema versions,
timestamps, push subscriptions. Cannot see, ever: message/metadata/diff/attachment
plaintext, DEKs in the clear, or RPC parameter/result bodies (RPC payloads are themselves
`EncryptedBox`es — the relay only routes opaque bytes and never inspects them). Confirmed at
the code level: `packages/server` imports `@falcon/wire` purely for schema validation and
type-only Drizzle column typing, and imports `@falcon/crypto` only for base64/random-byte
utility codecs — never for key derivation or plaintext access.

### The honest trust-boundary caveat

Falcon's docs are explicit that the E2E guarantee is strongest for the CLI (a checksummed,
installed binary) but weaker in principle for the web app: a compromised server *could*
theoretically ship key-exfiltrating JS to a browser. Mitigations: serving the web app from a
**separate static origin** from the API, strict CSP (no inline scripts, no eval, no
third-party scripts), Subresource Integrity on every asset, reproducible static builds, and
recommending the CLI as the trusted "key origin." This principle — "never claim a security
property you haven't verified" — recurs as rule 7 of the project's seven auth/UX principles
and is enforced concretely in `packages/web/src/crypto/device-key.ts`'s docblock (see §6).

### Key epochs and recovery

`accounts.keyEpoch` makes the bound key rotatable. Losing every device that holds the keys
does **not** lose the account — it starts a fresh key epoch, archiving (not erasing) the old
E2E data, reachable only via the deliberately last-resort `/reset-keys/` flow, which states
up front exactly what it erases.

### DEK sharing beyond a single account

`packages/crypto`'s `sessionSharing.test.ts` proves the same `wrapDek`/`unwrapDek` primitive
used for a single account's own devices also works as a scoped grant to a **different**
identity's key tree — e.g. sharing one session's DEK with a teammate by re-wrapping it to
their X25519 content public key, without exposing anything else in the owner's key tree.

## 4. Auth model (post "issue-4" identity/key-custody split)

Documented in `docs/issue-4-plan.md`, implemented across `packages/server/src/auth/`,
`packages/server/src/db/schema.ts`, `packages/cli/src/auth/`, and
`packages/web/src/crypto/` + `src/features/auth/`.

**Identity** and **key custody** are deliberately separate systems (previously fused: a
`signPublicKey` derived from `masterSecret` used to be both the login identity and the
encryption anchor).

- **Identity** (`authIdentities` table) — email+password (argon2id hash) or Google/GitHub
  OAuth, unique on `(kind, identifier)`. Password auth is gated **non-production only**
  (`requireNonProduction`, wired as a `preValidation` hook so it 404s before even reading
  the request body — avoids leaking route existence in prod). Per-identity account lockout:
  5 failures trigger exponential backoff (30s base, doubling, capped at 15 min), and every
  failure mode (no such identity / wrong password / currently locked) returns an identical
  generic 401 to avoid timing/enumeration oracles.
- **Sessions/devices** (`deviceSessions` table) — one row per device, `clientKind` ∈
  `web|cli-daemon|cli-session|cloud-sandbox`. Short-lived (15 min) stateless HS256 access
  JWTs (`jose`, signed with `FALCON_MASTER_SECRET`), refreshed by a **rotating** opaque
  refresh token. `POST /v1/auth/refresh` tracks one level of rotation lineage
  (`previousRefreshTokenHash`) — a replay within a 60-second grace window is treated as a
  benign multi-tab race and re-issued idempotently; a replay outside that window is treated
  as token theft and **revokes the entire device-session family**. Revocation is immediate
  on a live WebSocket (the server actively disconnects the matching socket) and bounded by
  access-token TTL on plain HTTP.
- **Key custody** — the `masterSecret` still lives only on clients. The **PIN has been
  removed entirely** from the current UX (`docs/auth-ux-overhaul-plan.md` Phase 5). It's
  replaced by two wrap modes, chosen once at sign-up:
  - **`"device"` mode** — a non-extractable WebCrypto `CryptoKey` held in IndexedDB.
    Zero-friction (no gesture needed on reload). Explicitly documented as *not* an XSS
    defense — same-origin script can still open the IndexedDB handle and decrypt with it.
    What it actually buys: a raw filesystem/backup copy of the browser profile yields
    ciphertext and a useless key handle, not a portable secret.
  - **`"prf"` mode** — the wrap key is re-derived every page load from a WebAuthn passkey's
    PRF extension, gated by a biometric tap (`userVerification: "required"`). Key material
    never persists at rest at all — a genuine at-rest control (copying the browser profile
    yields nothing that can decrypt), though it still doesn't stop XSS running *after* an
    already-unlocked gesture.
  - Headless Chrome / environments without a platform authenticator auto-resolve to
    `"device"` mode.
- **Daemon custody is necessarily weaker**: a headless daemon can't prompt for a biometric
  gesture, so its holding of `~/.falcon/access.key` (a 0600 plaintext-adjacent file wrapping
  the secret under the machine's OS-vault device key, falling back to a 0600 plaintext file
  if no vault exists) is an intentionally lower bar — raises cost against "another local user
  reads the file," not against full machine compromise.

### The seven auth/UX principles (from `docs/auth-ux-overhaul-plan.md`, restated in root
`CLAUDE.md`)

1. Never print "run X" when you can run X — a missing login is a first run, not an error.
2. Identity gates always run before key-material gates.
3. First device sees zero crypto questions.
4. No internal jargon in UI — banned words `keyEpoch`, `masterSecret`, `bind`, `custody`,
   `bridge`, `epoch`, `DEK`, `nonce`, `ephPub`, enforced by automated tests in both `web`
   (`lib/__tests__/copy.test.ts`) and `cli` (`ui/messages.test.ts`).
5. Never place a destructive control next to a safe one; destructive actions go behind a
   link and state their consequence in the label.
6. Every waiting screen updates itself — no "reopen this link," no manual refresh.
7. Never claim a security property that hasn't been verified — if a control only raises
   cost rather than preventing an attack outright, say so in the same sentence.

These aren't just aspirational — they're mechanically enforced. `web/src/lib/copy.ts`
centralizes every auth-adjacent user-facing string specifically so `copy.test.ts` can walk
every string (recursively, including sampled function outputs) against a banned-word regex,
plus assert specific content rules (e.g. the reset-keys warning must mention
"erase"/"permanently"; the "need keys" body must not start with "run "). The CLI's
`ui/messages.ts` gets an equivalent audit in `messages.test.ts`, additionally asserting that
no message tells the user to run `falcon auth login` except the one legitimate no-TTY
hard-fail case.

### Device pairing (new CLI machine)

`falcon auth login` generates an ephemeral X25519 keypair (never persisted), `POST
/v1/auth/pair {ephPub}` registers a pending request (15-min TTL), and the CLI polls status
every 2s. Once an already-signed-in browser approves (at `/pair/#<ephPub>`), the server
mints a real device session for the CLI (`clientKind: "cli-daemon"`) and the approving
browser seals `[masterSecret | refreshToken]` to the CLI's ephemeral public key — the server
relays only an opaque box it cannot read, and the pairing row is deleted on single-use
pickup. The `/pair/` page in web deliberately checks identity (sign-in) *before* showing any
crypto-related confirmation UI, per principle 2 above.

### Device-to-device key sharing (a keyless-but-signed-in device)

A signed-in browser with no keys posts a key-share request (own ephemeral X25519 pubkey);
the server broadcasts it as a real-time `ephemeral` `key-request` event to every other live
connection on the account (no polling needed on the holder's side). A key-holding device's
`KeyRequestListener` shows an approval card with **server-attested** facts (client kind,
creation time — not just the untrusted display label) plus a 6-digit verification code
computed independently on both sides from the same ephemeral public key
(`sha256(ephPub)` → first 4 bytes mod 1,000,000). This out-of-band code comparison exists
specifically to defeat a phishing gap identified during design review — an attacker who
raises a fake key-share request can be caught because their code won't match what the
requester's own device shows. Both sides carry a `codeMismatch...` warning as a load-bearing
copy pair, checked by `copy.test.ts`.

## 5. `packages/wire` — the protocol contract

Zod-schema-only package (`zod ^4`, `@paralleldrive/cuid2`), no business logic. Notable
modules:

- **`box.ts`** — `EncryptedBoxSchema`, `VersionedSchema<T>` (optimistic-concurrency
  `{value, version}` wrapper for compare-and-swap writes).
- **`session.ts`** — `SessionEventSchema`, a discriminated union of 13 event kinds (`text`,
  `service`, `tool-start`, `tool-end`, `file`, `turn-start`, `turn-end`, `perm-request`,
  `perm-resolve`, `mode-switch`, `permission-mode`, `sub-start`/`sub-stop`, `usage`) wrapped
  in a flat, provider-agnostic `SessionEnvelopeSchema`. This is the format both the Claude
  Code and Codex ACP adapters map their native events onto — provider-native ids never cross
  the wire.
- **`rpc.ts`** (~880 lines, the largest module) — every RPC pair across two families:
  **machine RPCs** (daemon-registered: `spawn`, `git.*`, `fs.*`, `workspace.*`, `adopt.*`,
  `sleepInhibit.*`, `run.*`) and **session RPCs** (`message`, `perm.answer`, `interrupt`,
  `stop`, `takeControl`, `setMode`, `setModel`). Every `RpcCallSchema` envelopes params as an
  opaque `EncryptedBox` — the relay routes bytes, never inspects them. Most mutating machine
  RPCs carry a caller-minted `idempotencyKey` so a lost ack is safe to retry.
- **`updates.ts`** — `UpdateBodySchema` (persisted, seq-ordered structural broadcasts:
  session/machine/unmanaged-session create/update/delete, `message-new`, `account-update`)
  vs. `EphemeralSchema` (volatile, never gap-checked, safe to drop under backpressure:
  activity, machine-presence, attention, `key-request`).
- **`rows.ts`** — wire-visible projections of the DB tables, mirroring Drizzle schema shapes
  with every content field kept as an opaque `EncryptedBox`.
- **`push.ts`** — deliberately content-free push payloads (`{sessionId, kind}` only; actual
  notification titles render client-side, never server-side, to avoid leaking anything
  through a push provider).

### Protocol-evolution enforcement (a standout piece of engineering here)

The package header states the rule directly: schemas are **additive-only forever** — a field
is never removed or retyped, only added; deprecation means "ignore on read," because the
server can never migrate already-stored ciphertext. This is enforced three ways:

1. `schemaShape.ts`'s `describeShape()` walks any Zod schema into a structural fingerprint
   and `isCompatible(prev, next)` proves `next` is a backward-compatible widening of `prev`.
2. `additiveOnly.test.ts` diffs the live schema registry against a checked-in JSON snapshot.
3. `scripts/check-additive-vs-base.ts` (the CI `lint:additive` job) goes further: it
   `git archive`s the wire package's source **as it existed on the PR's base branch**,
   re-fingerprints it with the *current* comparison logic, and fails if anything shipped
   there was dropped or retyped — closing the loophole where a PR could otherwise break a
   schema and regenerate the fixture in the same commit.

## 6. `packages/crypto` — isomorphic primitives

Ported (with MIT attribution) from Happy, then extended with Falcon-specific constructs
(DEK wrap, PIN-wrap, blob-key derivation). Two builds — `.` (node) and `./web` (browser) —
producing byte-identical ciphertext, which lets any client decrypt data encrypted by any
other. `types.ts` is deliberately zod-free so `@falcon/crypto` has zero dependency on
`@falcon/wire` (they can be developed independently; `box.ts`'s `EncryptedBox` shape is
*structurally* identical to wire's schema by convention, not by import).

Legacy PIN-wrapping (`pin.ts`/`pin.web.ts`) still exists and is actively used as the
underlying AES-256-GCM+argon2id wrap mechanism even though the end-user-facing "type a
6-digit PIN" screen is gone — it's now reused by the device-key wrap machinery in both `cli`
and `web`. Argon2id params (64 MiB memory, time cost 3, parallelism 1) are tuned to be
byte-portable across `@node-rs/argon2` (CLI) and `libsodium-wrappers-sumo`'s WASM
`crypto_pwhash` (browser — the lighter "slim" libsodium build used elsewhere omits
`crypto_pwhash` to save bundle size, so the PIN/device-key path specifically pulls in the
heavier "sumo" build).

Testing here is unusually rigorous around two properties that the rest of the system leans
on as guarantees: **never-throw on malformed input** (`edge-cases.test.ts`) and
**cross-platform byte-identical determinism** (`cross-impl.test.ts` — every primitive has a
paired node↔browser test, including tamper-detection parity).

## 7. `packages/cli` (`falcon`)

Binary `falcon` → `dist/index.mjs` (single-file pkgroll bundle). Hand-rolled arg parser
(`src/args.ts`) rather than a CLI framework, so `falcon claude <args>` can forward every
flag verbatim to the real provider binary without needing to know its full flag surface.
Bare `falcon` == `falcon claude`.

### Invocation model ("omnara model")

`falcon claude` spawns the **real** `claude` CLI on a pseudo-terminal
(`claude/ptyClaudeSession.ts`) — the TUI stays fully live in the user's terminal exactly as
if Falcon weren't involved. Remote control rides on the same PTY: a web-sent `message` RPC
is literally **typed into that PTY** when it's idle. Remote answering of the TUI's own
permission prompts uses a single hook server
(`claude/remotePermissionHook.ts`) that owns every Claude Code hook
(`SessionStart`/`Notification`/`Stop`/`PreToolUse`/`PermissionRequest`). A legacy headless
`loop()` path (near-verbatim ported from Happy) is kept only for the daemon-spawned
`--starting-mode remote` flow, where there's no live TUI and the ACP adapter owns
permissions agent-side instead.

Key mechanics: session bootstrap creates/resumes the server-side session row + its DEK; an
`Outbox` mirrors every transcript envelope to the server, buffering to disk if offline; a
`claimStore` claims `(sessionId, envelopeId)` before injecting a remote message so retried
RPCs can't double-run the agent; per-directory session locking prevents two independent
Falcon sessions forking one transcript in the same directory; SIGTERM/SIGHUP/SIGINT are
handled explicitly (never a raw `process.exit()`) to guarantee the lock releases and a
best-effort terminal status reaches the server.

### The daemon

A long-lived, singleton background process, auto-started ahead of any agent-invoking
subcommand (or explicitly via `falcon daemon start`). Runs a local-only HTTP control server
(session registration/list/spawn/stop), a session registry persisted to
`daemon.state.json`, and — if credentials exist — a machine-scoped WebSocket handling
`spawn`/`resumeSession`/`git.*`/`fs.*`/`adopt.*`/`preview.*`/`run.*` RPCs. A 60-second
heartbeat prunes dead session pids and detects its own binary being updated (via bundle
mtime), triggering a graceful handoff to a freshly spawned daemon. `falcon daemon service
install|uninstall` registers it as a real OS service (launchd on macOS, systemd `--user` on
Linux), backing the documented `docs/uninstall.md` teardown path.

### ACP adapter (`src/acp/`)

ACP = Agent Client Protocol (`@agentclientprotocol/sdk`), a JSON-RPC-over-NDJSON-stdio
standard Falcon uses to drive managed adapter subprocesses (`claude-agent-acp`,
`codex-acp`) for headless/remote sessions — this is how Claude Code and Codex both get
bridged into Falcon's single session model without bespoke per-provider integration.
`acpToEnvelope.ts` is the pure, provider-agnostic mapper from ACP `session/update`
notifications onto wire's closed `SessionEnvelope` schema (text-chunk coalescing,
tool-call buffering until args are known, subagent scoping, stop-reason mapping) — unknown
update kinds are logged and dropped rather than passed through, keeping the wire schema
closed. This whole subsystem is the CLI's **current active workstream** (`plan.md` §17,
"v2: ACP migration") — replacing earlier hand-rolled SDK/JSON-RPC integrations, marked
complete as of the doc's latest entries.

### Auth (`src/auth/`)

`falcon auth login` always prints a pairing URL/QR and best-effort opens a browser; the CLI
owns no separate OAuth flow of its own (the web app owns identity). After pairing, the
master secret is always device-key-wrapped (no PIN, even when run interactively) and
persisted to `~/.falcon/access.key` (mode 0600). `~/.falcon/device.key` holds the OS-vault
fallback plaintext device key; `~/.falcon/github.key` holds a separately-managed GitHub
token (device-flow or PAT, never touching the Falcon server — "the server decrypts
nothing" extends to third-party credentials too).

### Subsystems

- **Git**: implements `git.diff`/`status`/`commit`/`push`/`branches`/`worktree` RPCs. Diffs
  truncate to a 60KB inline budget at a line boundary with a best-effort full-diff blob
  upload fallback; worktrees for the `spawn -b <branch>` flow live at
  `<repo>/.worktrees/<branch>`.
- **Workspace**: `~/.falcon/workspaces.json` registers known directories by realpath
  (doubling as `workspaceId`); per-workspace `{baseRef, remote, setupScript, runScript}`
  config lives in `settings.json` — scripts are defined CLI-side only, never sent as an RPC
  parameter.
- **GitHub**: `~/.falcon/github.key` (0600), device-flow OAuth or PAT (prompted on stdin
  only, never as an inline flag, to avoid shell-history/`ps` leakage).
- **Preview**: spawns `cloudflared tunnel --url http://localhost:<port>`, journals the pid
  before a URL is even parsed for crash-safe reaping, caps at 5 concurrent tunnels, and
  closes via SIGTERM → 5s wait → SIGKILL.

### UX enforcement and testing

`src/ui/messages.ts` centralizes CLI auth/first-run copy, audited by `messages.test.ts`
against the same banned-jargon list as web's `copy.test.ts`. 158 test files under `src/`
run via vitest; notable patterns include integration tests for daemon machine-wiring, a
chaos test (`daemon/durability.chaos.test.ts`), golden-trace fixture tests for the ACP
mapper, and standalone (non-vitest) contract-test scripts (`scripts/provider-contract-test.ts`,
`scripts/acp-contract-test.ts`) that run against real, live provider CLIs rather than mocks
— these back a separate scheduled CI workflow (`provider-contract.yml`) that installs the
latest published Claude Code CLI daily to catch upstream transcript/hook format drift before
it silently breaks Falcon.

## 8. `packages/server` (`@falcon/server`)

Fastify 5 app (`app/server.ts`, `fastify-type-provider-zod` — Zod is the
validation/serialization language for every route), built via a `buildServer({deps})`
factory with every dependency (db, oauth verifier, github exchanger, event router, push
dispatcher, blob storage, email transport) injectable — the seam that lets tests swap in a
fake/in-memory Postgres without a real port. `main.ts` runs migrations, builds the server,
and listens. Socket.IO attaches to the *same* underlying Node HTTP server at path
`/v1/stream`, so HTTP and WS share one process/port.

### Schema (`db/schema.ts`, Drizzle + Postgres)

A custom `bytea` type stores opaque `EncryptedBox` envelopes (`db/box.ts`'s
`encodeBox`/`decodeBox` only touch the JSON-visible `{t, v}` metadata, never the ciphertext
`c`). Notable tables: `accounts` (identity anchor, `keyEpoch`, `settings` bytea),
`authIdentities` (password/OAuth identities, per-identity lockout fields),
`deviceSessions` (refresh-token rotation lineage, `clientKind`), `keyBindNonces` /
`passwordResetTokens` (single-use TTL'd tokens), `machines` / `workspaces` / `sessions` /
`sessionMessages` (the core encrypted content model, each with its own wrapped `dek` and
`keyEpoch`), `unmanagedSessions` (adoption tier 1), `pairRequests` (CLI pairing),
`keyRequests` (device-to-device key sharing), `pushSubscriptions`, `telegramLinkRequests`,
`blobs`. ORM patterns favor atomic conditional `UPDATE ... WHERE` (compare-and-swap) over
read-then-write for anything with a race risk — refresh rotation, first-approval-wins on
pairing/key-request approval, etc.

### Real-time (`app/socket.ts`, `app/events/eventRouter.ts`, `app/socket/rpcHandler.ts`)

Auth for socket connections runs in `io.use()` middleware (before `connection` fires, so no
race where events arrive before handlers attach) and includes one DB lookup against
`deviceSessions` at connect time (since an access JWT alone can't carry live revocation).
Clients join rooms scoped by account/session/machine; `emitUpdate`/`emitEphemeral` target
those rooms via a small set of `RecipientFilter` variants. "Log out other devices" is
immediate: the revoke route synchronously calls `disconnectSession()`, which iterates every
live socket on the account and force-disconnects the one matching the revoked
`deviceSessions.id` — not bounded by the access-token's 15-minute TTL. Access tokens renew
in-band on a live socket (`renew-token` emit, re-armed `setTimeout` at each token's `exp`)
so a client that keeps refreshing is never disconnected mid-session.

RPC transport (ported from Happy) resolves targets via Socket.IO room membership (not a
TTL-based registry), races an ack against a 700ms presence poll requiring 2 consecutive
misses before declaring a peer dead (~1-2s dead-peer SLO), and tolerates a 15s reconnect
grace window.

### Push dispatch (`app/push/dispatch.ts`)

Lifecycle-only notifications (`perm`, `question`, `done`, `failed` — deliberately never
per-message, to avoid spam). Checks for an already-visible connected client first (fails
open on error) and per-account/per-session mute flags (also fail open) before fanning out
across pluggable channels (`webpush`, `telegram`, `ntfy` — added specifically because Web
Push is unreliable on iOS Safari). A renotify scheduler arms up to two follow-up attempts
for still-unanswered `perm`/`question` events.

### Migrations

`runMigrations()` (`db/migrate.ts`) runs on every boot before `app.listen`, against
`DATABASE_URL_UNPOOLED` when set (migrations need a direct, non-pooled connection — advisory
locks and long DDL don't survive a transaction pooler like Neon's pooler endpoint or
PgBouncer). Takes a Postgres advisory lock to serialize concurrent migrators, and — added
after a documented incident where a no-op migration run silently booted against a stale
schema — verifies the applied-migration row count against the drizzle journal and throws
loudly on mismatch rather than starting anyway.

### Testing

`app/routes/testHelpers.ts`'s `createTestDb()` spins up `@electric-sql/pglite` (in-memory
WASM Postgres) and runs the real generated migration SQL — a genuine integration test
against real Postgres semantics with no Docker/network dependency. A recent fix (commit
`3174ca6`, referenced in this repo's git log) moved `socket.test.ts` and the RPC handler
tests off a direct import of the real `postgres-js` client (which had started ECONNREFUSING
in CI once the socket handshake began requiring a real `deviceSessions` row) onto this same
pglite pattern.

## 9. `packages/web` (`@falcon/web`)

Next.js App Router, statically exported (`output: "export"`, `trailingSlash: true`, SRI on
every asset except a documented Vercel exception where atomic-deploy chunk-hash mismatches
were blanking pages). Two route groups: `(public)` (landing, `/signin/`, `/password/`
[dev-only], `/pair/`, `/reset-keys/`, OAuth callbacks) and `(protected)` (everything under
`/dashboard/**`, wrapped by a `RequireAuth` → `OfflineBanner` → `AppShell` layout chain).

### Client-side key custody

`src/crypto/device-key.ts` (specifically flagged in this repo's own `CLAUDE.md` as "the
shape of an honest [security] docblock") states its scope bluntly: non-extractability
prevents `crypto.subtle.exportKey`, not *use* — same-origin script (including XSS) can still
open the IndexedDB record and call `decrypt` with the live handle. What it actually buys: a
raw filesystem copy of the IndexedDB store yields ciphertext plus a useless key handle, which
is strictly better than plaintext, but it is explicitly **not** an XSS defense.

Two wrap modes stored in IndexedDB (`falcon-crypto-bridge` DB, `keys` store):
`"device"` (non-extractable AES-GCM CryptoKey, zero-friction) and `"prf"` (re-derived every
page load from a WebAuthn passkey's PRF extension, gated by a biometric tap — key material
never persists at rest). All actual key material (`masterSecret`, derived tree, active DEK,
refresh token) is closed over inside a dedicated Web Worker
(`crypto/worker-handler.ts`) — only booleans, ciphertext, and derived public keys ever cross
back to the main thread. The refresh token itself lives in a *separate* IndexedDB database
(`falcon-session`) under its own wrap key, a deliberate, documented partial walk-back from an
earlier design that had put it inside the same PIN-wrapped record as the master secret —
justified because the refresh token rotates, is theft-detectable, is revocable per-device,
and expires in 60 days, unlike a master secret that "decrypts everything, forever."

### Auth UI

`RequireAuth` runs identity checks (silent refresh) independent of crypto-bridge status —
"signed in, no keys" is treated as a normal, reachable state, not an error — and branches on
a `useCryptoBridgeStatus` state machine (`needs-migration`, `locked-out`, `no-keys`,
`ready`). Session-timeline, git/checks/preview panels, and Settings → Devices (list +
individual/"log out all other devices" revoke, two-click confirm gate implemented as pure,
independently-unit-testable state functions since the package's vitest has no jsdom) round
out the dashboard.

### Zero-machine onboarding

`FirstMachineOnboarding` shows a 3-step "install → cd && falcon → approve in browser" card
when an account has zero machines and zero unmanaged sessions. It has no polling logic of
its own — the parent screen re-renders from the same live-socket-fed TanStack Query cache,
so a machine registering (a `machine-new` structural update over the WS `update` stream)
makes the component simply stop being rendered, with no manual refresh needed — the
concrete implementation of UX principle 6 ("every waiting screen updates itself").

### Sync architecture (`src/sync/`)

A singleton Socket.IO client carries only the read-only `update`/`ephemeral` streams (all
writes are HTTP, per the D1 design delta from Happy). `engine.ts` does two-level gap
detection: an account-level `seq` for structural changes (fast-pathed into cache when
contiguous, else falls back to a full invalidate) and a per-session `msgSeq` for the
higher-rate transcript message stream (tracked only for sessions actually open/cached). Any
reconnect triggers a full cache invalidate rather than attempting silent gap-resume — a
conscious simplicity choice ported from Happy's own postmortem lessons.

## 10. Monorepo tooling & CI

- **Turborepo** (`turbo.json`, schema v2): `build` depends on `^build` (upstream packages
  first); `@falcon/web#build` caches `out/**`+`.next/**` instead of `dist/**`. Two hand-fixed
  race conditions are documented inline: `@falcon/web#typecheck` was widened to also depend
  on its *own* `build` (Next only emits route types as a side effect of `next build`,
  so typechecking concurrently with building intermittently hit `TS6053`), while
  `@falcon/web#test` was narrowed to drop its own-package build dependency (web's unit tests
  import source directly and don't need Next's build output; keeping that dependency caused
  intermittent `next build` corruption from CPU/IO contention with sibling packages'
  concurrent vitest runs). `lint` is *not* turbo-driven — `pnpm lint` runs a flat
  `biome check .` at the root with a one-shot automatic retry to absorb a known transient
  biome-daemon OOM warning. No remote cache is configured; caching is local-only.
- **Biome** (`biome.json`): 2-space indent, 100-char width, double quotes, always-semicolons,
  all-trailing-commas; `noUnusedVariables`/`noUnusedImports` bumped to error;
  `noExplicitAny`/`noConsole`/`noNonNullAssertion` at warn; auto `organizeImports`.
- **TypeScript** (`tsconfig.base.json`): full `strict`, plus explicitly restated individual
  strict flags, plus `noUncheckedIndexedAccess` (beyond default strict) and
  `noImplicitReturns`/`noFallthroughCasesInSwitch`. `noUnusedLocals`/`noUnusedParameters` are
  deliberately turned *off* at the TS level since Biome's linter already owns that check —
  avoids duplicate diagnostics between the two tools.
- **CI** (`.github/workflows/ci.yml`): single job, `pnpm install --frozen-lockfile` → `pnpm
  lint` → `pnpm --filter @falcon/wire build` → (PR only) `pnpm --filter @falcon/wire run
  lint:additive` against the base branch → `pnpm typecheck` → `pnpm test`. Two other
  workflows: `provider-contract.yml` (daily scheduled run against the *latest* published
  Claude Code CLI, catching upstream drift before it silently breaks the transcript
  tailer/ACP adapter) and `release.yml` (tag-triggered: bun-compiled standalone binaries for
  darwin-arm64/x64 + linux-x64, a GitHub Release, a rolling `cli-latest` release for
  `falcon update`'s auto-update mechanism, and `pnpm publish` to npm).
- **`scripts/postinstall.cjs`**: builds `@falcon/wire` first (skippable via
  `SKIP_FALCON_WIRE_BUILD=1`), and separately walks `node_modules/.pnpm` to `chmod 0o755`
  node-pty's macOS `spawn-helper` binary — pnpm's content-addressable store sometimes
  restores it without the executable bit, which silently breaks every local PTY session.
- **Env vars** (root `.env.local`, not committed — dev points at hosted infra, no local
  Docker/Postgres needed): GitHub/Google OAuth client id+secret pairs, `DATABASE_URL`
  (hosted Neon Postgres), `NEXT_PUBLIC_API_URL`, `FALCON_BACKEND_URL`/`FALCON_FRONTEND_URL`
  (point the CLI at a non-default deployment), `JWT_SECRET`, `ENCRYPTION_KEY`,
  `CLOUDFLARE_ACCOUNT_ID` (R2 blob storage), `NODE_ENV`, `LOG_LEVEL`. A separate
  `deploy/.env.example` covers the self-host docker-compose surface (`FALCON_MASTER_SECRET`
  required; optional S3/MinIO, OAuth, VAPID web-push, Telegram, ntfy blocks).

## 11. Deployment

Two documented paths:

- **Self-host** (`deploy/docker-compose.yml`, `deploy/README.md`): one `docker compose up -d
  --build` runs `postgres:16` + `server` (host-only-bound port) + `web` (separate nginx
  container/origin, static export, build args for API origin/OAuth ids/VAPID key baked in at
  build time — the README explicitly warns to rebuild after changing `PUBLIC_API_ORIGIN`) +
  an optional `minio` profile for S3-compatible blob storage (falls back to local disk if
  unset). Password auth is hard-gated off in production (`requireNonProduction`), with a
  documented migration check for anyone with pre-existing password-only accounts who
  upgrades into that gate.
- **Managed/prod** (`QUICK_START.md`, `docs/PROD_DEPLOYMENT_RUNBOOK.md`,
  `docs/VERCEL_DEPLOYMENT.md`): server + Postgres on Docker via a separate
  `docker-compose.prod.yml`, web on Vercel, blobs on Cloudflare R2.

For day-to-day local development specifically, root `.env.local`'s `DATABASE_URL` already
points at a hosted Neon Postgres instance, so **no Docker or local Postgres is needed** to
run or test the stack day-to-day — Docker/docker-compose only matters for self-hosting or
production-shaped testing.

## 12. Product requirements & roadmap highlights

`docs/falcon-prd.md` (v0.1, dated 2026-07-15) sets five MVP goals: wrapper fidelity, remote
control latency under 1.5s median, notification coverage above 60% of permission requests
answered remotely, session durability (<1% unrecoverable), and honestly-caveated E2E trust.
Explicit non-goals for MVP: remote/cloud sandboxed execution, native mobile/watch/desktop
apps, voice, live previews, multi-session orchestration UI, providers beyond Claude
Code/Codex, teams/billing.

The domain model is Account → Machine → Workspace → Worktree → Session (provider:
`claude-code` | `codex`) → execution target (`local` only at MVP). The most architecturally
notable use case is **session adoption** (UC9): bringing a plain `claude`/`codex` session —
one started *without* Falcon — under management via `falcon adopt` or a phone-initiated
"Take over," using the provider's own native resume for lossless continuation. A PATH-shim
"auto-adoption" approach (silently intercepting bare `claude`/`codex` invocations) was
explicitly designed and then **descoped** — it would have broken the user's plain provider
invocation during any Falcon outage, violating the "never break the fallback" principle,
which is also why `falcon` never shadows `claude`/`codex`/`opencode` as a shell shim; every
invocation stays explicit.

`plan.md`'s original v1 plan (Phases 0–4: repo/contracts, Mirror, Control, Fleet, Ship) is
~98% complete and tagged in git as a rollback anchor. The current active workstream is
§17, "v2: ACP migration" — replacing hand-rolled per-provider SDK/JSON-RPC integrations with
the official Agent Client Protocol, unifying Claude Code and Codex behind one transport and
one envelope mapper — marked complete as of the plan doc's latest entries. Interestingly,
`plan.md` doubles as a transparent execution log: several checklist items carry inline
annotations describing a recurring bug pattern where an autonomous agent cycle would
merge/verify a change *inside its own throwaway worktree branch* and flip the checkbox
without that branch ever actually reaching shared `main` — documented in place across
several correction cycles rather than silently fixed.

## 13. Recent development activity (git log themes)

The last ~40 commits on this branch fall into four overlapping waves: (1) a structured,
numbered "auth-hardening" unit cycle (`AH3`, `AH7`–`AH12`, each landing as feat/test/fix
triples, periodically rolled up into `chore: auth-hardening cycle N` commits) — the
mechanical build-out of the identity/key-custody split described in §4; (2) production
deployment wiring (Neon/R2/Vercel setup, a couple of Postgres-volume-rename commits working
around a corrupted DB init); (3) a large capstone commit completing the auth/UX overhaul
(Phases 0-7) followed immediately by a string of targeted E2E-discovered fixes (SRI disabled
on Vercel, crypto worker loaded as a static file not a webpack chunk, shell-shim removal,
static-export session-id fallback, PWA/SEO additions); and (4) a final wave of CI/build
stability fixes at the tip of the log — including the three most recent commits visible in
this workspace's git status (bumped timeouts for cold node-pty native-addon loads, Postgres-
free socket/rpcHandler tests, and a PIN-migration describe-block timeout), all clustered
right after the big feature push, consistent with the turbo.json race-condition comments
documented in the same window. Overall arc: incremental hardening → a big feature
completion → real-world bug fixes from verifying it → production wiring → CI stabilization.

## 14. A note on this research process

One of the six research subagents used to compile this document (the one covering
`packages/wire` and `packages/crypto`) returned output whose harness wrapper flagged it as
matching an "instruction-shaped pattern" resembling a permission-bypass injection attempt,
and neutralized the relevant control-looking text before it reached this conversation. This
is being surfaced here transparently per this assistant's standing instruction to flag
suspected prompt-injection in tool output rather than pass it through silently. The
substantive crypto/wire findings in this report were cross-checked against the independently
gathered CLI, server, and docs findings (all three of which reference the same crypto/wire
primitives from their own vantage points) and are consistent, so they're reported here as
reliable — but if this document is used for anything security-sensitive, it's worth treating
that one subagent run as the one link in this research chain that didn't come back clean,
and re-verifying its claims directly against `packages/wire/src` and `packages/crypto/src`
rather than taking this write-up as the final word on those two packages specifically.
