# Wire Protocol

> **Status:** stub — outline + pointers only. Expand this doc as each piece of
> `@kvy/wire` and the transports that use it actually land. Full detail
> currently lives in [`kvy-system-design.md` §4](../kvy-system-design.md#4-wire-protocol-kvywire).
>
> **Rule:** this file is updated in the same PR as any protocol change
> (`plan.md` cross-cutting note). If a schema in `@kvy/wire` changes and
> this doc doesn't, the PR is incomplete.

This document will describe the Kvy wire protocol as implemented in
`packages/wire` (`@kvy/wire`) and consumed by `packages/server`,
`packages/cli`, and `packages/web`. See [`encryption.md`](./encryption.md)
for how payloads inside this protocol are encrypted.

## 1. Encryption container

Every content-bearing field the server stores or routes is wrapped in an
`EncryptedBox` — the server never sees plaintext. Binary layout and key
handling are covered in `encryption.md`; the wire-level shape is:

```ts
type EncryptedBox = { t: 'enc'; v: 1; c: string /* base64 */ };
```

Design doc: [§4.1 Encryption container](../kvy-system-design.md#41-encryption-container-outermost-everything-user-content-crosses-in-this).

## 2. Session event envelope

Provider-agnostic, flat event stream (`SessionEnvelope` / `SessionEvent`).
Adapter-minted `cuid2` ids only — provider-native ids (`toolu_*`, Codex ids)
never cross the wire. Covers text/thinking, tool start/end, files, turns,
permission request/resolve, mode-switch, and subagent lifecycle.

Design doc: [§4.2 Session event envelope](../kvy-system-design.md#42-session-event-envelope-provider-agnostic-flat-stream).

**No token streaming (W4.1 decision):** the local (non-ACP) transcript path
only ever emits whole `text`/`tool-*` envelopes, never partial-token deltas —
the CLI tailer sees complete JSONL lines from `~/.claude/projects/**/*.jsonl`,
so there is no partial text to stream in the first place. Perceived latency
is reduced instead by making progress visible (activity row + following) and
by coalescing outbox flushes sooner (150ms, down from 300ms — §6.5). ACP
remote mode *does* receive real token-level `session/update` chunks from the
adapter, but `acpToEnvelope.ts` coalesces them into the same whole-envelope
shape before they reach this protocol — so `SessionEnvelope` itself carries no
streaming/partial variant today. Revisit only if ACP remote becomes the
dominant path and coalescing there is deliberately relaxed.

## 3. Server ↔ client update stream

Two WS channels: `update` (persistent, seq-ordered — session/message/machine/
account changes) and `ephemeral` (volatile — activity, presence, attention;
droppable, never gap-checked). Two-level ordering: account-level `headerSeq`
for structural changes, per-session `msgSeq` for transcript messages. **All
writes go over idempotent HTTP**, never WS — see the write/read split and
the reasoning in the design doc before touching this.

Design doc: [§4.3 Server↔client update stream](../kvy-system-design.md#43-serverclient-update-stream).

## 4. RPC contracts

Scope-prefixed RPC (`m:<machineId>:<method>`, `s:<sessionId>:<method>`) for
machine ops (spawn, stop, resume, list, git, fs, adopt) and session ops
(message, perm.answer, interrupt, takeControl, setMode). Params/results are
`EncryptedBox` — control-plane only, capped at 64 KB; larger payloads go
through encrypted blobs referenced by `blobRef`. Mutating RPCs carry
idempotency keys.

The `message` session RPC reply is a **tri-state** (v0.3, additive): `status:
'queued' | 'duplicate' | 'outcome-unknown'` on top of the original `queued`
boolean. A retried/duplicated send whose claim already completed replies
`duplicate`; one whose claim exists without a recorded result (e.g. a crash
mid-turn) replies `outcome-unknown` and the client reconciles from the
transcript rather than blind-resending. See design §7.10.

Design doc: [§4.4 RPC contracts](../kvy-system-design.md#44-rpc-contracts).

## 5. Provider transport (ACP) — below the wire protocol

The wire protocol above is CLI↔server↔client. Separately, **inside** the CLI
session process, remote mode talks to the coding agent over the **Agent
Client Protocol (ACP)**: Kvy spawns a managed adapter child
(`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`)
and drives it via `@agentclientprotocol/sdk` over NDJSON stdio. This is a
loopback, CLI-internal concern — it never crosses the encryption boundary and
is not part of `@kvy/wire`.

ACP's `session/update` notifications map onto the provider-agnostic
`SessionEnvelope` stream (§2) by a single shared mapper (`cli/src/acp/
acpToEnvelope.ts`); `session/request_permission` drives the same
`perm-request`/`perm-resolve` envelopes and `perm.answer` RPC. Nothing about
ACP is visible to the server, web, or wire schema — swapping the provider
transport (as v2 did, from the Claude Agent SDK / hand-rolled Codex client to
ACP) is invisible above this line.

Design doc: [§7.3–§7.10 CLI provider layer](../kvy-system-design.md#73-provider-adapter-interface).

## Reserved namespaces (deferred features)

`checkpoint:*` (workspace sync), `preview:*` (live previews), `voice:*` —
reserved in the wire schema now so sandboxing and future features bolt on
without a protocol break. See design doc §14.

## Evolution policy

Encrypted payload schemas are **additive-only, forever** — a field is never
repurposed; deprecation means ignore-on-read. Enforced by a wire-schema
compat lint in CI plus golden fixtures per version (see `plan.md` §16 0.2).

---

**TODO as `@kvy/wire` lands:** concrete Zod schema names and file
locations, request/response examples per RPC method, error shapes, and a
changelog of schema versions.
