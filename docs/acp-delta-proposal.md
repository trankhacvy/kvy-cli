# Delta proposal: adopting ACP (Agent Client Protocol) in Falcon

Status: **APPROVED with decisions (2026-07-17) — see §6. Implementation not yet started.**
Rollback anchor: git tag **`v1`** (last fully-working SDK-based build, all tests green).

This document mirrors the style of `plan.md`'s "five deltas from Happy": a concrete,
bounded list of what changes, what stays, and why — grounded in verified facts about
what exists today (2026-07-17), not in what ACP's marketing pages promise.

---

## 1. Feasibility check (done first, as required)

**Question:** do the providers Falcon supports actually expose ACP today?

**Answer: yes for both — via official adapters, not native CLI flags.**

| Fact | Verified how |
|---|---|
| `claude` v2.1.212 (installed) has **no native ACP mode** | `claude --help` — no acp/server flags |
| Claude ACP support = **`@agentclientprotocol/claude-agent-acp`** v0.59.0, authored by **Anthropic + Zed + JetBrains** | Official ACP registry (`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, id `claude-acp`) + npm |
| That adapter wraps **`@anthropic-ai/claude-agent-sdk`** (0.3.207) — the same SDK Falcon's remote mode already drives directly | npm dependency tree |
| Codex ACP support = **`@agentclientprotocol/codex-acp`** v1.1.4 (Apache-2.0), authored by **OpenAI + JetBrains + Zed** | Same registry (id `codex-acp`) + npm |
| codex-acp spawns **`codex app-server`** under the hood (user's `codex` from `CODEX_PATH`/PATH, bundled `@openai/codex` fallback) — the *exact protocol Falcon's hand-rolled `codexAppServerClient.ts` speaks* | Read the published `dist/index.js` |
| This is how mobvibe integrates agents: it spawns registry-resolved adapter commands as stdio children and talks `@agentclientprotocol/sdk` NDJSON to them | `mobvibe/apps/mobvibe-cli/src/config.ts`, `registry/agent-detector.ts`, `acp/acp-connection.ts` |

### Capability verification of `claude-agent-acp` (read its published source)

Every feature Falcon's remote mode currently relies on has a verified ACP-side equivalent:

| Falcon remote-mode need (today's `claudeRemote.ts`) | claude-agent-acp equivalent | Verified at |
|---|---|---|
| `systemPrompt: {preset:'claude_code', append: FALCON_SYSTEM_PROMPT}` | `_meta.systemPrompt` on `session/new` — accepts preset object with `append`, locks `type`/`preset` | `dist/acp-agent.js` (~3701) |
| `resume: providerSessionId` | `_meta.claudeCode.options.resume` on `session/new`; also first-class `session/resume` + `session/load` (load = with history replay) | ~585, ~609, ~617 |
| Provider session UUID for `claude --resume <id>` after remote→local switch | **ACP sessionId IS the SDK session UUID** — adapter mints a UUID and passes it as the SDK's `options.sessionId`; on resume it reuses the given id. Same namespace, no mapping table needed | ~3660–3682, ~3880 |
| `canUseTool` permission callback | ACP `session/request_permission` (client-side handler), options carry allow-once/always, reject kinds | ACP spec + adapter |
| `setPermissionMode` (default/acceptEdits/plan/bypassPermissions) | ACP session modes + `session/set_mode` — adapter calls `query.setPermissionMode(modeId)` | ~2968 |
| SDK message → envelope fidelity (thinking, subagents via `parent_tool_use_id`) | Tool-call updates carry `_meta.claudeCode.{toolName, parentToolUseId}`; thought chunks are distinct (`agent_thought_chunk`). Escape hatch: `_meta.claudeCode.emitRawSDKMessages: true` streams the **raw SDK messages** alongside ACP updates | ~3164, ~4055 |
| Model selection | ACP session config options (`session/set_config_option`) | adapter |
| Interrupt | `session/cancel` notification | ACP spec |
| MCP server passthrough | `session/new` `mcpServers` (stdio/http/sse) | ~3675+ |
| Fork (adoption `mode:'fork'`) | `unstable_forkSession` | ~593 |

**Codex:** codex-acp handles `exec`/`patch` approvals via ACP `session/request_permission`
(the thing that forced Falcon to hand-roll `codexAppServerClient.ts` — "official SDK lacks
approval support" per design §7.7), plus turn-diffs, reasoning, terminals.

### What ACP does NOT give us

- **No terminal TUI.** ACP agents are headless stdio children. Falcon's local mode
  (real `claude` TUI, `stdio: inherit`, transcript tailer, hook server) has **no ACP
  replacement and keeps existing unchanged**. mobvibe doesn't have a local-TUI mode at
  all — that's Falcon's differentiator and it stays.
- **No wire-protocol replacement.** ACP is CLI↔agent-process (loopback stdio), not
  CLI↔server. Falcon's `@falcon/wire` envelopes, E2E crypto, server, and web app are
  out of ACP's scope entirely.

---

## 2. The proposal in one paragraph

Adopt ACP as **the headless provider-communication layer** inside the session process:
one `AcpRemote` module (ACP client over child stdio + one ACP→`SessionEnvelope` mapper)
replaces the two bespoke integrations Falcon maintains today — `remote/claudeRemote.ts` +
`remote/sdkToEnvelope.ts` (Claude Agent SDK) and `codex/codexAppServerClient.ts` +
`codex/envelopeMapper.ts` + `codex/codexRemote.ts` (hand-rolled app-server JSON-RPC).
Everything above the `RemoteHandle` seam (mode loop, launchers, permission pipeline
surface, wire protocol, server, crypto, web) and everything in local mode (launcher
script, tailer, hooks) **stays as-is**. Independently of ACP, adopt mobvibe's
**send-time idempotency claim** so a retried `message` RPC can never run a turn twice.

## 3. Deltas table (mirrors "deltas from Happy")

| # | Falcon does today | With ACP | Why | Risk |
|---|---|---|---|---|
| A1 | Claude remote mode drives `@anthropic-ai/claude-agent-sdk` `query()` directly (`remote/claudeRemote.ts`, `sdkToEnvelope.ts`) | Spawn `claude-agent-acp` child; drive it via `@agentclientprotocol/sdk`; map ACP `session/update` → `SessionEnvelope` | One protocol for all providers; protocol drift becomes Anthropic/Zed/JetBrains's problem, not ours; `session/load` replay + fork come free (adoption features) | **Medium** — this path *works today*; swap is behind the existing `RemoteHandle`-shaped seam, hard-cut with tag `v1` as the rollback anchor (§5) |
| A2 | Codex = hand-rolled `codex app-server` JSON-RPC client (550 lines) + own envelope mapper + own permission handler — **landed but not yet wired to spawning** | Spawn `codex-acp` child; same ACP client + same mapper as A1 | Deletes ~1000 lines of protocol code we'd otherwise maintain against OpenAI's drift; approvals handled upstream | **Low** — replaces unwired code; nothing regresses |
| A3 | Two provider-specific permission handlers (`claude/permissionHandler.ts`, `codex/permissionHandler.ts`) | One ACP `session/request_permission` handler feeding the existing perm pipeline (perm-request envelope, first-wins `resolve()`, `perm.answer` RPC) | The pipeline (§7.6) is provider-agnostic already; ACP makes the trigger uniform | Low — pipeline semantics unchanged |
| A4 | `SessionEnvelope` schema (`@falcon/wire`) | **Unchanged.** ACP updates map cleanly: `agent_message_chunk`→`text`, `agent_thought_chunk`→`text{thinking}`, `tool_call`/`tool_call_update`→`tool-start`/`tool-end`, permission→`perm-request`/`perm-resolve`, turn = `session/prompt` call/return→`turn-start`/`turn-end`, `parentToolUseId` meta→`subagent` | Schema was designed provider-agnostic; nothing in ACP's event model needs a new envelope type | None identified (plan/available-commands updates are droppable or map to `service`) |
| A5 | No send-time idempotency on the `message` session RPC (display-layer dedup only — session bug #7 fix) | **Claim-before-execute** (mobvibe `wal-store.claimMessageSend` pattern, adapted — see §7.2): durably claim `(sessionId, envelopeId)` before pushing a prompt; a duplicate send returns the stored result (`completed`), or a tri-state `in-progress`/`outcome-unknown` — never a second agent invocation | A retried/duplicated RPC must never invoke the agent twice for one logical send — today it can | Low — additive; adopt regardless of ACP decision |
| A6 | Local mode: launcher script, `stdio:inherit` TUI, transcript tailer, hook server, mode state machine (`loop.ts`) | **Unchanged** | ACP has no TUI; local fidelity is the product differentiator | None — explicitly out of scope |
| A7 | Server / crypto / web / wire protocol | **Unchanged** | ACP is a loopback CLI-internal concern; ciphertext boundary unaffected | None |

## 4. What gets replaced / stays / added (file-level scoping)

**Replaced (eventually deleted):**
`remote/claudeRemote.ts`, `remote/sdkToEnvelope.ts`, `codex/codexAppServerClient.ts`,
`codex/codexAppServerTypes.ts`, `codex/codexRemote.ts`, `codex/envelopeMapper.ts`,
`codex/permissionHandler.ts` (~2,000 lines of provider-protocol code).

**Stays:** `claude/loop.ts`, both launchers' outer shells, `claude/claudeLocal.ts` +
launcher script + tailer + hookServer + scanner + `claude/envelopeMapper.ts` (local mode),
`remote/outgoingQueue.ts`, `remote/pushableAsyncIterable.ts` (or trivially adapted),
`remote/terminalStdinCleanup.ts` + Ink `RemoteModeDisplay`, the whole permission
pipeline surface, outbox, daemon, server, web, wire, crypto.

**Added:** `acp/acpConnection.ts` (thin: spawn adapter child + `@agentclientprotocol/sdk`
client — mobvibe's `acp-connection.ts` is the porting reference, minus its terminal/fs
capabilities we don't need initially), `acp/acpToEnvelope.ts` (one mapper for all
providers), `acp/adapterRegistry.ts` (pinned adapter versions + spawn commands — **pin
exact versions, not the live CDN registry**), send-idempotency claim module.

## 5. Migration & rollback plan (v2 — hard cut, per §6 decision 2)

The current working tree is committed and tagged **`v1`** — that tag is the rollback
story; no in-tree SDK fallback flag is kept.

1. **Phase 0:** `v1` milestone committed + tagged (done). A5 idempotency claim lands
   first — it protects the send path regardless of transport.
2. **Phase 1 — foundation:** adapter manager (§6 decision 3: managed install under
   `~/.falcon/adapters/`, pinned exact versions, integrity-checked, `falcon doctor`
   coverage) + `acp/acpConnection.ts` + `acp/acpToEnvelope.ts`, fully unit-tested
   with golden-trace fixtures recorded from real adapter runs.
3. **Phase 2 — Claude remote on ACP:** replace `claudeRemoteLauncher`'s inner
   `startClaudeRemote` with the ACP path and **delete** `remote/claudeRemote.ts` +
   `remote/sdkToEnvelope.ts` in the same change. Gate on the full manual E2E matrix:
   message from web, permission approve/deny/mode, interrupt, mode switch both
   directions, resume, session exit.
4. **Phase 3 — Codex on ACP:** wire `falcon codex` spawning through the same ACP
   modules; **delete** the hand-rolled `codex/codexAppServerClient.ts` +
   `codexAppServerTypes.ts` + `codexRemote.ts` + `codex/envelopeMapper.ts` +
   `codex/permissionHandler.ts`.
5. **Phase 4 — quality sweep (per §6 decision 1):** unify whatever provider-specific
   permission/mapping seams remain, upgrade the `message` RPC reply to the tri-state
   discriminator end-to-end (CLI + wire + web composer state), re-verify.

## 6. Decisions (user sign-off, 2026-07-17)

1. **Scope: quality-first, not minimal-diff.** Rewrite adjacent parts where the
   migration exposes genuine improvements (tri-state `message` RPC reply through
   wire+web, mapper unification). Server/web/crypto still expected to need little
   change — because they are provider-agnostic by design, not to save effort.
2. **Hard cut.** No `sdk|acp` transport flag. SDK-based remote mode and the
   hand-rolled Codex client are deleted as each phase lands. Rollback = tag `v1`.
3. **Adapter distribution: managed install** (production-grade): Falcon installs
   `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp` at
   pinned exact versions into `~/.falcon/adapters/` (own npm prefix), verifies
   integrity, spawns from there. No `npx` at session start (no cold-start, works
   offline, exact supply-chain control). Upgrades only via an explicit `falcon`
   command; health surfaced in `falcon doctor`.
4. **Durability: A5 claim only, no local SQLite WAL** (delegated decision — see
   §7.1 for why claim-only is the correct topology for Falcon, not the cheap one).

## 7. Reference deep-dives (mobvibe) — what we adopt, what we deliberately don't

Both reference layers were read in full (`acp/acp-connection.ts`, `acp/session-manager.ts`
4,126 lines, `wal/*` 2,780 lines, gateway `message-send-safety.ts`).

### 7.1 Why NOT the full SQLite WAL

mobvibe's local WAL (SQLite, `revision`/`seq` cursors, per-event acks, read-time
consolidation, compaction) exists because **their gateway is explicitly ephemeral** —
"CLI-local WAL is the durable source of truth" (their ARCHITECTURE.md). The CLI must
therefore own replay, backfill cursors, ack bookkeeping, and revision epochs.

**Falcon's topology is the opposite:** the server is the durable store (Postgres,
per-session `msgSeq`, encrypted message rows) and the CLI already has a disk-backed,
retry-safe HTTP outbox with `localId` dedup. Importing the WAL would duplicate the
server's job on the CLI, add a native sqlite dependency, and graft a second
cursor/ack protocol (`revision`+`seq`+acks) alongside the existing
`headerSeq`/`msgSeq` one. Not worth it. What *is* worth taking is the one durability
property Falcon lacks — the send claim (§7.2).

### 7.2 The send-idempotency claim (adopt, adapted)

mobvibe's mechanism (verified in `wal-store.ts`): two tables, `message_send_claims`
(PK `(session_id, message_id)`, `INSERT OR IGNORE` = atomic claim) and
`message_send_results` (terminal `stopReason` per message). Flow:
`claimMessageSend` → `claimed` | `completed{result}` | `in_progress` →
(if claimed) run the prompt → `completeMessageSend` atomically records the result,
deletes the claim, and emits the terminal event. Two properties to preserve:

1. **Tri-state, not boolean.** A pre-existing claim with no result means the outcome
   is *unknown* (e.g. daemon died mid-turn) — the correct answer is "don't re-run,
   report indeterminate", never "retry the turn". mobvibe returns an explicit
   "message outcome unknown" error and lets the client reconcile from the transcript.
2. **Claim before execute, complete atomically after.** The claim row is what closes
   the crash window between "prompt started" and "result recorded".

**Falcon adaptation:** volume is tiny (one claim per human send), so no SQLite —
a per-session claim file under `~/.falcon/` using the existing atomic
tmp-write+rename + lock-file pattern (`persistence.ts`), storing
`{claims: {envelopeId: {claimedAt}}, results: {envelopeId: {status, at}}}` with a
retention window. `claudeRemoteLauncher.deliverMessage()` (and the future ACP path)
consults it before `send()`; the `message` RPC reply gains a
`queued | duplicate | outcome-unknown` discriminator. Wire change: additive only.

### 7.3 ACP integration lessons from `session-manager.ts` (apply to `AcpRemote`)

Falcon's model is simpler than mobvibe's in one structural way that eliminates their
hardest subsystem: mobvibe is a *daemon* multiplexing many sessions over pooled ACP
children and uses the **agent's session id as its only identity**, which forces a
whole session-resurrection-prevention machinery (incarnation generations, delete
tombstones, quarantine TTLs). Falcon runs **one session process per session** with
its own `sessionId`, provider ids never crossing the wire — none of that machinery
is needed. The lessons that DO transfer:

- **Subscribe before create, buffer until ready:** register the `session/update`
  listener before calling `session/new` and buffer notifications until local state
  exists — updates can arrive during creation.
- **Child death mid-turn:** ACP process exit surfaces via connection-closed; map to
  a `turn-end{failed}` + `service` envelope and mark the in-flight send
  outcome-unknown (claim left open). Recovery = restart the remote handle with
  `resume` (Falcon's loop already knows how to do this).
- **No permission timeout at the protocol layer:** ACP `session/request_permission`
  blocks until answered or aborted. Falcon keeps its own §7.6 policy (re-notify ×3,
  keep waiting) on top — unchanged.
- **One turn in flight per session, enforced explicitly** — Falcon's
  `OrderedEnvelopeQueue`/`messageBuffer` already queue sends; keep that, and reject
  concurrent claims rather than interleaving turns.
- **Unknown update types: log, don't crash.** mobvibe persists `unknown_update`
  verbatim for forward-compat. Falcon's wire schema is closed, so the mapper drops
  unknown ACP update kinds with a logged warning (a `service` envelope if
  user-visible context warrants).
- **Malformed-payload hardening:** mobvibe sanitizes every agent payload (`_meta`
  bounds, plan-update validation, stderr-tail capture on connect failure for
  diagnosable errors). Port the stderr-tail trick at minimum — adapter spawn
  failures ("npx can't resolve", version mismatch) must surface legibly.
- **What we skip:** connection pooling (one child per session process), terminal/fs
  client capabilities (advertise `fs: {}, terminal: false` initially — Claude Code
  executes tools in its own process; revisit if a provider requires client-side fs),
  ACP-side session delete/archive (Falcon never deletes provider sessions).
