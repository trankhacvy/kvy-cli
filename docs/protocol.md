# Wire Protocol

> **Status:** stub — outline + pointers only. Expand this doc as each piece of
> `@falcon/wire` and the transports that use it actually land. Full detail
> currently lives in [`falcon-system-design.md` §4](../falcon-system-design.md#4-wire-protocol-falconwire).
>
> **Rule:** this file is updated in the same PR as any protocol change
> (`plan.md` cross-cutting note). If a schema in `@falcon/wire` changes and
> this doc doesn't, the PR is incomplete.

This document will describe the Falcon wire protocol as implemented in
`packages/wire` (`@falcon/wire`) and consumed by `packages/server`,
`packages/cli`, and `packages/web`. See [`encryption.md`](./encryption.md)
for how payloads inside this protocol are encrypted.

## 1. Encryption container

Every content-bearing field the server stores or routes is wrapped in an
`EncryptedBox` — the server never sees plaintext. Binary layout and key
handling are covered in `encryption.md`; the wire-level shape is:

```ts
type EncryptedBox = { t: 'enc'; v: 1; c: string /* base64 */ };
```

Design doc: [§4.1 Encryption container](../falcon-system-design.md#41-encryption-container-outermost-everything-user-content-crosses-in-this).

## 2. Session event envelope

Provider-agnostic, flat event stream (`SessionEnvelope` / `SessionEvent`).
Adapter-minted `cuid2` ids only — provider-native ids (`toolu_*`, Codex ids)
never cross the wire. Covers text/thinking, tool start/end, files, turns,
permission request/resolve, mode-switch, and subagent lifecycle.

Design doc: [§4.2 Session event envelope](../falcon-system-design.md#42-session-event-envelope-provider-agnostic-flat-stream).

## 3. Server ↔ client update stream

Two WS channels: `update` (persistent, seq-ordered — session/message/machine/
account changes) and `ephemeral` (volatile — activity, presence, attention;
droppable, never gap-checked). Two-level ordering: account-level `headerSeq`
for structural changes, per-session `msgSeq` for transcript messages. **All
writes go over idempotent HTTP**, never WS — see the write/read split and
the reasoning in the design doc before touching this.

Design doc: [§4.3 Server↔client update stream](../falcon-system-design.md#43-serverclient-update-stream).

## 4. RPC contracts

Scope-prefixed RPC (`m:<machineId>:<method>`, `s:<sessionId>:<method>`) for
machine ops (spawn, stop, resume, list, git, fs, adopt) and session ops
(message, perm.answer, interrupt, takeControl, setMode). Params/results are
`EncryptedBox` — control-plane only, capped at 64 KB; larger payloads go
through encrypted blobs referenced by `blobRef`. Mutating RPCs carry
idempotency keys.

Design doc: [§4.4 RPC contracts](../falcon-system-design.md#44-rpc-contracts).

## Reserved namespaces (deferred features)

`checkpoint:*` (workspace sync), `preview:*` (live previews), `voice:*` —
reserved in the wire schema now so sandboxing and future features bolt on
without a protocol break. See design doc §14.

## Evolution policy

Encrypted payload schemas are **additive-only, forever** — a field is never
repurposed; deprecation means ignore-on-read. Enforced by a wire-schema
compat lint in CI plus golden fixtures per version (see `plan.md` §16 0.2).

---

**TODO as `@falcon/wire` lands:** concrete Zod schema names and file
locations, request/response examples per RPC method, error shapes, and a
changelog of schema versions.
