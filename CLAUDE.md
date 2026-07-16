# Falcon

pnpm + Turborepo monorepo. This file documents commands and conventions only —
for the "why", read `plan.md` (build plan + phase-by-phase TODO), `falcon-system-design.md`
(architecture/protocol design), and `falcon-prd.md` (product requirements).

## Commands

Run from repo root (Turborepo resolves per-package task graphs via `dependsOn`):

```bash
pnpm install       # installs deps; postinstall builds @falcon/wire first
pnpm build         # turbo run build     — dual CJS/ESM builds via pkgroll (web: `next build` → static out/)
pnpm typecheck     # turbo run typecheck — tsc --noEmit, depends on ^build
pnpm test          # turbo run test      — vitest run, depends on build
pnpm lint          # biome check . (auto-retries once on failure — see note below)
pnpm lint:fix       # biome check --write .
```

`pnpm lint` retries once automatically: running it immediately after `pnpm build`/`pnpm test`
can occasionally hit `[warn] Linter process terminated abnormally (possibly out of memory)`
from transient resource contention (biome daemon warm-up racing the tail end of `next build`/
vitest CPU usage), not a config problem — `.next`/`out` are already excluded in `biome.json`.
The retry absorbs that transient failure; a lint run that fails twice in a row is a real issue.

Scope to one package with `--filter`, e.g. `pnpm --filter @falcon/wire build`.

CI (`.github/workflows/ci.yml`) runs, in order: install (frozen lockfile) → lint →
build `@falcon/wire` → typecheck → test.

## Package layout

```
packages/
├─ wire/      @falcon/wire    zod schemas — the shared wire protocol contract.
│                             Built first (everything else depends on it).
├─ crypto/    @falcon/crypto  E2E encryption primitives, isomorphic (node + browser builds).
├─ cli/       falcon          CLI skeleton: hand-rolled arg parsing (`falcon` / `falcon claude
│                             [args...]` / `falcon codex [args...]` with full flag passthrough),
│                             file-only logger (`~/.falcon/logs/`, never stdout/stderr).
│                             `src/daemon/`: singleton lock (atomic hard-link + stale-PID
│                             detection), `daemon.state.json` read/write helpers, a Fastify
│                             control server (`/session-started`, `/list`, `/stop-session`,
│                             `/spawn-session`, `/stop`), process-scan-based `falcon kill
│                             daemon/sessions/all/all-force`, `falcon daemon
│                             start/start-sync/stop/status`, `ensureDaemonRunning()`
│                             (auto-start wiring called from `start`/`auth`/`sessions`/`resume`,
│                             respects `FALCON_NO_SERVICE=1`), and the machine-scoped WS client
│                             (`daemon/machineClient.ts`: `registerOrResumeMachine`/CAS-retry
│                             sync against `POST /v1/machines`, `startMachineClient` opening
│                             `/v1/stream` as `clientType: "machine-scoped"` with a 60s
│                             heartbeat), and the adoption Tier-1 transcript indexer
│                             (`daemon/transcriptIndexer.ts`: fs-watches every registered
│                             workspace's Claude Code project transcript dir — reusing
│                             `claude/scanner.ts`'s `getProjectPath` — debounced 2s per
│                             session file, parses title/last-activity, derives a
│                             best-effort "running?" liveness signal from
│                             `processScan.ts`'s new `resolveProcessCwd` + `markers.ts`'s
│                             Falcon-process classifier, and upserts via
│                             `daemon/unmanagedSessionClient.ts` against the server's new
│                             `POST /v1/unmanaged-sessions`, design §8/§11 UC9 Tier 1;
│                             `listWorkspaces`/`isManaged` are injectable seams with no
│                             real default yet — workspace registration and managed-session
│                             lineage are separate, later tasks). Tier 2/3 of adoption (design
│                             §7.8/§8/§10.4, plan.md §16 "3.3 Session adoption (UC9)") are also
│                             landed: `daemon/adoptTake.ts` (`handleAdoptTake` — the `adopt.take`
│                             machine RPC's core: `mode:'takeover'` finds the live owning
│                             `claude` pid via `adopt/liveness.ts`, SIGTERM≤5s→SIGKILL it, then
│                             spawns a continuation via an injected `spawnSession`;
│                             `mode:'fork'` skips the kill; a mid-turn `warning` is returned
│                             when takeover interrupted a still-running process) and
│                             `daemon/transcriptMirror.ts` (`handleAdoptMirror` — the
│                             `adopt.mirror` machine RPC's core: reads an unmanaged session's
│                             transcript in ≤64KB, line-boundary-safe chunks via a byte cursor;
│                             a `blobRef` field is reserved on the wire schema for a future
│                             blob-storage fallback, unset until that subsystem lands). Both
│                             RPCs are registered in `daemon/machineRpc.ts` alongside `spawn`
│                             (generalized from a single-method dispatcher to a per-method
│                             switch, each wrapped in its own idempotency-key replay cache).
│                             `daemon/providerSessionResolver.ts` defines the shared
│                             `resolveProviderSession` seam both handlers depend on (provider
│                             session id → registered workspace; no real default yet, same
│                             "workspace registration is separate work" caveat as above). The
│                             terminal-side half —
│                             `falcon adopt [--remote] [--list]` + `falcon --continue` alias
│                             (`commands/adopt.ts`, wired into `args.ts`/`index.ts`) — lists
│                             plain sessions for cwd's workspace (`adopt/listSessions.ts`,
│                             reusing `transcriptIndexer.ts`'s `parseTranscript`), preselects
│                             the most recent, and continues it: locally via `claude --resume
│                             <id>` (inherited stdio, blocking) with a before/after directory
│                             snapshot to detect the new provider session id `--resume` mints
│                             and record the old→new lineage (`adopt/lineage.ts`, persisted in
│                             `settings.json`'s new `adoptedSessions` map); or, with `--remote`,
│                             a detached tmux-preferred launch of `falcon claude
│                             --starting-mode remote --continue-from <id>` (lineage recording
│                             for that path is deferred — no hook wired to an ad hoc detached
│                             start yet — and prints an explicit note rather than silently
│                             skipping it). `src/persistence.ts`:
│                             `~/.falcon/` local state — schema-versioned `settings.json`
│                             (atomic lock-file-guarded read-modify-write) and
│                             0600-permissioned `access.key` credentials, both tmp-write +
│                             rename so readers never observe a partial write. `src/codex/`:
│                             the Codex provider adapter (design §7.7, plan.md §16 "3.4 Codex
│                             adapter") — `codexAppServerClient.ts`, a hand-rolled
│                             newline-delimited JSON-RPC 2.0 stdio client for `codex
│                             app-server` (initialize handshake, `thread/start`/
│                             `thread/resume`, `turn/start`/`turn/interrupt`, and
│                             server->client `exec`/`patch` approval routing for both legacy
│                             and v2 method names); `permissionHandler.ts`, a Codex-specific
│                             parallel to `claude/permissionHandler.ts` (own pending-approval
│                             map, first-wins `resolve()`, and a
│                             `bypassPermissions`/`acceptEdits`-only auto-rule mapping — Codex
│                             has no equivalent to Claude's other two SDK modes);
│                             `envelopeMapper.ts` (`mapCodexEventToEnvelopes`), translating
│                             Codex's `codex/event` notifications (turn lifecycle, agent
│                             messages/reasoning, exec/patch tool calls, `turn_diff`) into
│                             `SessionEnvelope`s; `codexProviderAdapter.ts` (`detect()` +
│                             `startLocal()` — always `null`, since Codex has no local TUI
│                             mode, with an honest CLI note printed by `falcon codex`); and
│                             `codexRemote.ts`, wiring all of the above into one session
│                             handle (mirrors `remote/claudeRemote.ts`). RPC handler
│                             registration and provider spawning (both Claude and Codex) are
│                             still [planned] — this task, like the Claude adapter's own
│                             pieces before it, lands the adapter modules themselves ahead of
│                             the `falcon claude`/`falcon codex` orchestration that spawns and
│                             drives them.
├─ server/    @falcon/server  Fastify 5 app skeleton (zod type-provider, /health, pino
│                             logging) + Drizzle ORM schema (`src/db/schema.ts`) and
│                             migrations (`drizzle/`), migration-on-boot runner + auth
│                             module (src/auth/: JWT HS256 mint/verify, in-memory token
│                             cache, app.authenticate preHandler) + `POST /v1/auth`
│                             challenge/response route, `POST /v1/auth/register` OAuth
│                             (Google/GitHub) sign-in, and `/v1/auth/pair*` device-pairing
│                             routes + Socket.IO on `/v1/stream` (src/app/socket.ts,
│                             src/app/socket/rpcHandler.ts) fanning out through
│                             `src/app/events/eventRouter.ts` (room-scoped emitUpdate/
│                             emitEphemeral, presence ephemerals, backpressure coalescing)
│                             + the HTTP write path (src/app/routes/: POST /v1/sessions,
│                             POST/GET .../messages, PUT .../metadata|state CAS, GET
│                             /v1/sync, GET /v1/sessions, POST /v1/machines — all
│                             idempotent/rate-limited, design §4.3 DELTA D1) fanning out
│                             through that same `eventRouter` post-commit, and lifecycle
│                             push dispatch (src/app/push/: `dispatch.ts`'s
│                             `buildPushDispatcher` — presence-suppressed via
│                             `eventRouter.hasActiveVisibleClient`, fans out to a
│                             pluggable `channels/` registry — `webpush` fully wired via
│                             `web-push` + VAPID config, `telegram`/`ntfy` stubbed for a
│                             later task; wired into `POST /v1/sessions/:id/status`'s
│                             `failed` transition and the new `POST
│                             /v1/sessions/:id/notify {kind: perm|question|done}`) +
│                             `POST`/`DELETE /v1/push/subscribe` (src/app/routes/push.ts) +
│                             `POST /v1/unmanaged-sessions` (src/app/routes/
│                             unmanagedSessions.ts — adoption Tier 1, design §8/§11 UC9):
│                             upsert-by-`(machineId, providerRef)` for the daemon transcript
│                             indexer, fanning out `unmanaged-new`/`unmanaged-update`
│                             through the same `eventRouter`.
└─ web/       @falcon/web     Next.js PWA (App Router, static export). Tailwind + shadcn/ui
                              wired up, dark default theme. Auth pages (OAuth sign-in, key
                              generation, recovery-code export, pairing-approve —
                              src/app/signin, src/app/auth, src/app/pair,
                              src/app/settings/recovery) are landed. Crypto worker bridge
                              (src/crypto/), the transcript reducer (src/sync/reducer/) —
                              folds `SessionEnvelope[]` into ordered `RenderItem[]` (design
                              §9.1) — apiSocket, the user-scoped Socket.IO client with
                              infinite reconnect + app-state reporting, and
                              `src/sync/engine.ts`, the sync engine (design §8.1/§9.1, DELTA
                              D2: headerSeq structural fast-path + per-session msgSeq
                              message fast-path against a TanStack Query cache, gap ⇒
                              `invalidateQueries`, WS reconnect ⇒ invalidate everything), are
                              all wired up (src/sync/). The engine takes an injectable
                              `SyncSocketSource` (`on('update'|'reconnect', ...)`), which the
                              real `apiSocket` satisfies structurally — no adapter needed.
                              `src/features/session-list/`: the Home screen (design §9.2
                              "Home" row, FR-7.1) — sessions grouped by workspace, a derived
                              status dot per session (`status.ts`'s `deriveSessionStatus`,
                              computed from each session's `RenderItem[]` plus live
                              presence/attention signals, never stored — design principle
                              #3) and machine online/offline badges. Takes an injectable
                              `UseSessionListSnapshot` hook (defaults to a static mock
                              snapshot, `mock-source.ts`) so it composes with the real
                              sync-engine-backed hook once the two are wired together, same
                              seam as the sync engine's `SyncSocketSource`. A read-only
                              session timeline screen (`/session/[id]`,
                              `src/components/timeline/`) is also landed: a virtualized
                              `Timeline` that renders the reducer's `RenderItem[]` as a
                              structured chat transcript — markdown via a
                              unified/remark/shiki pipeline compiled straight to React
                              elements (`rehype-react`, `src/lib/markdown.ts` — no
                              `dangerouslySetInnerHTML` anywhere), collapsible thinking
                              blocks, a `ToolCard` registry (Bash, Edit/Write/MultiEdit+diff,
                              Read, Grep/Glob, TodoWrite checklist, Task/subagent nesting,
                              MCP generic fallback), and read-only permission/service/file
                              markers. It runs off a hand-built demo fixture
                              (`src/components/timeline/demo-items.ts`) pending the sync
                              engine wiring. Web Push (src/push/: `subscribe.ts`'s
                              `subscribeToPush`/`unsubscribeFromPush` against an injectable
                              `PushEnvironment`/`PushApiPort`, same testable-seam pattern
                              as `apiSocket.ts`; `public/sw.js`, a plain static service
                              worker — `push` shows a generic kind-keyed notification,
                              `notificationclick` deep-links to `/session/<id>/`) is wired
                              up behind `src/app/settings/notifications/`, a minimal
                              enable/disable toggle. The Phase 2 web control surface
                              (`src/features/session-control/`) is also landed: `Composer`
                              (TanStack `useMutation` → the `message` session RPC, optimistic
                              insert reconciled by echo), `PermCard` (Allow/Deny/
                              Allow-for-session/mode-switch + edit-preview diff,
                              "answered on another device" first-wins-loser state),
                              `ControlBar` (interrupt, permission-mode selector, take-control),
                              derived attention (perm∨question∨done-unseen vs per-device
                              last-seen) driving tab-title/favicon badges, and
                              `sync/sessionRpc.ts`, the typed caller-side client for the five
                              session RPC methods over `apiSocket`'s new `rpcCall()`. All of it
                              still runs off the timeline's existing demo fixture via an
                              injectable `SessionControlActions`/`UseSessionControl` seam
                              (mirrors `features/session-list`'s own mock-source pattern) —
                              wiring the sync engine into the Home screen and timeline (gap
                              detection, TanStack Query invalidation, FR-7.2 live session
                              timeline) plus the real per-session crypto client, and
                              auth-gating the Home route, are still [planned].
```

Each package builds with `pkgroll` to dual CJS/ESM + `.d.ts`, and exposes
`build` / `typecheck` / `test` scripts consumed by the root turbo pipeline.

## Database (`packages/server`)

Drizzle ORM + Postgres. Schema lives in `packages/server/src/db/schema.ts`; every
encrypted column uses the shared `bytea` custom type (raw ciphertext bytes, never
decrypted server-side — design §5.3/§6.1). `DATABASE_URL` config env var, defaults to
`postgres://falcon:falcon@localhost:5432/falcon` for local dev.

```bash
pnpm --filter @falcon/server db:generate   # drizzle-kit generate — diff schema.ts, emit drizzle/*.sql
pnpm --filter @falcon/server db:migrate    # apply pending migrations once, standalone
```

Migrations also run automatically on server boot (`src/db/migrate.ts`, called from
`main.ts` before `app.listen` — design §6.5: "migrate runs on boot"). Idempotent: safe
to run against an already-current database.

## Conventions

- **pnpm workspaces** — `pnpm-workspace.yaml` globs `packages/*`. Add new packages there;
  no other wiring needed for pnpm to pick them up.
- **Strict TypeScript** — every package extends root `tsconfig.base.json` (strict mode,
  `noUncheckedIndexedAccess`, `noImplicitReturns`, etc.). Don't loosen these per-package.
- **`@/` path alias** — each package's own `tsconfig.json` maps `@/*` to `./src/*`. Import
  within a package via `@/...`; import across packages via the published package name
  (e.g. `@falcon/wire`).
- **Biome** — single formatter + linter at the root (`biome.json`), not per-package. Run
  `pnpm lint` / `pnpm lint:fix` before committing.
- **`@falcon/wire` builds first** — it has no workspace dependencies and everything else
  depends on its compiled output; this is why CI and `postinstall` (`scripts/postinstall.cjs`,
  skippable via `SKIP_FALCON_WIRE_BUILD=1`) build it explicitly ahead of the general build.

## Docs

- `plan.md` — the build plan and the authoritative phase/task checklist (§16).
- `falcon-system-design.md` — architecture, protocol, and encryption design.
- `falcon-prd.md` — product requirements.
- `docs/protocol.md`, `docs/encryption.md` — short stubs pointing into the design doc.

Update this file as each phase lands new packages (e.g. once `cli`/`server`/`web` exist,
move them out of "planned" above and add any new root-level commands they introduce).
