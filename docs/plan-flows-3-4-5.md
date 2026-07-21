# Implementation plan — core user flows 3, 4 & 5

This document is the implementation/fix plan for the three remaining core user flows
described in `docs/user-flows.md` (the reference doc: the five flows, their live-tested
status as of 2026-07-19, and file:line citations). Flows **1** and **2** ("started at my
desk, walked away" / "check in from work") already have their own fix plan further down in
`docs/user-flows.md` and have since been **implemented and verified** in a later session —
this document does not re-open them. It covers only:

- **Flow 3 — "Kick something off remotely"** (spawn a fresh session from web alone).
- **Flow 4 — "Pair with a teammate"** (a genuinely different person views/approves a session).
- **Flow 5 — "Oh wait, don't do that"** (catch and deny a risky action before it runs).

It follows the same rigour and section shape as `docs/bug-fix-plan.md`
(Problem / Root cause / Proposed fix / Testing notes per flow), and closes with a **Master
TODO checklist (execution units)** using the same `[inline]`/`[bundle]`/`[solo]`/`[human]`
convention that doc's own checklist established, each unit carrying an explicit
**Definition of Done**, driven by `.claude/workflows/falcon-flows-workflow.js` — a fork of
`falcon-bugfix-workflow.js` adapted for this doc's `FL*.*` units and Flow 4's human-gate
dependency chain. Unit IDs use the
`FL` prefix (`FL3.1`, `FL4.1`, …) so they never collide with `docs/bug-fix-plan.md`'s `BF`
units or `plan-v2.md`'s `U` units if the three ever run side by side.

**Every code quote below was read fresh from the current source on `v2-pty-injection`**, not
paraphrased from `docs/user-flows.md`'s earlier description. Where a claim is design-level or
otherwise unverified against real code — which is most of Flow 4 — it is called out
explicitly and loudly, per this task's brief: a confident but fabricated schema is worse than
an honest "this needs a design review first."

**Revision note:** this doc was independently audited after its first draft; four corrections
from that audit are folded in inline (marked "**Correction (caught by review)**" or "**Added by
review correction**" at each spot) — most notably that Flow 5's push fix only covers
terminal-started sessions, not the headless/ACP path, and that Flow 3's wire-compat fix needs a
multi-value literal, not an enum. The headline table below reflects the corrected status.

**Headline status re-verification (important — supersedes `docs/user-flows.md`'s stale
labels):**

| Flow | `docs/user-flows.md` (2026-07-19) | Actual current status (verified in code, this pass) |
|------|-----------------------------------|-----------------------------------------------------|
| 3 | ⚠️ works only for pre-registered folders; no dedup | Confirmed. Real root cause traced; a genuine §12 security trade-off must be decided, not hand-waved. |
| 4 | ❌ not implemented at all | Confirmed unimplemented **and** undesigned. The one bright spot: the core crypto sharing primitive (`wrapDek` to any content pubkey) **already exists** — the rest is net-new schema + broad authz rewiring + an undesigned invite UX. |
| 5 | ❌ blocked by the missing push call (shared with flow 1) | **RESOLVED for terminal-started sessions only; unresolved for daemon-spawned/headless sessions.** The flow-1 push fix landed on the terminal PTY flow's permission bridge. It was **not** wired into the ACP path the headless `--starting-mode remote` flow uses (exactly the sessions Flow 3's wizard spawns) — that pipeline has its own permission handler with no attention/notify call at all. See the corrected status below. |

---

## Flow 3 — "Kick something off remotely"

> Not at any machine with the code. Open web, "New session," pick machine + folder, no
> terminal involved at all.

### Problem

The New Session wizard is real end-to-end (machine picker → directory picker → `spawn`
machine RPC → daemon → live `falcon claude --starting-mode remote` process), and it works
for a folder previously registered via `falcon workspace register` from a terminal. But a
**genuinely fresh folder** — one the user browses to and picks cold in the web UI, that was
never registered — fails at final submit with `unknown-workspace`. That directly undercuts
the flow's whole premise ("no terminal needed"): you still need a terminal, once, to register
the folder. Separately, there is **no dedup guard**: submitting the wizard twice for the same
directory launches two independent `falcon claude` processes in it.

### Root cause

**1. `spawn` validates the picked directory against a registry the fresh folder was never
added to.** The web adapter sends the *picked directory itself* as the `workspaceId`
(`packages/web/src/features/new-session/live-actions.ts:32-42`):

```ts
async spawn(request) {
  const result = await rpc.call("spawn", {
    idempotencyKey: crypto.randomUUID(),
    workspaceId: request.directory,
    directory: request.directory,
    provider: request.provider,
    permissionMode: request.permissionMode,
    model: request.model,
    branch: request.branch,
    continueFrom: request.continueFrom,
  });
```

Its own header comment (`live-actions.ts:12-21`) already flags this as a stopgap:
*"there's no workspace registry yet ... so the directory a user picks here stands in as its
own stable workspace identity."* A registry now does exist, and `workspaceId` *is* a
workspace's registered real path — but a freshly-picked folder is not in it.

On the daemon side, `spawnSession` validates that `workspaceId` before launching
(`packages/cli/src/daemon/spawnEngine.ts:105-116`):

```ts
const validation = await validateSpawnWorkspace(params, deps.resolveWorkspaceRoot);
if (!validation.ok) {
  if (validation.reason === "not-found") {
    logger.info("[spawn-engine] target directory does not exist, requesting approval", {
      directory: params.directory,
    });
    return {
      requiresApproval: { action: "create-directory", directory: params.directory },
    };
  }
  throw new SpawnError(`workspace path rejected (${validation.reason}): ${params.directory}`);
}
```

Note the asymmetry: `not-found` (directory doesn't exist) resolves to a graceful
`requiresApproval` the wizard already handles (`spawn-flow.ts`'s 409 create-directory loop);
**every other rejection — including `unknown-workspace` — throws** and surfaces to the wizard
as a hard error.

`validateSpawnWorkspace` returns `unknown-workspace` exactly when the injected
`resolveWorkspaceRoot(workspaceId)` yields `null`
(`packages/cli/src/daemon/workspacePath.ts:51-54`):

```ts
const root = await lookupRoot(params.workspaceId);
if (root === null || root === undefined) {
  return { ok: false, reason: "unknown-workspace" };
}
```

And the real `resolveWorkspaceRoot` the daemon wires in
(`packages/cli/src/workspace/adapters.ts:38-43`) returns `null` for any path not present in
`~/.falcon/workspaces.json`:

```ts
export function createWorkspaceRootLookup(options: RegistryOptions = {}): WorkspaceRootLookup {
  return async (workspaceId: string) => {
    const entries = await listWorkspaces(options);
    return entries.some((entry) => entry.path === workspaceId) ? workspaceId : null;
  };
}
```

wired at the composition root `packages/cli/src/daemon/commands.ts:266`
(`resolveWorkspaceRoot: createWorkspaceRootLookup({ homeDir })`). So: pick a fresh folder →
`workspaceId` = its path → not in `workspaces.json` → `null` → `unknown-workspace` → `spawn`
throws. Exactly the reported symptom.

**2. The `unknown-workspace` guard is not incidental — it is a deliberate security boundary
(design §12).** `workspacePath.ts:1-14`'s own module doc:

> A `spawn` RPC arrives over the relay from a remote client — the daemon must never treat its
> `directory` field as a bare, trusted filesystem path: that would make `spawn` an
> arbitrary-directory (and therefore effectively arbitrary-command-context) execution
> primitive for anyone who can reach the account's machine RPC target.

Crucially, the directory *picker* (`fs.list`/`fs.mkdir`) is intentionally **not** so
constrained (`packages/cli/src/daemon/fsBrowse.ts:8-14`):

> Deliberately NOT scoped to a registered workspace root the way `workspacePath.ts`'s
> `validateSpawnWorkspace` is — that's exactly the point of a directory picker: the user is
> choosing which directory *becomes* a workspace. `spawn`'s own workspace-path validation
> remains the real "no arbitrary-directory execution" boundary (design §12); this module only
> lets the caller see and create directories, never launches anything in them.

So the fix cannot be a blind "auto-register whatever path arrives" inside
`resolveWorkspaceRoot` — that would silently delete the design's only guard against remote
arbitrary-directory *execution*. Whatever we do has to register a fresh folder as a genuine,
deliberate act of designation, not as an unconditional side effect of any inbound `spawn`.
**This is the one real judgement call in Flow 3, and it is called out again in the fix.**

**3. No dedup: the daemon does not track which directory a live session runs in.**
`TrackedSession` (`packages/cli/src/daemon/types.ts:28-38`) has no `directory`/`workspaceId`
field:

```ts
export interface TrackedSession {
  startedBy: "daemon" | string;
  sessionId?: string;
  provider?: "claude-code" | "codex";
  permissionMode?: PermissionMode;
  metadata?: unknown;
  encryption?: SessionEncryptionData;
  pid: number;
  error?: string;
}
```

The idempotency-key cache in `machineRpc.ts` only dedups an exact *RPC retry* (same
`idempotencyKey`) — two distinct wizard submissions mint two distinct keys
(`crypto.randomUUID()` at `live-actions.ts:34`) and both spawn. So there is nothing today
that can answer "is a session already live in this directory?"

### Proposed fix

Two independent pieces. Piece A resolves `unknown-workspace`; Piece B adds the dedup guard.

**A. Auto-register the picked directory as a workspace during the spawn flow — explicitly,
once, at the daemon.** The wizard's directory picker's entire purpose is "the user is
choosing which directory *becomes* a workspace" (fsBrowse.ts's own words). Treat a
`spawn` whose directory is not yet registered the same way the code already treats a
`spawn` whose directory does not yet exist: as a **first-class approval step**, not a hard
error.

Recommended shape (preserves the §12 consent boundary — the register only happens on an
explicit, user-confirmed action from the web, mirroring the existing create-directory loop):

1. Add a second `requiresApproval` action to the wire result. Today it is a single literal
   (`packages/wire/src/rpc.ts:62-71`):

   ```ts
   export const SpawnResultSchema = z.object({
     sessionId: z.string().optional(),
     requiresApproval: z
       .object({
         action: z.literal("create-directory"),
         directory: z.string(),
       })
       .optional(),
   });
   ```

   **Correction (caught by review — do not use `z.enum` here):** the repo's additive-only
   wire-compat lint (`packages/wire/src/__tests__/schemaShape.ts`'s `isCompatible`, `:79-84`)
   rejects any change where `prev.kind !== next.kind`, with no exemption for literal→enum.
   `describeShape` (`schemaShape.ts:63-69`) reports a `z.literal(...)` as `kind: "literal"` but
   a `z.enum([...])` as a *different* `kind: "enum"` — so swapping to `z.enum` is a breaking
   kind change under the frozen fixture (`__tests__/__fixtures__/wire-shapes.json`, which
   already records `SpawnResultSchema`'s `action` as `{kind:"literal", values:["create-directory"]}`)
   and would fail `additiveOnly.test.ts`. Widen it as a **multi-value literal** instead — this
   stays `kind: "literal"`, and the values-superset check (`schemaShape.ts:118-121`) treats
   adding a value as compatible:

   ```ts
   action: z.literal(["create-directory", "register-workspace"]),
   ```

   This is genuinely additive under the lint. One residual hazard the lint can't catch: an
   older, already-deployed web client whose local schema copy only accepts
   `"create-directory"` will still fail to parse a `"register-workspace"` response until it
   updates — worth a note in the rollout, not a blocker to landing the server/wire change.

2. In `spawnEngine.ts`, when `validateSpawnWorkspace` returns `unknown-workspace`, resolve
   with `requiresApproval: { action: "register-workspace", directory }` instead of throwing
   (`spawnEngine.ts:106-116`):

   ```ts
   if (!validation.ok) {
     if (validation.reason === "not-found") {
       return { requiresApproval: { action: "create-directory", directory: params.directory } };
     }
     if (validation.reason === "unknown-workspace") {
       // The user picked a folder never registered from a terminal. Rather
       // than a dead-end error, surface the same approval loop the missing-
       // directory case uses — the web confirms "register this folder as a
       // workspace?", registers it (a deliberate designation act, preserving
       // design §12's consent boundary), and retries spawn with the same key.
       return { requiresApproval: { action: "register-workspace", directory: params.directory } };
     }
     throw new SpawnError(`workspace path rejected (${validation.reason}): ${params.directory}`);
   }
   ```

   (`outside-workspace-root`, `not-absolute`, `not-directory` still throw — those are real
   rejections, not "please add this for me.")

3. Add a `workspace.register` machine RPC (or reuse the create-directory pattern: a new
   `NewSessionActions.registerWorkspace(directory)` backed by an RPC) that calls the already
   real, already idempotent `registerWorkspace(directory, …)`
   (`packages/cli/src/workspace/registry.ts:211-239`) — it creates the `workspaces.json` entry
   (real, symlink-resolved path) and is a safe no-op if the folder is registered already.

4. Extend the web `runSpawnFlow` loop (`packages/web/src/features/new-session/spawn-flow.ts`)
   to branch on the new action exactly as it already branches on `create-directory`: prompt
   the user ("Add this folder as a Falcon workspace?"), on approval call
   `actions.registerWorkspace(directory)`, then retry `actions.spawn(request)` once with the
   same request, mirroring the create-directory retry at `spawn-flow.ts:32-45`.

   **Correction (caught by review):** the doc originally claimed the retry reuses the same
   `idempotencyKey`. It doesn't today — `live-actions.ts:34` mints a fresh
   `crypto.randomUUID()` inside `spawn()` on every call, so the register-then-retry call gets
   a brand-new key, not the original one. `spawnEngine.ts`'s own module doc describes
   same-key-retry semantics, but the web adapter doesn't actually implement that yet. This is
   harmless for this fix specifically (the first, failed attempt never spawned anything to
   dedup against), but it's worth noting as existing behavior to fix separately if idempotent
   retry semantics matter elsewhere — don't assume this call site already provides them.

> **Simpler-but-looser alternative (explicitly flagged):** skip the wire change and just have
> the *web wizard* call a `workspace.register` RPC unconditionally right before `spawn` on a
> fresh-folder pick. This works, but it registers on every submit with no explicit user
> "yes," which is a weaker consent story than the create-directory loop the codebase already
> models. Recommend the approval-loop shape above for parity and to keep §12's "deliberate
> designation" property intact. **Do not** implement Piece A by making
> `createWorkspaceRootLookup` auto-insert on lookup — that dissolves the §12 boundary for
> *every* inbound `spawn`, including replayed/relayed ones, which is the exact threat
> `workspacePath.ts` exists to prevent.

**B. Dedup: track each live session's directory and short-circuit a duplicate spawn.**

1. Add a `directory?: string` (the resolved real path) to `TrackedSession`
   (`packages/cli/src/daemon/types.ts:28-38`) and populate it where the daemon records a
   spawned pid (`sessionRegistry.ts`'s `trackSpawned`/`onSessionStarted` path — the spawn
   engine already knows `spawnDirectory`, `spawnEngine.ts:118/154`).

2. In `spawnSession`, after workspace validation resolves `validation.realDirectory` and
   before launching, consult the registry for an existing live session in that same real
   directory. The daemon composition (`machineIntegration.ts:295-302`) already holds a
   `registry` handle with `getSessions()`
   (`sessionRegistry.ts:52-53`) — thread a
   `findLiveSessionInDirectory(realDirectory): string | null` seam into `SpawnEngineDeps`
   (defaulting to a scan of `registry.getSessions()` for a matching `directory` with a live
   `sessionId`). When one is found, return that existing `sessionId` instead of spawning a
   second process — making `spawn` idempotent-by-directory for the "already running" case,
   which needs **no** wire-schema change (`SpawnResult.sessionId` already carries it).

   > If product prefers an explicit "a session is already running here — open it or start
   > another?" prompt rather than silently returning the existing one, model it as a third
   > `requiresApproval` action (`action: "duplicate-session"`, carrying the existing
   > `sessionId`) and let the web decide. Either is defensible; returning the existing session
   > is the smaller, safer default and is what the checklist assumes.

3. Complementary (not a substitute) client-side pre-check: the session list already carries a
   per-session `workspaceId` (`packages/wire/src/rows.ts:17`,
   `LocalSessionInfoSchema.workspaceId` at `packages/wire/src/rpc.ts:86`), so the wizard can
   grey out / warn on a directory that already has a live session before the user even
   submits. This improves UX but is racy across devices — the daemon-side guard in (2) is the
   authoritative one.

### Testing notes

- `packages/cli/src/daemon/workspacePath.test.ts` already asserts the `unknown-workspace`
  result (`:50`, `:108`) — keep those; they now describe the *input* to the new approval
  branch rather than a terminal error.
- New `spawnEngine` tests: (a) an unregistered `workspaceId` resolves to
  `requiresApproval: { action: "register-workspace", directory }`, not a throw; (b) after a
  simulated register + retry with the same `idempotencyKey`, the second call validates and
  launches; (c) a spawn whose resolved directory matches an already-live tracked session
  returns that session's id and never calls the process launcher.
- Wire: extend `packages/wire/src/rpc.test.ts` (`SpawnResultSchema` block, `:142-151`) with
  the `register-workspace` action variant, and confirm `additiveOnly.test.ts` still passes
  against the widened multi-value literal (this is the load-bearing "is it really additive?"
  check — a `z.enum` here would fail it, see the correction in the Proposed fix section above).
- Web: extend `spawn-flow.test.ts` with a `register-workspace` → approve → register → retry →
  success path (mirroring its existing create-directory test), and a decline path returning
  `{ outcome: "declined" }`.
- `[human]` live: from a second machine's browser, run the wizard against a real daemon, pick
  a folder that was **never** `falcon workspace register`'d, confirm the register-approval
  prompt appears, approve it, and confirm a live `falcon claude --starting-mode remote`
  process starts in that folder and mirrors to web. Then submit the wizard a second time for
  the same folder and confirm it does not spawn a duplicate.

---

## Flow 4 — "Pair with a teammate"

> Someone else views/approves your session live from their own device.

### Problem

There is **no way for a genuinely different person** to view or approve one of your sessions.
`docs/user-flows.md` marks this ❌ "not implemented at all," and a fresh code read confirms it
is not only unimplemented but **undesigned**: a grep of `falcon-system-design.md` and
`falcon-prd.md` for `collaborat`/`teammate`/`multi-account`/`grantee`/`session share` returns
nothing. Every table, route, and Socket.IO room is single-`accountId`-scoped. The existing
"pairing" primitive is *device* pairing — it hands a **new device of the same account** the
whole account secret; it is not scoped, per-session access for a second identity.

This is real net-new feature work — new schema + a sharing crypto step + broad authorization
rewiring + an undesigned invite UX — **not** a thin UI addition. The rest of this section is
therefore split hard into *grounded* (verified against current code) and *speculative*
(design-level, needs a design review before implementation). **Per the brief: the schema and
API shapes below marked speculative must not be treated as settled — they are a starting point
for a design review, not an implementation spec.**

### Root cause (what exists today vs. what is genuinely missing)

**GROUNDED — what exists (verified):**

1. **Identity is one account.** `accounts` (`packages/server/src/db/schema.ts:25-39`) anchors
   on `signPublicKey` (unique) and stores a `contentPubKey`:

   ```ts
   export const accounts = pgTable("accounts", {
     id: text("id").primaryKey().$defaultFn(createId),
     signPublicKey: text("sign_public_key").notNull().unique(), // hex; identity anchor
     contentPubKey: text("content_pub_key").notNull(),
     ...
   });
   ```

   Every other table foreign-keys `accountId` with `onDelete: "cascade"`. There is **one**
   identity per account; a "teammate" is, definitionally, a *different* `accounts` row.

2. **Each session's data is encrypted under a single wrapped DEK bound to the owner.**
   `sessions.dek` (`schema.ts:88`) is a wrapped DEK; message content
   (`session_messages.content`, `schema.ts:109`) is an `EncryptedBox` of `SessionEnvelope[]`
   sealed under that DEK. The server holds no keys (`schema.ts:14-23`).

3. **The crypto primitive for scoped, per-session sharing ALREADY EXISTS.** This is the one
   genuinely reassuring finding. The session DEK is wrapped with a *sealed box to a content
   public key* (`packages/crypto/src/dek.ts:20-35`):

   ```ts
   /** Wrap a DEK to `contentPublicKey` — only the matching content secret key can unwrap it. */
   export function wrapDek(dek: Uint8Array, contentPublicKey: Uint8Array): Uint8Array { ... }

   /** Unwrap a DEK with the content secret key. Returns `null` on any failure — never throws. */
   export function unwrapDek(wrapped: Uint8Array, contentSecretKey: Uint8Array): Uint8Array | null { ... }
   ```

   Nothing about `wrapDek` requires the target public key to be the *owner's*. To grant a
   teammate scoped access to exactly one session, the owner (who can `unwrapDek` that
   session's DEK with their own `content.secretKey`, derived at
   `packages/crypto/src/keys.ts:104-115`) simply **re-wraps that same session DEK to the
   teammate's `contentPubKey`**: `wrapDek(sessionDek, teammateContentPubKey)`. The teammate
   unwraps it with *their own* content secret key and can then `open()` that session's
   messages — **without ever seeing the owner's master secret or any other session's DEK**.
   This is scoped per-session sharing with no new cryptography. This part is not speculative.

**GROUNDED — what's missing (verified absent):**

4. **No place to store a per-session grant.** There is no `session_shares`/`collaborators`
   table. `pairRequests` (`schema.ts:134-142`) is device pairing, and its `response` column is
   explicitly *"sealed box to ephPub: master secret / content key bundle"* — i.e. it hands the
   **whole account key material** to a new device, the opposite of scoped sharing.

5. **Authorization is `accountId`-equality everywhere.** Every session-scoped route gates on
   `eq(sessions.accountId, accountId)` — a non-exhaustive but representative list, all
   verified:
   `sessionNotify.ts:61`, `messages.ts:69` and `:156`, `sessionCas.ts:46` and `:82`,
   `notificationSettings.ts:95`/`:108`, `sessionArchive.ts:53`/`:64`/`:107`,
   `sessionStatus.ts:83`/`:96`, `blobs.ts:102`, `sync.ts:41`, `sessions.ts:87`/`:144-145`. A
   teammate (different `accountId`) fails **all** of them.

6. **Socket.IO rooms are namespaced by `accountId`, so a teammate can't even join the room.**
   `packages/server/src/app/events/eventRouter.ts:116-128` joins
   `user:${accountId}`, `user:${accountId}:session:${sessionId}`, etc., and
   `RecipientFilter` (`eventRouter.ts:40-44`) only ever fans out within one account's rooms:

   ```ts
   export type RecipientFilter =
     | { type: "all-interested-in-session"; sessionId: string }
     | { type: "user-scoped-only" }
     | { type: "machine-scoped-only"; machineId: string }
     | { type: "all-user-authenticated-connections" };
   ```

   The socket handshake stamps `socket.data.accountId` (`app/socket.ts:86`) and all
   membership derives from it (`socket.ts:99,118`). Live session updates for session `S`
   never reach anyone outside `S`'s owner account.

7. **(Added by review correction) Session RPCs — the entire *approve* half of teammate
   sharing — have their own account-keyed routing, separate from the HTTP routes audited in
   point 5.** `message`, `perm.answer`, interrupt, and `setMode` all go over the socket RPC
   layer, not an HTTP route. `packages/server/src/app/socket/rpcHandler.ts` computes the
   target room as `` `${RPC_ROOM_PREFIX}${accountId}:${target}` `` (`rpcRoom`, `rpcHandler.ts:93-94`),
   using the **caller's own** `accountId` to look up where to deliver the call
   (`rpcHandler.ts:230`, `fetchRoomSockets(io, rpcRoom(accountId, target), ...)`). A grantee
   calling `perm.answer` would look up `rpc:<granteeAccountId>:session:<S>` and find nothing —
   the owner's CLI registered its RPC target under the *owner's* account, not the grantee's.
   This means the authorization rewiring in point 3/FL4.3 below is necessarily incomplete if it
   only touches the HTTP routes in point 5 — the RPC routing itself needs a parallel mechanism
   (e.g. resolving the *session's* registered RPC target regardless of which account is
   calling, once that caller is confirmed to hold a valid, non-revoked share). This is exactly
   the "missing one check" failure mode the original write-up warned about, applied to itself.

### Proposed fix — SPECULATIVE / DESIGN-LEVEL (needs review before any code)

> **Read this header before the shapes below.** Everything in this subsection past point (1)
> is a *design proposal*, not a verified spec. The DB columns, route names, and RPC shapes are
> illustrative — they must go through a design review (threat model, invite/trust model,
> revocation semantics, and a decision on approve-vs-view-only scope) before implementation.
> The task brief is explicit that a confident-but-fabricated schema here is worse than an
> honest "design this first." I am flagging it as such.

1. **Reuse the existing sharing crypto (grounded).** Grant = owner re-wraps the session DEK
   to the grantee's `contentPubKey` via the existing `wrapDek` (`crypto/src/dek.ts:21`). No
   new crypto primitive is needed or should be invented.

2. **New table (speculative shape).** Something like:

   ```
   session_shares
     id                text pk
     sessionId         text  -> sessions.id (cascade)
     ownerAccountId    text  -> accounts.id (cascade)
     granteeAccountId  text  -> accounts.id (cascade)
     wrappedDek        bytea   -- session DEK sealed to grantee.contentPubKey (wrapDek)
     role              text    -- e.g. 'viewer' | 'approver'  (view-only vs. can answer perms)
     createdAt         timestamp
     revokedAt         timestamp null
     unique(sessionId, granteeAccountId)
   ```

   Open questions a design review must settle (do **not** guess): whether `role` is even MVP
   (view-only might ship first, "approver" later); how revocation interacts with a DEK the
   grantee already cached (a revoke can stop *new* server fan-out but cannot un-teach a key
   already delivered — the honest property, must be documented, not glossed); and whether a
   share is per-session or per-workspace.

3. **Authorization rewiring (grounded scope, speculative mechanism).** Introduce a single
   server-side helper — call it `assertSessionAccess(db, sessionId, accountId)` — that returns
   the caller's effective role if they are either the owner (`sessions.accountId === accountId`)
   **or** hold a non-revoked `session_shares` row. Then replace the ~15 inline
   `eq(sessions.accountId, accountId)` checks listed in root-cause point 5 with a call to it,
   gating write-capable routes (`messages` POST, `perm.answer`, `sessionStatus`) on the
   `approver` role and read routes on any role. This is broad but mechanical once the helper
   exists — the risk is *missing one* check, so an exhaustive audit of every `sessions`
   query is part of the unit, not optional.

4. **Socket room rewiring (grounded scope, speculative mechanism).** Either (a) let a
   grantee's session-scoped socket join the *owner's* `user:${ownerAccountId}:session:${S}`
   room (cross-account room membership — the current keying forbids this, so it's a real change
   to `eventRouter.addConnection`), or (b) fan `all-interested-in-session` out to a computed
   set of `{owner} ∪ {grantees}` rooms. Option (b) keeps rooms account-namespaced (cleaner)
   but requires every `emitUpdate`/`emitEphemeral` for a session to resolve its grantee set.
   This choice is itself a design-review item.

5. **Invite / trust handshake (fully speculative — the least-defined piece).** The owner must
   learn the grantee's `contentPubKey` and account identity before it can `wrapDek` to them.
   There is *no* existing primitive for a cross-account invite (device `pairRequests` is
   same-account only). Options span a share-link that the grantee redeems while signed into
   their own account, an email/handle lookup, etc. **This needs a product + threat-model
   decision first and should not be built speculatively.**

### Testing notes

- Because most of this is unbuilt and undesigned, the only *code-grounded* test that can be
  written today is a crypto round-trip proving the sharing primitive: in
  `packages/crypto/src/__tests__/`, generate two independent key trees (owner, teammate) via
  `deriveKeyTree`, `wrapDek(sessionDek, teammate.content.publicKey)`, and assert
  `unwrapDek(wrapped, teammate.content.secretKey)` recovers the DEK while
  `unwrapDek(wrapped, owner.content.secretKey)` returns `null`. This validates the one
  non-speculative claim and is a useful anchor for the eventual feature.
- Everything else (schema, routes, sockets, invite) is gated behind a design review; do not
  author tests against invented shapes.
- `[human]`/design: a written design doc (threat model + schema + authz + invite flow +
  revocation semantics) is the real first deliverable here, not code.

---

## Flow 5 — "Oh wait, don't do that"

> Catch a risky action and deny it before it executes, via a push notification.

### Status: RESOLVED for terminal-started sessions; UNRESOLVED for headless/ACP sessions (corrects an earlier overclaim in this doc, and supersedes `docs/user-flows.md`'s stale label for the terminal case)

`docs/user-flows.md:54-60` marks Flow 5 ❌, blocked by *the same missing push call as flow
1*. That label is **stale**: the flow-1 push fix has since landed, and it unblocks flow 5's
push half end-to-end. Verified fresh this pass:

**1. The CLI→server notify client now exists and is wired.** `packages/cli/src/api/sessionNotify.ts`
is real (`reportSessionAttention(deps, { sessionId, kind })`, kinds
`"perm" | "question" | "done"`, `sessionNotify.ts:23,49-51`), POSTing
`POST /v1/sessions/:id/notify` (`sessionNotify.ts:63,69`).

**2. It is called at the exact pre-execution points.** `start.ts` wires a `reportAttention`
helper (`packages/cli/src/commands/start.ts:542-547`):

```ts
const reportAttention = (kind: SessionAttentionKind): void => {
  void doReportSessionAttention(statusDeps, {
    sessionId: bootstrap.sessionId,
    kind,
  });
};
```

and hooks it into the permission bridge's attention callbacks
(`start.ts:744-769`): `onPendingAttention: (kind) => reportAttention(kind)` fires the push for
`perm`/`question`, and the `Stop`-hook `done` path calls `reportAttention("done")`.

**3. The push fires BEFORE the tool runs, and the hook blocks awaiting the answer — so
deny-before-execution is a real property, not a race.** `onPendingAttention("perm")` is
emitted from inside `handlePermissionRequest`
(`packages/cli/src/claude/pretoolPermissionBridge.ts:651-652`):

```ts
this.cachePermissionMode(input.permission_mode);
// Fires regardless of local vs. web — see `onPendingAttention`'s own doc.
this.deps.onPendingAttention?.("perm");
```

`handlePermissionRequest` is Claude Code's blocking `PermissionRequest` hook: on a web turn it
returns a Promise that resolves only when a `perm.answer` arrives, times out (→ deny), or
resets (`pretoolPermissionBridge.ts:639-693`, and the header contract at `:102-113`: *"A
blocked `PreToolUse` hook holds up the tool ... the tool is NOT run"*). So for a web-driven
turn, the push arrives *and* the tool is genuinely held until you answer — "notified before it
happens" is immediate and correct.

**4. The server route this drives is fully built and presence-suppressed.**
`POST /v1/sessions/:id/notify` (`packages/server/src/app/routes/sessionNotify.ts:38-77`)
emits an `attention` ephemeral and fires
`pushDispatcher.dispatch({ accountId, sessionId, kind })`, suppressed when a foregrounded tab
is already watching (design §6.4).

**Conclusion (as first drafted — incomplete, see correction immediately below):** Flow 5's
original blocker (the missing push call) is gone for terminal-started sessions. The push half
and the deny-before-execution timing are both resolved and verified in current source for that
path — exactly as the brief anticipated ("wiring push once should unlock both flows 1 and 5
simultaneously").

### Correction (caught by review): this fix does not cover headless/ACP sessions

The verification above only checked the terminal PTY flow. `reportSessionAttention` has
exactly one caller anywhere in the CLI: `commands/start.ts`'s terminal-PTY code path. `start.ts`
says so directly in its own doc comment (`start.ts:225-232`):

```ts
/**
 * Injectable for tests; defaults to the real remote-permission hook
 * installer (the single hook server owning all four hooks —
 * `claude/remotePermissionHook.ts`). Only installed on the terminal PTY
 * flow; the headless `--starting-mode remote` flow uses ACP's own
 * agent-side permission pipeline instead.
 */
```

`packages/cli/src/acp/acpPermissionHandler.ts` — the permission handler the headless/remote
flow actually uses — has no attention/notify call anywhere in it. The server route confirms
this is a known, not-yet-landed gap, in its own doc comment
(`packages/server/src/app/routes/sessionNotify.ts:29-31`):

```ts
 * will POST here on a remote-initiated turn's completion once that call site
 * is wired (out of scope for this task — CLI is a disjoint worktree); the
 * permission pipeline (§2.3) will POST here for `perm`/`question` once it
 * lands. Both are unblocked by this route existing now: `kind` is generic,
```

So: a session spawned by Flow 3's wizard (`falcon claude --starting-mode remote`, ACP-driven)
never pushes a permission-pending notification today. This is arguably the *canonical* flow-5
scenario — "kicked something off remotely, walked away, need to catch a risky action before it
runs" — and it is not resolved. Flow 5 is genuinely resolved only for the "started at my desk"
terminal case (flow 1's own scenario).

### Proposed fix (addition): wire attention into the ACP/headless permission path

Mirror the terminal-PTY wiring (`start.ts:542-547`'s `reportAttention` /
`pretoolPermissionBridge.ts:650-652`'s `onPendingAttention` call) into
`acp/acpPermissionHandler.ts`'s equivalent decision points: call
`reportSessionAttention(deps, { sessionId, kind: "perm" | "question" })` at the point the ACP
handler is about to block awaiting a `session/request_permission` response, and `kind: "done"`
on turn completion, matching the existing kind vocabulary in `api/sessionNotify.ts`. This needs
its own `deps` threading (`acpRemote.ts`'s composition root) since the ACP path doesn't share
`start.ts`'s dependency wiring.

### Honest residual boundary (the one precise gap, for the already-resolved terminal path)

There is one nuance worth stating plainly rather than papering over. The **deny-from-web** path
only routes to the web PermCard for a **web-initiated** turn. For a **purely local** turn
(typed at the terminal, then walked away), `handlePermissionRequest` returns `undefined` and
lets the terminal TUI dialog own it — no `perm-request` is emitted to web
(`pretoolPermissionBridge.ts:656-662`):

```ts
if (!this.deps.isWebTurnActive()) {
  // Locally-typed turn: never intercept — the terminal user is already
  // looking at the TUI dialog Claude Code is about to show.
  this.deps.logger?.debug("[pretool-bridge] local turn — TUI dialog owns it", { toolName });
  this.deps.onPromptLikely?.();
  return Promise.resolve(undefined);
}
```

`isWebTurnActive()` flips true only once a web message is submitted
(`start.ts:815-817` → `markWebTurnStart()`; `remotePermissionHook.ts:189-215`). Consequence:

- **Fully working:** you drive/monitor the session from web (a follow-up sent from web, i.e.
  the natural remote-control path). A risky action's permission fires → push arrives → you tap
  in → the PermCard is there → you deny → the tool never runs. This is the flow-5 experience,
  and it works.
- **Residual boundary:** a permission that arises inside a *purely local* turn still pushes
  (the `onPendingAttention` fires *"regardless of local vs. web"*, `bridge:651`), so you *are*
  notified — but tapping in shows no answerable PermCard for that local-turn permission; the
  terminal dialog owns it. You can see that attention is needed but cannot deny it from the
  phone unless you take the turn over from web first.

This is a **deliberate design boundary** (the bridge's stated goal: *"the web sees exactly the
prompts a terminal user would see — no more, no less,"* `pretoolPermissionBridge.ts:75-76`),
**not** the missing-push blocker `docs/user-flows.md` cited. Whether the local-turn permission
*should* also become web-answerable (e.g. a "take control of this pending permission" affordance
that flips the turn web-active on demand) is a **product decision**, not a bug — and it is
larger than Flow 5's original scope. I am flagging it, not silently scoping it in.

### Proposed fix (summary for the terminal path) + remaining real work (headless path)

For terminal-started sessions, Flow 5's original stated blocker is already fixed; the
remaining actions there are verification, one guard test, and a product decision on the local-
turn residual boundary. For headless/ACP sessions, the "wire attention into the ACP path" fix
proposed above is real, unstarted implementation work — not just verification.

1. **Regression guard (small, real, terminal path).** Add a `start.ts` (or
   `pretoolPermissionBridge`) test asserting `onPendingAttention("perm")`/`("question")` is
   invoked from `handlePermissionRequest`/the question path *before* the tool decision
   resolves, so a future refactor can't silently drop the push call. (`sessionNotify.test.ts`
   already covers the client's POST shape at `packages/cli/src/api/sessionNotify.test.ts`;
   this guards the call *site*.)
2. **ACP/headless attention wiring (real implementation, per the correction above).** Thread
   `reportSessionAttention` calls into `acp/acpPermissionHandler.ts` and `acpRemote.ts`'s
   composition root, mirroring the terminal path's `start.ts`/`pretoolPermissionBridge.ts`
   wiring, so `perm`/`question`/`done` attention fires for daemon-spawned sessions too.
3. **Product decision (design, no code yet).** Decide whether a purely-local-turn permission
   should be answerable from web. If yes, it's a separate initiative (a "adopt this pending
   permission into a web turn" mechanism); if no, document the boundary in `docs/user-flows.md`
   so the eventual ❌→✅ status update is honest about what "resolved" means.

### Testing notes

- `[human]` live (terminal path close-out): with `falcon claude` running, send a follow-up
  **from web** that triggers a permission (e.g. a `Write`), walk away from the tab, confirm a
  push arrives on phone/another browser, tap it, deny from the PermCard, and confirm the tool
  never executes (transcript shows the deny, no file written). Then confirm suppression: with
  the tab focused, the same event does **not** push.
- `[human]` live (boundary confirmation, terminal path): trigger a permission inside a
  **purely local** turn (typed at the terminal), confirm the push still arrives but the web
  shows no answerable PermCard — documenting the residual boundary as real, not a regression.
- `[human]` live (headless path, new): from web, spawn a session via the Flow 3 wizard,
  trigger a permission remotely, walk away, confirm whether a push now arrives after the ACP
  wiring fix lands (before the fix, confirm it does *not* — pinning the gap this correction
  identified).
- Automated: the regression-guard test in fix step 1; new coverage for the ACP attention
  wiring in fix step 2 (mirroring `pretoolPermissionBridge.test.ts`'s existing attention-call
  assertions); no new automated coverage is needed for the (already-tested) client POST or the
  (already-built) server route.

---

## Master TODO checklist (execution units)

Target branch: `v2-pty-injection` — every unit lands there. This checklist is driven by
`.claude/workflows/falcon-flows-workflow.js` (same worktree/merge/ancestry-proof mechanics and
`[inline]`/`[bundle]`/`[solo]`/`[human]` semantics as `falcon-bugfix-workflow.js`, forked and
adapted for `FL*.*` units and Flow 4's human-design-review gate). It points its unit-finder at
`FL*.*` checkboxes in *this* file and keeps its cycle bookkeeping in
`docs/plan-flows-progress.md`, a separate file so it never collides with a `BF`/`U` cycle
against the same branch.

**Unit kinds** (identical semantics to `docs/bug-fix-plan.md`):

- `inline` — micro-tasks batched into ONE unit, one agent, one worktree, one pass.
- `bundle` — co-located / tightly-coupled tasks; ONE worktree, ONE pipeline, one combined
  verification.
- `solo` — big/risky/undesigned units that earn the full pipeline alone.
- `human` — needs the live stack, a real Claude Code session, or a real browser (or is a
  design/product decision); **excluded from the automated loop**, done interactively.

A unit is done only when its sub-items are checked AND its merge to `v2-pty-injection` is
ancestry-proven (`git merge-base --is-ancestor <tip> v2-pty-injection`).

Units are ordered by readiness: Flow 5 first (nearly done), Flow 3 next (well-defined, real
work), Flow 4 last (needs a design review before any implementation).

### Phase 0 — Flow 5 close-out (terminal path verification + real headless-path work)

- [x] **FL5.1 `[inline]` "notify-callsite-guard"** — one small regression test, no behavior
      change (terminal path is already functionally resolved).
  - [x] Add a test asserting `onPendingAttention("perm")` and `("question")` are invoked from
        `pretoolPermissionBridge.handlePermissionRequest`/the question path *before* the tool
        decision resolves (guards the `bridge:651-652`/`:588-589` call sites against a silent
        future drop). Reuse the existing bridge test harness.
  - [x] Scoped tests + `pnpm typecheck` + commit.
  - **Definition of Done:** a new test exists that FAILS if either `onPendingAttention` call
    site is deleted/commented out from `handlePermissionRequest` or the question path (prove
    this by temporarily removing the call locally and watching the new test fail, then
    restoring it — do not just assert the call exists via a snapshot that would pass either
    way); full `pnpm test` and `pnpm typecheck` clean in the worktree; no production
    behavior changed (this unit is test-only); commit lands.
- [x] **FL5.2 `[solo]` "acp-headless-attention-wiring"** — **real, unstarted implementation**
      (added by review correction: the original doc overclaimed this flow as fully resolved
      without checking the headless/ACP path, which has no attention call at all).
  - [x] Thread `reportSessionAttention` calls into `acp/acpPermissionHandler.ts` at its
        `session/request_permission`-blocking point (`perm`/`question` kinds) and its turn-end
        path (`done` kind), matching `api/sessionNotify.ts`'s existing kind vocabulary.
  - [x] Wire the necessary deps through `acpRemote.ts`'s composition root (the ACP path has its
        own dependency wiring, separate from `start.ts`'s terminal-path wiring).
  - [x] New tests mirroring `pretoolPermissionBridge.test.ts`'s attention-call assertions, for
        the ACP handler's equivalent call sites.
  - [x] Scoped tests + `pnpm typecheck` + commit.
  - **Definition of Done:** `acpPermissionHandler.ts` calls `reportSessionAttention` with
    `kind: "perm"`/`"question"` before it blocks awaiting `session/request_permission`, and
    `kind: "done"` on turn completion — parity with the terminal path's call-site timing
    (before the block, not after); new tests assert these call sites fire (mirroring
    `pretoolPermissionBridge.test.ts`'s pattern) and would fail if removed; `pnpm build &&
    pnpm typecheck && pnpm test` clean in the worktree; no change to non-notify ACP behavior
    (permission decisions still resolve exactly as before); commit lands.
- [ ] **FL5.3 `[human]` "flow-5-live-verify + boundary decision"**
  - [ ] Live (terminal path): web-initiated turn → risky action → push arrives away-from-tab →
        deny from PermCard → tool never runs; confirm suppression when the tab is focused.
  - [ ] Live (terminal path): purely-local turn → confirm push still arrives but no answerable
        web PermCard (documents the residual boundary as real).
  - [ ] Live (headless path, after FL5.2 lands): spawn via the Flow 3 wizard, trigger a
        permission remotely, walk away, confirm a push now arrives.
  - [ ] Product decision: should a local-turn permission become web-answerable? Record the
        decision (and, once FL5.2 lands, update `docs/user-flows.md`'s Flow 5 status to ✅ with
        both the local-turn boundary and the terminal-vs-headless distinction noted honestly).
  - **Definition of Done:** all 3 live scenarios reproduced with the exact outcomes described
    (push+deny+no-execution; push-with-no-PermCard for local turns; push-after-FL5.2 for
    headless); the product decision on local-turn web-answerability is written down (in this
    doc or a linked note) with a yes/no and rationale, not left implicit; `docs/user-flows.md`
    Flow 5's status line is updated to match verified reality.

### Phase 1 — Flow 3 spawn: fresh-folder registration + dedup

- [x] **FL3.1 `[bundle]` "spawn-fresh-folder-register"** (Piece A — spans
      `packages/wire/src/rpc.ts`, `packages/cli/src/daemon/spawnEngine.ts`, a new
      `workspace.register` machine RPC in `packages/cli/src/daemon/machineRpc.ts` +
      `packages/cli/src/workspace/registry.ts` reuse, and
      `packages/web/src/features/new-session/{spawn-flow,live-actions,types}.ts`; bundled
      because the wire change and both consumers must land together)
  - [x] Widen `SpawnResultSchema.requiresApproval.action` to the **multi-value literal**
        `z.literal(["create-directory", "register-workspace"])` (`rpc.ts:62-71`) — **not**
        `z.enum(...)`, which fails `additiveOnly.test.ts` (`schemaShape.ts`'s `isCompatible`
        treats literal→enum as a breaking kind change). Confirm `additiveOnly.test.ts` still
        passes with the multi-value literal.
  - [x] In `spawnEngine.ts:106-116`, map `unknown-workspace` to
        `requiresApproval: { action: "register-workspace", directory }` instead of throwing;
        leave `outside-workspace-root`/`not-absolute`/`not-directory` throwing.
  - [x] Add a `workspace.register` machine RPC (or a `registerWorkspace` action) backed by the
        already-idempotent `registerWorkspace(directory)` (`registry.ts:211-239`); register it
        in `machineRpc.ts` alongside the existing handlers.
  - [x] Extend `NewSessionActions` + `machineRpcToActions` (`live-actions.ts`) with
        `registerWorkspace`, and `runSpawnFlow` (`spawn-flow.ts`) with a `register-workspace`
        branch mirroring the existing create-directory approval loop (prompt → register →
        retry same request/`idempotencyKey`).
  - [x] Tests: `spawnEngine` (unregistered → `register-workspace`, not throw; register+retry →
        launch); `rpc.test.ts` (new action variant + compat lint); `spawn-flow.test.ts`
        (approve → register → retry → success; decline → `declined`).
  - [x] Combined: scoped tests + `pnpm typecheck` + commit.
  - **Definition of Done:** `additiveOnly.test.ts` passes with `action` as the multi-value
    literal (proving the wire change is genuinely backward-compatible, not just asserted so);
    a `spawnEngine` test proves an unregistered `workspaceId` now returns
    `requiresApproval: { action: "register-workspace", directory }` instead of throwing, and a
    second test proves register-then-retry successfully launches; a `spawn-flow.test.ts` case
    covers the full approve→register→retry→success path AND the decline→`declined` path; a
    live-equivalent daemon test (not just unit-level) confirms `workspace.register` actually
    calls the real idempotent `registerWorkspace` (no mocked-away side effect); `pnpm build &&
    pnpm typecheck && pnpm test && pnpm lint` all clean in the worktree; commit lands.
- [x] **FL3.2 `[bundle]` "spawn-directory-dedup"** (Piece B —
      `packages/cli/src/daemon/{types.ts,sessionRegistry.ts,spawnEngine.ts}` +
      `machineIntegration.ts` wiring)
  - [x] Add `directory?: string` to `TrackedSession` (`types.ts:28-38`); populate it (resolved
        real path) where the daemon records a spawned pid (`sessionRegistry.ts`
        `trackSpawned`/`onSessionStarted`, fed from `spawnEngine.ts`'s `spawnDirectory`).
  - [x] Add a `findLiveSessionInDirectory(realDirectory)` seam to `SpawnEngineDeps`
        (default: scan `registry.getSessions()` for a live `sessionId` with matching
        `directory`); consult it in `spawnSession` after validation and return the existing
        `sessionId` instead of double-spawning.
  - [x] Wire the seam through `machineIntegration.ts:295-302`'s `spawnSessionHandler` (the
        `registry` handle is already in scope).
  - [x] Optional client-side pre-check: warn/grey a directory with an existing live session in
        the wizard, using the session list's `workspaceId` (racy — daemon guard is
        authoritative).
  - [x] Tests: `spawnEngine` (a live session in the same resolved directory → returns its
        id, never launches); `sessionRegistry` (spawned pid records its directory).
  - [x] Combined: scoped tests + `pnpm typecheck` + commit.
  - **Definition of Done:** a `spawnEngine` test proves that spawning into a directory with an
    already-live tracked session returns that session's existing `sessionId` and never invokes
    the process launcher (assert the launcher mock's call count is 0, not just that a
    `sessionId` came back — a false pass here would hide a real double-spawn); a
    `sessionRegistry` test proves a spawned pid's `directory` is recorded and queryable; this
    unit does not regress FL3.1 (a fresh, never-before-seen directory must still hit the
    register-workspace path, not the dedup path — add a test for that boundary too); `pnpm
    build && pnpm typecheck && pnpm test && pnpm lint` all clean; commit lands.
- [ ] **FL3.3 `[human]` "flow-3-live-verify"**
  - [ ] From a second machine's browser, run the wizard against a real daemon, pick a folder
        never `falcon workspace register`'d → register-approval prompt → approve → live
        `falcon claude --starting-mode remote` starts and mirrors to web.
  - [ ] Submit the wizard again for the same folder → no duplicate process spawned.
  - **Definition of Done:** both live scenarios reproduced exactly as described from a real
    second machine's browser against a real daemon (not a mocked/local dev shortcut); if
    either fails, this unit is NOT done regardless of FL3.1/FL3.2's automated tests passing —
    file the gap as a new issue rather than silently re-scoping FL3.1/FL3.2.

### Phase 2 — Flow 4 teammate sharing (design-gated)

- [ ] **FL4.1 `[human]` "session-sharing-design-review"** — the real first deliverable; **no
      implementation code until this lands.**
  - [ ] Write a design doc: threat/trust model, `session_shares` schema (roles? per-session
        vs per-workspace?), authorization-helper mechanism, socket-room fan-out approach,
        invite/handshake flow (how the owner learns a grantee's `contentPubKey`), and
        revocation semantics (including the honest "a delivered key can't be un-taught"
        property).
  - [ ] Explicitly reconcile with the existing single-`accountId` model and the device-pairing
        (`pairRequests`) primitive — state clearly what is reused vs. net-new.
  - [ ] **(Added by review correction) Explicitly design the RPC-routing side, not just the
        HTTP-route side.** `socket/rpcHandler.ts`'s `rpcRoom(accountId, target)`
        (`rpcHandler.ts:93-94,230`) routes `message`/`perm.answer`/interrupt/`setMode` by the
        *caller's* accountId — a grantee's calls would resolve to the wrong (empty) room under
        the current mechanism. Decide how a grantee's RPC call reaches the owner's registered
        target (see root-cause point 7) before FL4.3/FL4.4 scope is finalized.
  - **Definition of Done:** a written design doc exists at a stable path (recommend
    `docs/design-session-sharing.md`) covering, at minimum: threat/trust model; the
    `session_shares` (or equivalent) schema with roles settled (not left as an open question);
    the authorization-helper mechanism; the RPC-routing fix for `rpcHandler.ts`'s
    account-keyed rooms (root-cause point 7 — this must be resolved on paper, not deferred to
    FL4.3/FL4.4 to improvise); the socket/event fan-out approach; the invite/handshake flow;
    and revocation semantics including the explicit "a delivered key can't be un-taught"
    property. This box is checked **only** once that doc exists AND has been reviewed/approved
    by the user — a doc merely drafted is not sufficient, since FL4.3/FL4.4 are blocked on
    *approved* scope, not draft scope. Do not check this box as part of an automated pipeline;
    it requires an explicit human sign-off.
- [x] **FL4.2 `[inline]` "sharing-crypto-roundtrip-test"** — the one code-grounded unit that
      can proceed today (independent of the design review; validates the reused primitive).
  - [x] In `packages/crypto/src/__tests__/`, prove `wrapDek(sessionDek, teammate.content.publicKey)`
        → `unwrapDek(…, teammate.content.secretKey)` recovers the DEK while unwrap with the
        owner's content secret key returns `null` (two independent `deriveKeyTree`s).
  - [x] Scoped tests + `pnpm typecheck` + commit.
  - **Definition of Done:** the round-trip test proves BOTH directions in one test file —
    `unwrapDek(wrapDek(dek, teammate.content.publicKey), teammate.content.secretKey)` recovers
    the original `dek`, AND the same wrapped value fails (`unwrapDek` returns `null`) when
    unwrapped with the *owner's* content secret key — using two genuinely independent
    `deriveKeyTree` outputs, not two views of the same key; `pnpm test && pnpm typecheck`
    clean; commit lands. This unit's scope is fixed regardless of FL4.1's outcome — it only
    validates a primitive that already exists.
- [ ] **FL4.3 `[solo]` "session-shares-schema-and-authz"** — **BLOCKED on FL4.1.** Net-new
      migration (`session_shares`), `assertSessionAccess` helper, exhaustive replacement of
      every `eq(sessions.accountId, accountId)` check (audit list in root-cause point 5),
      grant/revoke routes, and DEK re-wrap on grant. Scope/shape per the FL4.1 design; do not
      start against the speculative shapes in this doc.
  - **Definition of Done:** every scoping decision traces to FL4.1's *approved* design doc,
    not to this plan's speculative placeholder shapes; the migration applies cleanly; every
    `eq(sessions.accountId, accountId)` call site listed in root-cause point 5 (and any others
    an implementer's own audit turns up — the count is a floor, not a ceiling) now routes
    through `assertSessionAccess` or its equivalent; tests cover owner access, valid-grantee
    access, revoked-grantee rejection, and a completely unrelated third account's rejection;
    DEK re-wrap on grant is exercised by a real crypto round-trip test, not mocked; `pnpm build
    && pnpm typecheck && pnpm test && pnpm lint` all clean; commit lands. Do not begin this
    unit while FL4.1 is unchecked.
- [ ] **FL4.4 `[solo]` "session-shares-socket-and-web"** — **BLOCKED on FL4.3.** Cross-account
      room fan-out in `eventRouter`, **the RPC-routing fix for `rpcHandler.ts`'s account-keyed
      rooms (root-cause point 7 — without this, a grantee's `perm.answer`/`message`/interrupt
      calls silently resolve to nothing)**, the invite/redeem UX, and the grantee-side web
      session view/approve surface. Scope per FL4.1.
  - **Definition of Done:** a grantee, signed into their *own* separate account/device, sees a
    shared session's live updates in their browser and (if FL4.1's design scopes it in) can
    submit `perm.answer`/`message`/interrupt for it — verified with a real second account, not
    a single-account simulation, since the whole point is cross-account routing; the
    `rpcHandler.ts` fix specifically is proven by a test where a grantee's RPC call resolves to
    the owner's registered target; the invite/redeem UX is reachable end-to-end from the web
    UI, not just a server-side capability; `pnpm build && pnpm typecheck && pnpm test && pnpm
    lint` all clean; a `[human]` live check with two real accounts/browsers confirms it before
    this is considered done; commit lands. Do not begin this unit while FL4.3 is unchecked.

### Phase 3 — landing `[human]`

- [ ] **FL-LAND.1** Final gate: `pnpm build && pnpm typecheck && pnpm test && pnpm lint` clean
      on the `v2-pty-injection` tip; confirm every merged `FL` unit is a proven ancestor
      (`git merge-base --is-ancestor <tip> v2-pty-injection`). Flow 4 units (FL4.3/FL4.4)
      remain unchecked and out of the automated loop until FL4.1's design review authorizes
      them.
  - **Definition of Done:** the four repo-wide gates all pass on the real `v2-pty-injection`
    tip (not a worktree); every unit checked `[x]` in this file has a corresponding merge
    commit that `git merge-base --is-ancestor` proves is actually on that tip — a checked box
    with no provable ancestor is a false landing and must be unchecked, not left as-is; the
    Flow 4 gate (FL4.3/FL4.4 unchecked unless FL4.1 is both checked AND was a genuine
    human-approved design doc) is verified, not assumed.

### Progress bookkeeping

A forked workflow run against this checklist should keep its own cycle log in
`docs/plan-flows-progress.md` (cycle number, units attempted/merged/parked, next recommended
units) — mirroring `docs/bug-fix-progress.md`'s role for `docs/bug-fix-plan.md`, and kept as a
separate file so a `FL` cycle's bookkeeping never collides with a `BF`/`U` cycle run against
the same `v2-pty-injection` branch.
