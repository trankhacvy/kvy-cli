# P1-land-1.1-1.2-server-realtime-and-write-path

Lands `P1-1.1-server-realtime` (Socket.IO `/v1/stream` read path) and
`P1-1.2-server-write-http` (HTTP write path) onto this integration branch,
reconciling the two independently-built `eventRouter` seams into one.

## What was merged

Both branches shared merge-base `dcc787e5` (pre-auth-routes). At the time
this task started, `main` already had task 0.4's auth/OAuth/pairing routes
landed (`P0-land-0.4-auth-routes`), which neither 1.1 nor 1.2 had — so this
was a 3-way integration, not a straight fast-forward of either branch.

- `git merge P1-1.1-server-realtime` — brought in `app/events/eventRouter.ts`
  (Socket.IO rooms, recipient filters, presence, ephemeral backpressure
  coalescing), `app/socket.ts` (handshake auth, three client scopes, machine
  online/offline ephemerals), `app/socket/rpcHandler.ts` (RPC transport,
  presence-poll dead-peer detection). Conflicts: `package.json` (dependency
  union — `socket.io`, `socket.io-client`, `prom-client` alongside main's
  `@falcon/crypto`/`@fastify/rate-limit`), `server.ts` (main's auth routes
  wiring + 1.1's `startSocket(app)` call), `pnpm-lock.yaml` (regenerated via
  `pnpm install` after resolving `package.json`).
- `git merge P1-1.2-server-write-http` — brought in `app/routes/{sessions,
  messages,sessionCas,machines,sync,mappers,shared,testHelpers}.ts` (+tests),
  `db/{box,errors,types}.ts`. Conflicts: `CLAUDE.md`, `server.ts`,
  `pnpm-lock.yaml`.

## eventRouter reconciliation

The two branches built independent `eventRouter` seams from the same base:

- **1.1's** (`app/events/eventRouter.ts`): a real Socket.IO-backed router —
  room scheme (`user:`, `:user-scoped`, `:session:`, `:machine:`),
  `emitUpdate`/`emitEphemeral` with recipient filters, presence queries,
  ephemeral backpressure coalescing. This is the actual read-path transport.
- **1.2's** (`app/eventRouter.ts`, deleted in this task): an in-process
  `EventEmitter`-based stand-in, explicitly documented in its own source as a
  placeholder — *"Until Socket.IO lands, this IS the fan-out ... this
  module's job is done"* once 1.1 landed.

Resolution: kept 1.1's Socket.IO-backed `eventRouter` as the single
implementation and deleted 1.2's stand-in. Added one new export to
`app/events/eventRouter.ts`:

```ts
export interface EventRouterPort {
  emitUpdate(params: EmitUpdateParams): void;
  emitEphemeral(params: EmitEphemeralParams): void;
}
```

This is the narrow surface the HTTP write routes actually need (not the
full `EventRouter` class, which also owns connection/room bookkeeping only
`socket.ts` touches). The real `eventRouter` singleton already satisfies it
structurally — no changes to the class itself.

Updated the four HTTP route factories (`sessions.ts`, `messages.ts`,
`sessionCas.ts`, `machines.ts`) to:
- import `EventRouterPort` from `./events/eventRouter.js` instead of the
  deleted `./eventRouter.js`
- call `emitUpdate({ accountId, payload, recipientFilter })` — 1.1's actual
  parameter shape — instead of 1.2's `{ recipientFilter: {..., accountId},
  update }`
- map 1.2's filter names onto 1.1's real ones: `"all-user"` → omit
  `recipientFilter` (1.1 defaults to `"all-user-authenticated-connections"`),
  `"session-interested"` → `"all-interested-in-session"`, `"machine-only"` →
  `"machine-scoped-only"` (semantics already matched 1:1 — both variants
  additionally include the user-scoped room, which is what a web dashboard
  listening on the account "user-scoped" connection needs to hear
  machine/session-specific broadcasts too).

`server.ts`'s `buildServer()` now takes `db`, `oauthVerifier`, and
`eventRouter` as injectable deps (merging both branches' dependency-injection
patterns) and wires: health → auth/OAuth/pairing routes (0.4) → sessions/
messages/sessionCas/sync/machines routes (1.2), all sharing one `eventRouter`
→ `startSocket(app)` (1.1), which binds the same process-wide `eventRouter`
singleton to the live Socket.IO server via `eventRouter.init(io)`. In
production this means an HTTP write's post-commit `emitUpdate` reaches
Socket.IO rooms through the one shared router; in tests, injecting a fake
`EventRouterPort` isolates route assertions from any real socket.

Added `RecordingEventRouter` to `app/routes/testHelpers.ts` — a small
`EventEmitter`-backed test double implementing `EventRouterPort` with
`onUpdate`/`onEphemeral` subscription (mirrors 1.2's old `InMemoryEventRouter`
test-ergonomics) so the four route test files needed only mechanical edits:
`InMemoryEventRouter` → `RecordingEventRouter`, `UpdateEvent` →
`EmitUpdateParams`, `.update.body` → `.payload.body`, filter-name updates.

## Other fixes required to build clean

- `auth.test.ts`/`oauth.test.ts` (pre-existing 0.4 tests) built their own
  in-memory Postgres with a **partial** schema (`{ accounts }` only).
  `buildServer`'s `deps.db` is now typed as the strict `Database` type from
  `db/types.ts` (`PgDatabase<any, typeof schema>`, pinned to the *full*
  schema — needed so the new route factories get properly-typed
  `db.query.sessions`/`.machines`/etc.), which a partial-schema instance no
  longer satisfies. Fixed by switching both test files to import the full
  `* as schema from "../../db/schema.js"` (the same pattern
  `routes/testHelpers.ts`'s `createTestDb()` already used) instead of the
  ad-hoc `{ accounts }` object literal.
- Regenerated `pnpm-lock.yaml` via `pnpm install` after resolving the
  `package.json` dependency-union conflicts (rather than hand-merging the
  lockfile's conflict markers).
- `pnpm lint` (biome) auto-fixed formatting/import-order across the merged
  route files — pre-existing `noExplicitAny`/`noNonNullAssertion` warnings
  in `rpcHandler.ts` (from 1.1) and `db/types.ts` (from 1.2) are carried
  over from the source branches unchanged and are consistent with existing
  patterns elsewhere in the codebase (e.g. `auth.ts`/`oauth.ts`'s own
  `PgDatabase<any, any>`).

## Verification

- `pnpm build` — green (all 5 packages).
- `pnpm typecheck` — green (all 7 typecheck targets).
- `pnpm test` — green: 9/9 turbo tasks, including `@falcon/server`'s full
  suite — **20 test files, 139 tests**, covering: existing 0.4 auth/OAuth/
  pairing routes, 1.1's `eventRouter`/`socket`/`rpcHandler` (including the
  presence-poll dead-peer detection test), and 1.2's sessions/messages/
  sessionCas/sync/machines routes (including the "POST same localId twice →
  one row, one fan-out event" idempotency test, now asserting through the
  real `eventRouter`'s parameter shape via `RecordingEventRouter`).
- `pnpm lint` — green on `packages/server` after `biome check --write`
  (root-level `pnpm lint` still reports pre-existing `packages/crypto`
  `noExplicitAny`/`noNonNullAssertion` findings, confirmed present on `main`
  before this task and out of scope here).

## Assumptions

- Kept `startSocket(app)`'s existing signature (no `eventRouter` parameter)
  rather than threading the injected `eventRouter` through it — it already
  binds to the shared process-wide singleton via `eventRouter.init(io)`,
  which is what `buildServer`'s `eventRouter` dependency defaults to in
  production. Tests that inject a fake `eventRouter` only care about the
  HTTP routes' fan-out calls, not Socket.IO wiring, so this keeps 1.1's own
  `socket.ts`/`socket.test.ts` untouched.
- Did not rename 1.1's `RecipientFilter` variant names (`"all-interested-in-
  session"`, `"machine-scoped-only"`, etc.) to 1.2's shorter ones — 1.1's are
  now the only implementation and already have their own passing tests
  (`eventRouter.test.ts`) that reference them; renaming would have meant
  touching that file's tests for no functional gain.
