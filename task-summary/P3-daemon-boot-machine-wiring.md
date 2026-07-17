# P3-daemon-boot-machine-wiring — Wire machineClient + machine RPC handlers into the daemon boot sequence

Phase 1.5/3.1/3.2/3.3 daemon-integration bullet, per the task brief: `commands.ts`'s
`runDaemonStartSync` never called `startMachineClient` (`machineClient.ts`) or
`registerMachineRpcHandlers` (`machineRpc.ts`) — both fully built and unit/integration
tested, but unreachable from a live daemon process. This closes that gap.

## What was built

### 1. `packages/cli/src/daemon/machineIntegration.ts` (new)

The glue module `commands.ts` now calls. `startMachineIntegration(deps)`:

- Reads `~/.falcon/access.key` (`auth/credentials.ts`). **No stored credentials ⇒
  returns `null`, logged at `info`** — a daemon with nobody logged in yet is normal
  (local-first posture), not an error; the caller keeps running local-only.
- Derives the account's content keypair from the masterSecret (`deriveKeyTree`), mints a
  fresh 32-byte DEK for this machine, wraps it to the content public key (`wrapDek`) —
  the same "mint DEK, wrap to content pubkey" pattern `unmanagedSessionClient.ts` already
  uses.
- Calls `startMachineClient(...)` to register/resume the machine and open `/v1/stream`.
- **Socket capture**: `startMachineClient`'s returned handle only exposes
  `identity`/`stop`, not the socket itself — `registerMachineRpcHandlers` needs the exact
  same socket instance to answer `rpc-request`s. Rather than changing `machineClient.ts`'s
  public surface for one caller, this module wraps the injected `ioFactory` to capture the
  socket `startMachineClient` creates internally.
- Binds `registerMachineRpcHandlers`'s `spawnSession`/`resumeSession`/`adoptTake`/
  `adoptMirror` callbacks to the real `spawnEngine.ts`/`resumeSession.ts`/`adoptTake.ts`/
  `transcriptMirror.ts` implementations, replacing `commands.ts`'s old literal "not
  implemented yet" stub for the *machine-RPC* spawn path. `git.status`/`git.diff`/
  `fs.list`/`fs.mkdir` needed no extra wiring — `registerMachineRpcHandlers` already ships
  real, dependency-free defaults for all four.
- `resolveWorkspaceRoot`/`resolveProviderSession`/`resolveResumeDirectory` are exposed as
  injected seams with **no real default** (`() => null` / `async () => null` /
  `() => undefined`) — per the task brief, a "registered workspaces" store is explicitly
  out of scope here (a separate, in-flight task — `P3-workspace-registration-store` was
  visible mid-flight in this worktree's turbo cache while this branch was being built).
  The wiring itself is real and reachable either way: every RPC decrypts, validates, runs
  the real handler, and seals a real response — it just honestly reports
  "unregistered workspace" until that store lands, instead of silently no-op'ing or
  faking success.
- `spawnEngineOverrides`/`resumeSessionOverrides` (`Partial<...>`) are a test-only escape
  hatch to swap in a fake process launcher — production never sets them.

### 2. `packages/cli/src/daemon/commands.ts` (modified)

- `runDaemonStartSync`: after the lock is acquired, the registry is restored, and
  `daemon.state.json` is written, calls `startMachineIntegration(...)` — this is the
  actual "wire it in" step the task asked for.
- **`spawnAwaiter` + `onSessionStarted` wiring** (the piece that was missing even for the
  already-landed `spawn`/`resumeSession` engines): a `createSpawnAwaiter()` is now
  constructed at boot, and the control server's `onSessionStarted` callback is wrapped to
  call *both* `registry.onSessionStarted(...)` (existing behavior, durability) *and*
  `spawnAwaiter.resolve({sessionId, metadata, encryption, pid})` when a `pid` is present.
  Without this, a spawned/resumed session's real `/session-started` self-report would
  never reach `spawnEngine.ts`/`resumeSession.ts`'s `awaiter.waitFor(pid)` — every `spawn`/
  `resumeSession` RPC would silently time out after 15s even with everything else wired
  correctly. This is exactly the "make sure the wiring doesn't silently no-op" risk the
  task called out.
- Graceful shutdown: `machineIntegration?.stop()` runs before `controlServer.stop()`/lock
  release (mirrors the boot order — started last, stopped first).
- `DaemonCommandDeps` gained: `machineServerUrl`, `readAuthCredentials`,
  `machineIoFactory`, `machineHeartbeatIntervalMs`, `resolveWorkspaceRoot`,
  `resolveProviderSession`, `resolveResumeDirectory`, `spawnEngineOverrides`,
  `resumeSessionOverrides` — all defaulted in `createDaemonCommandDeps` to real
  implementations (`resolveBackendUrl()`, `auth/credentials.ts`'s real reader, real
  `socket.io-client`) so production callers (`index.ts`) need zero changes; every existing
  test that doesn't touch these fields is unaffected (no stored credentials in a fresh tmp
  homeDir ⇒ `startMachineIntegration` short-circuits to `null` before any network I/O).
- The pre-existing HTTP loopback `/spawn-session` stub is left untouched, per
  `P3-3.1-daemon-spawn-rpc`'s own documented scope boundary (disjoint feature, different
  body shape/contract) — only the doc comment now explains why.

### 3. `packages/cli/src/daemon/commands.machineWiring.integration.test.ts` (new)

Boots a real `runDaemonStartSync` against a **real `@falcon/server`** (real Fastify app,
real in-memory Postgres via PGlite, real `/v1/machines` route, real Socket.IO +
`rpcHandler.ts` room-based routing) — same "real server, not a mock" posture as the
already-landed `session/bootstrap.integration.test.ts`. No real provider CLI is ever
spawned: `spawnEngineOverrides`/`resumeSessionOverrides` swap in a fake process launcher
that mints a pid and, shortly after, self-reports via the *real* `notify.ts` client
hitting the daemon's own *real* control server `/session-started` endpoint — exactly what
a real `falcon claude --starting-mode remote` process would do, which in turn exercises
the real `spawnAwaiter`/`onSessionStarted` wiring above, not just the RPC pipeline in
isolation.

Flow: writes real credentials (`auth/credentials.ts`) with a fresh masterSecret, boots the
daemon, polls for `daemon.state.json` then for the machine's DB row (proving
`POST /v1/machines` succeeded for real), recovers the daemon's actual DEK by unwrapping the
row's wrapped `dek` with the *same* masterSecret's content secret key (exactly how any
other real client, e.g. the web app, would recover it — no back-channel), connects a
second "caller" socket, and drives `git.status`, `spawn`, `resumeSession`, and `adopt.take`
via real `rpc-call` → `rpc-request` → ack round trips, asserting each one succeeds.

`packages/cli/tsconfig.json`'s `exclude` list gained this file, matching the existing
precedent for `bootstrap.integration.test.ts` (it pulls in `drizzle-orm`/
`@electric-sql/pglite` transitively via the cross-package source import, which sit outside
`rootDir` and aren't declared dependencies of `falcon` itself — `tsc --noEmit` excludes it,
vitest runs it on its own account).

## Assumptions / scope boundaries

- **No "registered workspaces" store was built here** — per the task brief. Every
  `resolveWorkspaceRoot`/`resolveProviderSession`/`resolveResumeDirectory` seam defaults to
  an honest "unregistered"/"unresolved" answer, matching the exact precedent already set by
  `spawnEngine.ts`/`workspacePath.ts`/`providerSessionResolver.ts`/`resumeSession.ts`'s own
  doc comments. `DaemonCommandDeps` exposes all three as overridable so whichever task
  builds that store only has to change `index.ts`'s call to `createDaemonCommandDeps`, not
  this wiring.
- **`machineId`/DEK now both survive daemon restarts** (fixed during code review — the
  original version of this task left two related gaps): `runDaemonStartSync`'s own
  `payload` write (pre-existing code, unrelated to this task's diff) unconditionally
  overwrote `daemon.state.json` with a `machineId`-less object *before* calling
  `startMachineIntegration`, so `startMachineClient`'s `readDaemonState`-based resume check
  (inside `machineClient.ts`) never actually saw a prior `machineId` — **every single
  boot**, not just crash-restarts, registered a brand new machine row, orphaning the
  previous one. `commands.ts` now reads the previous `daemon.state.json` first and carries
  `machineId` forward into the new payload. That, in turn, made the DEK gap live (not
  "currently inert" as originally assessed): `registerMachineRpcHandlers` seals/opens every
  machine RPC — `spawn`/`resumeSession`/`adopt.*`/`git.*`, not just the metadata/daemonState
  fields — under this same DEK, so a resumed machine that started encrypting with a
  *freshly minted* DEK would silently desync from whatever any other real client (e.g. the
  web app) unwraps from the server-stored row, breaking remote control after every restart.
  `machineIntegration.ts` now persists its wrapped DEK into `daemon.state.json` (`state.ts`'s
  new `wrappedDek` field, alongside `machineId`) and unwraps it back on later boots instead
  of minting fresh — `unwrapDek` is null-safe, so a corrupted/foreign value just falls back
  to minting fresh rather than crashing the daemon.
- **`falcon adopt`'s local/`--remote` terminal-side flow, Codex adapter provider spawning,
  and the web control surface's live wiring are all untouched** — none of that is in this
  task's scope (daemon boot sequence only).

## Verification

- `pnpm build` (root, `turbo run build`) — 5/5 packages green.
- `pnpm exec turbo run build typecheck test --force` — 15/15 tasks green (forced past the
  turbo cache), including the new integration test and the full existing `falcon` (863
  tests) and `@falcon/server` (233 tests) suites.
- `npx biome check` on every file this branch touches — clean (auto-fixed two import-order
  nits via `--write` before the final pass).
- One `transcriptIndexer.test.ts` timing-sensitive test failed once under full-suite
  parallel load, then passed both in isolation and on a full-suite re-run immediately
  after — pre-existing flakiness in a file this branch does not touch, not a regression
  (matches this repo's own documented "fs-timing-sensitive tests... run twice to confirm
  not flaky" precedent from `P3-3.3-session-adoption-indexer`'s task summary).

## Files

- `packages/cli/src/daemon/machineIntegration.ts` (new)
- `packages/cli/src/daemon/commands.ts` (modified — machine integration + spawnAwaiter
  wiring, new `DaemonCommandDeps` fields, shutdown ordering)
- `packages/cli/src/daemon/commands.machineWiring.integration.test.ts` (new)
- `packages/cli/tsconfig.json` (excludes the new integration test from `tsc --noEmit`,
  matching `bootstrap.integration.test.ts`'s precedent)
