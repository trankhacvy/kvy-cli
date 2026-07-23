# Design proposal — session sharing ("pair with a teammate", Flow 4)

**Status: DRAFT — awaiting product/design review, not yet approved.**

This is a *first-pass* design for letting a genuinely different person view — and,
depending on the scope decision below, approve permissions on — someone else's Falcon
session, from their own account and device. It exists to give the product owner something
concrete to react to and correct, not to be an implementation spec. Every section that
records a real open question flags it as such; the [Open questions](#open-questions-for-the-product-owner)
section at the end is the single most important part of this doc.

It supersedes the *speculative* subsection of `docs/plan-flows-3-4-5.md`'s "Flow 4" and
unblocks (but does not itself satisfy) the `FL4.1` human-design-review gate tracked in
`known-issues.md`. The implementation units `FL4.3` (schema/authz) and `FL4.4` (socket/web
UI) remain blocked until this doc is reviewed and approved by a human product owner.

Vocabulary used throughout: **owner** = the account that owns a session; **grantee** = a
different account granted scoped access to one of the owner's sessions.

---

## 0. What was re-verified against current source (2026-07-22, branch `v2-pty-injection`)

The prior research pass (`docs/plan-flows-3-4-5.md`) was re-checked against live code before
writing this. Findings:

- **Identity is one account, anchored on `signPublicKey`.** `accounts`
  (`packages/server/src/db/schema.ts:25-39`): `signPublicKey` is `.notNull().unique()` (`:27`,
  the identity anchor) and every account also stores a `contentPubKey` (`:28`,
  `.notNull()`). Every other table foreign-keys `accountId` with `onDelete: "cascade"`. A
  "teammate" is definitionally a different `accounts` row. **Confirmed, no drift.**
- **The sharing crypto primitive already exists and needs no new cryptography.** `wrapDek`
  (`packages/crypto/src/dek.ts:20-27`) seals a DEK to *any* content public key via
  `libsodiumEncryptForPublicKey`; nothing binds the target key to the owner's. `unwrapDek`
  (`:29-35`) recovers it with the matching content secret key (derived at
  `packages/crypto/src/keys.ts:104-105`) and returns `null` on any mismatch rather than
  throwing. A grant is `wrapDek(sessionDek, granteeContentPubKey)`. **Confirmed, no drift.**
  (A round-trip test proving owner-can/other-cannot was `FL4.2`, already landed.)
- **Device pairing is a different primitive.** `pairRequests` (`schema.ts:134-142`) hands a
  *new device of the same account* the whole account secret — its `response` column is
  literally *"sealed box to ephPub: master secret / content key bundle"* (`:138`). It is the
  opposite of scoped, per-session sharing. **Confirmed, no drift.**
- **~15 server routes gate on `eq(sessions.accountId, accountId)`.** Re-audited fresh: it is
  actually **17 occurrences across 9 files** today —
  `blobs.ts:102`, `messages.ts:69` & `:156`, `notificationSettings.ts:95` & `:108`,
  `sessionArchive.ts:53`/`:64`/`:107`, `sessionCas.ts:46` & `:82`, `sessionNotify.ts:61`,
  `sessions.ts:87`/`:144`/`:145`, `sessionStatus.ts:83` & `:96`, `sync.ts:41`. The prior
  doc's list was accurate; it has not drifted. This is the authoritative list for the authz
  rewiring below.
- **Socket.IO rooms are account-namespaced.** `eventRouter.addConnection`
  (`eventRouter.ts:116-131`) joins `user:${accountId}` and
  `user:${accountId}:session:${sessionId}`; `getRoomsForFilter` (`:218-229`) only ever
  returns rooms inside one account's namespace; `RecipientFilter` (`:40-44`) has no
  cross-account variant. The handshake stamps `socket.data.accountId` from the caller's own
  verified token (`socket.ts:86`). **Confirmed, no drift.**
- **The socket RPC routing is also caller-account-keyed — and the exact shape matters.**
  `rpcRoom(accountId, target)` returns `` `rpc:${accountId}:${target}` `` (`rpcHandler.ts:93-95`).
  The `target` is itself session-scoped: `` `s:${sessionId}:${method}` `` (wire contract at
  `packages/wire/src/rpc.ts:8-9`; produced identically at `packages/cli/src/rpc/sessionRpc.ts:118`
  and `packages/web/src/sync/sessionRpc.ts:122`). So the owner's session process registers under
  room `rpc:<ownerAccountId>:s:<sessionId>:perm.answer` (`rpcHandler.ts:180`, called with the
  owner's account), and a call is routed to `rpc:<callerAccountId>:s:<sessionId>:<method>`
  using the **caller's** account (`rpcHandler.ts:230-231`, `rpcHandler(accountId, …)` wired at
  `socket.ts:178`). A grantee calling `perm.answer`/`message`/interrupt/`setMode` would resolve
  to `rpc:<granteeAccountId>:s:<sessionId>:…` — a room nobody registered — and get *"RPC target
  not available"*. **Confirmed, no drift.** This is the single most easily-missed gap: the entire
  *approve* half of sharing rides this RPC path, not the HTTP routes above.

**Net drift from the prior research pass: none material.** The one refinement worth stating
is the precise RPC room key (`rpc:<accountId>:s:<sessionId>:<method>`), which makes the
routing fix in §6 concrete rather than hand-wavy.

One additional grounded fact not previously emphasized, load-bearing for the invite flow
(§7): **the server already stores every account's `contentPubKey` in plaintext**
(`schema.ts:28`, written at account creation, `oauth.ts:153-154`). So a server-mediated
"look up this grantee's content key" step needs no new storage — only a way to name the
grantee.

---

## 1. Threat / trust model

The server holds no keys and never decrypts session content (design §5.3/§6.1;
`schema.ts:14-23`). Sharing therefore has two independent halves that must both be gotten
right, because they fail differently:

1. **Data confidentiality** is enforced by *encryption* — a grantee can only read a session
   whose DEK was explicitly wrapped to their `contentPubKey`. This is cryptographic and the
   server cannot violate it even if authz is buggy.
2. **Access and control** (which routes/RPCs a grantee may call) is enforced by *server-side
   authorization*. This is ordinary application logic and *can* be gotten wrong — a missed
   check is a real vulnerability (see §5).

### What the owner is trusting a grantee with

- **Full plaintext of the shared session's transcript**, including everything the agent
  read, wrote, and ran, plus any secrets that appear in that transcript. Sharing is not
  redacted; there is no field-level filtering. The owner must understand "share this
  session" means "this person can read everything in it, forever, from the moment of grant."
- **Nothing about any other session.** A grant wraps exactly one session's DEK. The
  grantee never receives the owner's master secret or any other session's DEK — this is the
  concrete win of reusing `wrapDek` per-session rather than pairing (contrast
  `pairRequests`, which hands over everything).
- **(If the "approver" role ships)** the ability to answer permission prompts and send
  messages/interrupts into a live session — i.e. to cause the agent to run tools in the
  owner's environment on the owner's machine. This is a materially higher level of trust
  than view-only and is the main reason §2 proposes shipping view-only first.

### What a grantee can and cannot do

| Capability | Viewer | Approver | Enforced by |
|---|---|---|---|
| Read shared session transcript | yes | yes | encryption (has the DEK) + read-route authz |
| See live updates / presence for the session | yes | yes | socket room membership (§6) |
| Answer permission prompts (`perm.answer`) | **no** | yes | RPC routing + write authz (§5, §6) |
| Send messages / interrupt / setMode | **no** | yes | RPC routing + write authz |
| Read the owner's *other* sessions | **no** | **no** | no DEK + authz denies |
| List the owner's sessions (`GET /v1/sessions`, `/v1/sync`) | **no** (see open Q) | **no** | authz — see §5 note on list routes |
| Re-share to a third party | **no** (proposed) | **no** (proposed) | only the owner may create shares (§4/§5) |
| Delete/archive/change status of the session | **no** (proposed) | **no** (proposed) | owner-only routes stay owner-gated (§5) |

### Revocation and the honest limitation

Revoking a share can stop **new** server-side access: no new fan-out, no new RPC routing, no
new message reads. It **cannot un-teach a key that has already been delivered to the
grantee's device.** Once the grantee's client has `unwrapDek`'d the session DEK, it holds the
symmetric key; any session content it already downloaded stays readable offline, and the raw
DEK could in principle decrypt any ciphertext it later obtained by other means. This is an
inherent property of end-to-end encryption with client-held keys, not a bug to engineer
away. The only true remedy is **DEK rotation + re-encryption** of the session going forward
(discussed in §8), which protects *future* content but still cannot claw back what was
already delivered. **This must be communicated to owners in plain language at share time and
at revoke time** ("revoking stops future access; it cannot make them forget what they've
already seen"). It should not be papered over with a revoke button that implies more than it
delivers.

---

## 2. Scope decisions needed from the product owner

These are decisions **for the human**, framed with tradeoffs and a recommendation — not
choices this doc makes unilaterally.

### Decision A — View-only first, or view + approve from day one?

- **Option A1 — View-only first (recommended).** Ship read access only. A grantee can watch
  a session live but cannot answer permissions or send input. Smaller authz surface (only
  read routes change; the write routes and the RPC-routing fix in §6 can be deferred), much
  lower trust bar for owners, and it delivers the most common real use case ("look at what my
  agent is doing / pair-debug over my shoulder"). The RPC-routing fix (§6) is genuinely the
  hardest and highest-risk part, and view-only lets us ship value without it.
- **Option A2 — View + approve together.** More useful for true remote pairing (a teammate
  unblocks your agent while you're away) but requires the full §5 write-authz rewiring *and*
  the §6 RPC-routing fix in the first release, and raises the trust stakes substantially.
- **Recommendation:** A1. Ship viewer, design the schema so "approver" is a later flip of a
  `role` value, not a migration.

### Decision B — Per-session or per-workspace sharing?

- **Option B1 — Per-session (recommended for v1).** One grant = one session. Maps exactly to
  the existing `wrapDek`-per-session crypto; the DEK to wrap already exists. Simple mental
  model, tight blast radius.
- **Option B2 — Per-workspace.** "Share everything in this repo." More convenient for
  ongoing collaboration but much larger blast radius, and it has to answer "does this include
  *future* sessions?" — which means wrapping DEKs the grantee hasn't been told about yet, on
  sessions that don't exist at grant time. That's a real design problem (a standing
  auto-wrap obligation) that per-session sidesteps entirely.
- **Recommendation:** B1 for v1. Revisit per-workspace once per-session is real; it can be
  layered as "a workspace share is shorthand for auto-creating per-session shares."

### Decision C — How long does a grant last?

- **Option C1 — Until explicitly revoked (recommended for v1).** Simplest. A `revokedAt`
  nullable column; a grant is live while `revokedAt IS NULL`.
- **Option C2 — TTL / auto-expiry.** Grants expire after N hours/days (mirrors the
  bounded-TTL discipline `pairRequests`/`telegramLinkRequests` already enforce — an unbounded
  pairing window was a named Happy vuln, `schema.ts:133`). Safer default, more friction.
- **Option C3 — Both:** default-expiring with an explicit "keep until revoked" opt-in.
- **Recommendation:** C1 for the grant *record*, but **bound the invite** (the thing that
  hasn't been redeemed yet) with a hard TTL regardless — an unredeemed invite is exactly the
  `pairRequests` failure mode and should not sit open forever (see §7).

---

## 3. Schema proposal (starting point for review — not settled)

A new table. Shapes below are **illustrative**; column names/types are a starting point for
the review, and depend on the decisions in §2.

```
session_shares
  id                text pk            $defaultFn(createId)
  sessionId         text  not null  -> sessions.id      (onDelete cascade)
  ownerAccountId    text  not null  -> accounts.id      (onDelete cascade)
  granteeAccountId  text  not null  -> accounts.id      (onDelete cascade)
  wrappedDek        bytea not null   -- session DEK sealed to grantee.contentPubKey (wrapDek)
  role              text  not null   -- 'viewer' | 'approver'   (see Decision A)
  createdAt         timestamp not null defaultNow()
  revokedAt         timestamp        -- null = live (see Decision C)
  uniqueIndex(sessionId, granteeAccountId)   -- one live grant row per (session, grantee)
  index(granteeAccountId)                    -- grantee's "shared with me" lookups
  index(sessionId)                           -- owner's "who can see this" + fan-out (§6)
```

Notes and deliberate choices:

- `wrappedDek` lives on the share row, not on `sessions`. `sessions.dek` (`schema.ts:88`)
  stays the owner's copy; each grant carries its own independently-wrapped copy of the same
  underlying DEK. This mirrors how `machines.dek` and `workspaces.dek` are already
  per-row-wrapped copies (`schema.ts:52`, `:65`).
- `ownerAccountId` is denormalized (derivable from `sessions.accountId`) but kept so
  revocation/audit queries and the authz helper (§5) don't need a join back to `sessions`
  for the common case. Open to dropping it if the review prefers strict normalization.
- `role` as a free `text` matches the codebase's existing convention (`provider`, `status`,
  `channel` are all `text` with a comment enumerating values, e.g. `schema.ts:81`,
  `:151`). If Decision A picks view-only-first, v1 can hardcode `'viewer'` and treat
  `'approver'` as a not-yet-issued value.
- **Explicitly unsettled:** whether a grant should record *who* issued it beyond
  `ownerAccountId` (irrelevant while only owners can share); whether we need a soft-delete
  `revokedAt` vs. a hard row delete (soft-delete is better for "answered on another device"
  / audit and for the honest-revocation messaging in §1 — recommend soft-delete); whether to
  add a `lastAccessedAt` for owner visibility ("this person last viewed 2h ago").

---

## 4. The grant operation (owner side)

Creating a share is the one place the owner's client does real crypto work. Given a decided
grantee identity + their `contentPubKey` (how the owner *learns* these is §7):

1. Owner's client already holds the session DEK (it can `unwrapDek(sessions.dek,
   ownerContentSecretKey)` — it does this to read the session at all).
2. Client computes `wrappedDek = wrapDek(sessionDek, granteeContentPubKey)`
   (`crypto/src/dek.ts:21`). **This happens client-side**; the server never sees the raw DEK.
3. Client POSTs the grant to a new route, e.g. `POST /v1/sessions/:id/shares` with body
   `{ granteeAccountId, wrappedDek, role }`. Server authorizes that the caller owns `:id`
   (ordinary owner check), inserts the `session_shares` row, and fans out an `update` so both
   parties' clients learn about the new share.

No new cryptography, no server key access. The only genuinely new server surface is the
grant/revoke/list routes and the authz helper (§5).

---

## 5. Authorization mechanism

### The helper

Introduce one server-side helper that every session-scoped access flows through:

```ts
// illustrative signature — not final
type EffectiveRole = "owner" | "approver" | "viewer";

async function assertSessionAccess(
  db, sessionId: string, accountId: string,
  need: "read" | "write",
): Promise<{ role: EffectiveRole; session: Session }>   // throws/404s if no access
```

Resolution order:

1. If `sessions.accountId === accountId` → `role: "owner"` (full access).
2. Else look up a live `session_shares` row (`sessionId`, `granteeAccountId = accountId`,
   `revokedAt IS NULL`). If found → `role` from the row.
3. Else → deny (same 404/403 shape the inline checks produce today, so error behavior for
   non-shared callers is unchanged).
4. If `need === "write"` and the resolved role is `"viewer"` → deny.

`need` lets read routes accept any role and write routes require owner/approver without each
call site re-deriving the rule.

### Call sites that must route through it (the real, current list)

The 17 inline `eq(sessions.accountId, accountId)` checks (§0) split into three buckets. Each
must be individually reviewed — **the risk is missing one**, so an exhaustive audit of every
`sessions` query is part of the work, not optional.

**Read-capable (become `assertSessionAccess(..., "read")`, any role):**
- `messages.ts:69` — `GET .../messages` (read transcript). *Grantee needs this.*
- `sessionNotify.ts:61` — resolves the session for notify (borderline; likely owner/approver only).
- `blobs.ts:102` — blob download tied to a session (grantee needs it to render attachments).
- `sync.ts:41` — **special:** this is `GET /v1/sync`, `findMany` over *all* of an account's
  sessions. It cannot naively widen or a grantee's sync would dump the owner's whole account.
  A grantee's sync must return **their own sessions ∪ sessions shared with them**, computed
  as a `UNION`/second query against `session_shares` — not a relaxed `where`. **Flagged as a
  design sub-item.**
- `sessions.ts:144-145` — `GET /v1/sessions` list, same concern as `sync.ts`; see the list
  open question below.

**Write-capable (become `assertSessionAccess(..., "write")`, owner or approver):**
- `messages.ts:156` — `POST .../messages` (append a message). Approver-gated.
- `sessionCas.ts:46` & `:82` — CAS updates to session metadata/agent-state. Likely
  owner-only *or* approver depending on what's being written; **needs per-field review** (an
  approver answering a permission legitimately mutates `agentState`, but renaming a session
  is arguably owner-only).
- `sessionStatus.ts:83` & `:96` — status transitions (`failed`/etc.). Likely owner-only.

**Owner-only (should NOT accept a grantee — keep the strict owner check, do *not* replace
with the shared helper's permissive path):**
- `sessionArchive.ts:53`/`:64`/`:107` — archive/unarchive. Destructive; owner-only.
- `notificationSettings.ts:95` & `:108` — per-session mute is a personal setting. Arguably
  *per-account-per-session*, not shared at all — a grantee muting the owner's session would
  be wrong. **Needs a decision**; simplest is owner-only for v1.
- `sessions.ts:87` — creation idempotency lookup (`by tag`); creation is owner-only by
  definition.

The key point: **`assertSessionAccess` is not a blanket find-and-replace.** Roughly a third
of the sites should stay owner-only. The helper makes the *intent* explicit at each site
(`"read"` / `"write"` / an explicit owner-only assertion) rather than every site open-coding
`eq(accountId)`.

---

## 6. RPC / socket routing fix (the hardest part)

This is what makes a grantee's `perm.answer`/`message`/interrupt/`setMode` actually reach the
owner's session process, and what makes live updates actually reach the grantee. It is
**separable from §5** and only needed if Decision A picks "approver" (writes) and/or if
viewers need live updates (they do).

### 6a. Live updates to a grantee (event fan-out)

Today `emitUpdate`/`emitEphemeral` fan out to `user:${accountId}:session:${sessionId}` and
the account's user-scoped room, all within one account's namespace
(`eventRouter.getRoomsForFilter:218-229`). A grantee's socket is stamped with the *grantee's*
`accountId` (`socket.ts:86`) and joins *grantee-namespaced* rooms
(`eventRouter.addConnection:116-131`), so it never receives session `S`'s traffic.

Two candidate mechanisms (this choice is itself a review item):

- **(a) Session-keyed rooms.** Introduce a room keyed by session, not account — e.g.
  `session:${sessionId}` — that both the owner's and every grantee's session-scoped socket
  joins, and fan `all-interested-in-session` out to it. Cleaner conceptually (a session's
  audience is a first-class thing) but touches `addConnection`, `getRoomsForFilter`, and the
  presence queries (`hasActiveVisibleClient:203-214`), and needs care that account-scoped
  events (`user-scoped-only`, machine presence) stay account-namespaced.
- **(b) Computed grantee room set.** Keep rooms account-namespaced; when emitting
  `all-interested-in-session` for session `S`, resolve `S`'s live grantees from
  `session_shares` and additionally target each grantee's
  `user:${granteeAccountId}:session:${S}` room. Keeps the existing room scheme but makes
  every session emit do a grantee lookup (cache-able), and requires the grantee's socket to
  have joined that room — which means the grantee's client must open a session-scoped socket
  for `S` and the server must let it (today `addConnection` would put it under the grantee's
  own namespace, which happens to be exactly the room (b) targets — so (b) composes with the
  existing keying more naturally than it first appears).

**Lean:** (a) is the "right" model long-term; (b) is the smaller diff and reuses the existing
namespacing. Recommend prototyping (b) first unless the review wants the cleaner session-room
model up front. Either way, `hasActiveVisibleClient` (push suppression) must be taught that a
grantee viewing counts — otherwise the owner keeps getting pushes while a teammate is
actively watching, or vice-versa.

### 6b. Grantee → session-process RPCs (the approve path)

This is the gap that "silently resolves to nothing" today. The owner's session process
registered its RPC target under `rpc:<ownerAccountId>:s:<sessionId>:<method>`
(`rpcHandler.ts:180`, owner's account). A grantee's `rpc-call` is routed to
`rpc:<granteeAccountId>:s:<sessionId>:<method>` (`rpcHandler.ts:230-231`, caller's account) —
empty room → *"RPC target not available"*.

The fix must **resolve the room by the session's owner, not the caller**, *after* confirming
the caller holds a live approver-role share. Concretely, `rpc-call` handling needs, for a
session-scoped target (`s:<sessionId>:<method>`):

1. Parse `sessionId` out of the target (the `s:` prefix already encodes it; wire contract
   `rpc.ts:8-9`).
2. Resolve the *owner* account for that session (`sessions.accountId`).
3. If `callerAccountId === ownerAccountId` → today's behavior, unchanged.
4. Else assert a live `session_shares` row with `role IN ('approver')` for
   `(sessionId, callerAccountId)`. If absent → deny (unchanged "not available"/explicit
   forbidden).
5. If present → route to `rpc:<ownerAccountId>:s:<sessionId>:<method>` (the owner's
   registration), **not** the caller's.

This means `rpcHandler` gains a DB dependency it does not have today (it is currently pure
Socket.IO room math, ported wholesale from Happy — `rpcHandler.ts:5`). That is a real
architectural change and should be reviewed: either inject a small
`resolveSessionOwnerAndAccess(sessionId, callerAccountId)` seam into `rpcHandler`, or
interpose an authorization/rewrite step before the room lookup. Machine-scoped targets
(`m:<machineId>:…`) are unaffected and stay caller-account-keyed.

**This is the piece most likely to be underestimated.** It is why §2 Decision A recommends
shipping view-only (6a only) first and treating 6b as a distinct, later milestone.

---

## 7. Invite / handshake flow (least-defined — at least two real options)

Before the owner can `wrapDek` to a grantee, the owner's client must learn the grantee's
**`contentPubKey`** and their **`accountId`**, and must trust that they belong to the person
the owner intends. There is *no* existing cross-account invite primitive — `pairRequests` is
same-account only. This is the least-defined piece and needs a product + threat-model
decision. Two realistic options:

### Option 1 — Redeemable share link (grantee pulls)

The owner creates a share *invite* (a new short-TTL row, shape like `pairRequests`/
`telegramLinkRequests`: opaque `code`, `sessionId`, `role`, `expiresAt`) and gets a link
(`https://<web>/share/<code>`). The owner sends it out-of-band (Slack/email/etc.). The
grantee opens it **while signed into their own Falcon account**; the web client POSTs the
grantee's `accountId` + `contentPubKey` to redeem it. The server then either (a) notifies the
owner's client, which does the `wrapDek` and completes the grant, or (b) — since the server
already stores the grantee's `contentPubKey` (`schema.ts:28`) — hands the owner's client the
grantee's `contentPubKey` to wrap against.

- **Pros:** No directory/search of accounts needed. TTL-bounded like the existing pairing
  primitives (the discipline the codebase already follows, `schema.ts:133`). The grantee
  proves account control by being signed in to redeem.
- **Cons:** Two-step (owner creates, then must come back to finish the wrap after redemption)
  — unless we accept the server relaying the grantee's `contentPubKey` back to the owner
  (fine: it's a public key). Link-forwarding risk: whoever opens the link while signed into
  *any* account can redeem it, so the TTL must be short and ideally single-use, and the owner
  should see/confirm "granted to <handle>" after redemption. **The trust anchor is "I sent
  this link to the right person," which is as weak as the channel it was sent over.**

### Option 2 — Handle / email lookup (owner pushes)

The owner types the grantee's handle or the email tied to their OAuth account
(`accounts.oauthSubject`/`oauthProvider`, `schema.ts:29-30`); the server resolves it to an
`accountId` + `contentPubKey` and returns it; the owner's client `wrapDek`s and grants
directly.

- **Pros:** One step, no link to leak, feels like normal "invite by email."
- **Cons:** Requires an account-directory lookup, which is a **privacy/enumeration surface**
  the product doesn't have today (you could probe which emails have Falcon accounts). Needs
  rate-limiting and probably a consent model (does the grantee get to accept before their
  key is used? Wrapping to someone's public key without consent is cryptographically
  harmless but socially surprising). The trust anchor ("I typed the right email") is
  comparable to Option 1's, but the enumeration risk is net-new.

### Lean

Option 1 (redeemable link) fits the existing codebase best — it reuses the bounded-TTL,
opaque-code, sealed-relay pattern the server already implements twice
(`pairRequests`, `telegramLinkRequests`) and introduces no account-enumeration surface. Its
weakness (link forwarding) is mitigated by short TTL + single-use + an owner confirmation
step after redemption. But **this is explicitly a product decision** — Option 2's UX is
nicer and may be worth the enumeration-hardening cost. Do not build either speculatively
before the review picks one.

---

## 8. Revocation semantics

- **Mechanism:** set `session_shares.revokedAt = now()` (soft-delete). The authz helper (§5)
  and RPC-routing check (§6b) both gate on `revokedAt IS NULL`, so a revoke immediately stops
  new reads, new RPC routing, and new fan-out. The grantee's live socket should also be
  dropped from the session's room set on revoke (emit a targeted "share-revoked" update so
  the grantee's client tears down its view).
- **DEK rotation — the honest question.** Revocation alone cannot un-teach the delivered key
  (§1). If the product wants *future* content protected after a revoke, the owner's client
  must **rotate the session DEK**: generate a new DEK, re-wrap it to the owner (and any
  remaining grantees), re-encrypt subsequent messages under it, and leave prior messages
  under the old DEK. This is real work (a DEK-rotation path does not exist today) and only
  protects content produced *after* rotation. **Recommendation for v1: do NOT rotate.** State
  the limitation plainly to users instead ("revoking stops future access from our servers; it
  cannot make someone forget a session they've already opened"). Revisit rotation only if a
  concrete requirement demands forward-secrecy-after-revoke.
- **Local cache:** the grantee's client should, on receiving "share-revoked," purge its
  cached plaintext for that session as a good-citizen measure — but this is best-effort and
  **must not be presented to the owner as a security guarantee** (a malicious grantee's
  client can ignore it). It's hygiene, not enforcement.

---

## 9. Explicitly out of scope for v1

- **Per-workspace / "share everything" sharing** (Decision B2) — deferred; per-session only.
- **DEK rotation on revoke / forward secrecy** (§8) — deferred; the delivered-key limitation
  is documented, not solved.
- **Re-sharing / transitive grants** — only the owner may create shares. A grantee cannot
  grant onward.
- **Field-level redaction / partial transcripts** — a share is all-or-nothing for the
  session. No masking of secrets within a shared session.
- **Account directory / search** unless Decision (§7) picks Option 2 — and even then, scoped
  to exact-handle/email resolution, not browsing.
- **Grantee-facing session management** (archive, delete, rename, notification settings) —
  owner-only (§5, owner-only bucket).
- **Team/org constructs** (groups, org-wide sharing, roles beyond viewer/approver) — this is
  1:1 per-session sharing, not a teams feature.
- **Approver role** *if* Decision A picks A1 (view-only-first) — the schema reserves `role`
  but the write/RPC path (§5 write bucket, §6b) ships later.

---

## 10. Open questions for the product owner

The decisions below must be made by a human before implementation (`FL4.3`/`FL4.4`) can
start. This is the honest list of what is genuinely undecided — not padded with fake
certainty.

1. **View-only first, or view+approve together?** (Decision A.) This gates whether §6b (the
   hard RPC-routing change) is in the first release at all. *Doc leans A1 (view-only first).*
2. **Per-session or per-workspace scope?** (Decision B.) *Doc leans B1 (per-session).*
3. **Grant lifetime** — until-revoked, TTL, or both? And separately, **what TTL bounds an
   unredeemed invite?** (Decision C.) *Doc leans: grants until-revoked; invites hard-TTL'd.*
4. **Invite mechanism** — redeemable share link (Option 1) or handle/email lookup (Option 2)?
   This has the biggest UX and privacy implications and is the least-defined piece. *Doc
   leans Option 1, but this is a real product call, especially the account-enumeration
   tradeoff.*
5. **What may an approver write?** (§5 write bucket.) Specifically: can an approver do
   anything beyond `perm.answer` + send message + interrupt? Should CAS writes to session
   metadata (rename, etc.) be approver-allowed or owner-only? Per-field review needed.
6. **Does a viewer appear in the owner's `GET /v1/sessions` / `/v1/sync`, and does a shared
   session appear in the *grantee's*?** (§5, `sync.ts:41`/`sessions.ts:144-145`.) The grantee
   almost certainly wants shared sessions to show up in their list; confirm, and confirm the
   owner doesn't accidentally start seeing the grantee's unrelated sessions.
7. **Consent:** does a grantee have to *accept* a share before their key is used / before
   they gain access, or is being granted enough? (Interacts with the invite mechanism.)
8. **Notification settings on a shared session** — personal-per-account, owner-only, or
   shared? (§5 owner-only bucket, `notificationSettings.ts`.) *Doc leans owner-only for v1,
   but "personal per-account" is arguably more correct.*
9. **Revocation honesty in the UI** — sign-off that we will state the "cannot un-teach a
   delivered key" limitation plainly to owners, rather than implying revoke is a hard
   confidentiality boundary. (§1, §8.) This is a product/comms decision as much as a
   technical one.
10. **Is `rpcHandler` gaining a DB dependency acceptable?** (§6b.) It is currently a pure,
    ported-wholesale Socket.IO module (`rpcHandler.ts:5`); teaching it session-ownership
    resolution is an architectural change worth an explicit yes/no (inject a seam vs.
    interpose a pre-routing authz step).
```
