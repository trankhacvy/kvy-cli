# AH8 — machine-status-reauth

Implements docs/auth-ux-hardening-plan.md item 8 ("Machine status: 'Offline' vs 'Needs
re-authentication'"), minimum-viable / server-inferred variant, per that section's own
scoping note: no CLI change, no schema migration.

## Prior attempt

`git log v2-pty-injection..HEAD --oneline` showed no commits and `task-summary/AH8.md` did
not exist — this unit was built from scratch in this pass, not resumed.

## What "minimum-viable" means here

The server already knows (it performed) a `device_sessions.revokedAt`. A machine whose most
recent `cli-daemon` device session is revoked needs `falcon auth login` again — the daemon
itself can't report this (it can't talk over its own dead socket), so the server infers it
from data it already has, at two points:

- **Bootstrap** (`GET /v1/sync`, `POST /v1/machines`): a batched query,
  `machineReauth.ts`'s `computeMachinesNeedReauth`/`computeMachineNeedsReauth`, attached as
  `MachineRow.needsReauth`.
- **Live** (`socket.ts`'s machine-scoped `disconnect` handler): the same query, run once per
  disconnect, attached as the `machine-presence` ephemeral's new optional `needsReauth` field
  — set only when `true`, so the wire payload is byte-identical to the pre-AH8 shape for the
  overwhelming common case (a plain connect/disconnect), which is what kept the pre-existing
  `socket.test.ts` assertions passing unchanged.

## Real drift from the plan doc (adapted, noted here as instructed)

The plan states "`clientKind`/`machineId` already exist" for `device_sessions`, which is true
of the **columns** — but tracing every `issueSession(...)` call site (`app/api/pair.ts`'s
`/pair/mint`, `routes/oauth.ts`, `routes/password.ts`) showed **none of them ever pass
`machineId`**, so in the actual current codebase every `cli-daemon` device session's
`machineId` column is always `NULL` in practice (a machine doesn't exist yet at pairing
time). The "most recent `cli-daemon` device_sessions row for a machine" query would have
matched nothing, ever, without a real fix.

**Adaptation**: `routes/machines.ts`'s `POST /v1/machines` handler (register *and* update
branches) now backfills `device_sessions.machineId = <that machine's id>` onto **the
calling request's own device session** (`request.sessionId`, gated on
`request.clientKind === "cli-daemon"`) inside the same transaction as the machine
insert/update. This is the first point a `cli-daemon` session and "its" machine are ever
linked, and is self-healing on every re-login (a fresh `falcon auth login` mints a new
device session; the next `POST /v1/machines` call — daemon startup — re-links it, and
`computeMachinesNeedReauth`'s `ORDER BY createdAt DESC` naturally prefers the newest link).

## Files

- `packages/wire/src/rows.ts` — `MachineRowSchema.needsReauth?: boolean` (additive).
- `packages/wire/src/updates.ts` — `machine-presence` ephemeral gets `needsReauth?: boolean`
  (additive). Wire additive-only compat test (`__tests__/additiveOnly.test.ts` against the
  frozen `wire-shapes.json` fixture) passes unchanged.
- `packages/server/src/app/machineReauth.ts` (new) — `computeMachinesNeedReauth` (batched,
  one query for N machines, reduced client-side to "first == most recent row per
  machineId") + `computeMachineNeedsReauth` (single-machine convenience wrapper).
- `packages/server/src/app/routes/mappers.ts` — `toMachineRow(row, needsReauth = false)`.
- `packages/server/src/app/routes/sync.ts` — bootstrap snapshot computes the map once for
  every machine in the account.
- `packages/server/src/app/routes/machines.ts` — backfill (see drift note above) + computes
  `needsReauth` for both the HTTP response and the fanned-out `machine-new`/`machine-update`
  wire `Update`.
- `packages/server/src/app/events/eventRouter.ts` — `buildMachinePresenceEphemeral` gains an
  optional third `needsReauth` param; omitted (not `false`) unless `true`.
- `packages/server/src/app/socket.ts` — machine-scoped `disconnect` handler now queries
  `computeMachineNeedsReauth` before emitting the offline ephemeral (connect-time online
  emit needs no query — `io.use`'s middleware already proved that device session isn't
  revoked before the connection was accepted).
- `packages/web/src/features/session-list/use-machine-presence.ts` — `MachinePresence`
  ({ online, needsReauth? }) replaces the bare `boolean` presence-map value;
  `deriveMachineOnline` updated to match; new `MachineStatus` union
  (`"online" | "offline" | "needs-reauth"`) + `deriveMachineStatus` (live event > bootstrap
  `MachineRow.needsReauth` > `lastSeenAt` heuristic).
- `packages/web/src/features/session-list/status.ts` — new `MACHINE_STATUS_META` (mirrors
  `SESSION_STATUS_META`'s shape) with a distinct amber "Needs re-authentication" entry.
- `packages/web/src/features/session-list/types.ts` — `SessionListMachine.status:
  MachineStatus` added **alongside** (not replacing) `online: boolean` — every existing
  consumer of `.online` (restart-eligibility checks, the per-session status dot's
  `machineOnline` input) only ever needed the boolean question, so it stays untouched to
  keep this a scoped, low-risk change.
- `packages/web/src/features/session-list/live-source.ts` /
  `packages/web/src/features/unmanaged-sessions/live-source.ts` — both `buildSnapshot`s
  compute `status` alongside `online` (the same machine can render in both screens'
  `MachineBadge`, so both must agree).
- `packages/web/src/features/session-list/components/machine-badge.tsx` — renders via
  `MACHINE_STATUS_META[machine.status]` instead of a hard-coded online/offline color.
- `packages/web/src/features/unmanaged-sessions/mock-source.ts` — fixture updated for the
  new required `status` field.

## Deviation from the plan's exact snippet

The plan's snippet has `deriveMachineStatus`'s presence param as
`Map<string, MachinePresence>` directly — implemented as specified. The one place I diverged
was keeping `SessionListMachine.online: boolean` **in addition to** the new `status` field
rather than the plan's phrasing "`SessionListMachine.online` → a `status` field" read
literally as a replacement: replacing it would have required touching
`session-card-actions.tsx`'s restart-eligibility logic and `status.ts`'s
`deriveSessionStatus`'s `machineOnline: boolean | null` input, both of which only ever need
the boolean answer and have no reauth-specific behavior of their own. Additive kept the
change scoped to what the four sub-tasks actually asked for.

## Tests

- `packages/server/src/app/socket.test.ts` — two new integration tests against a real
  Socket.IO server: (1) a revoked `cli-daemon` device session's disconnect emits
  `needsReauth: true`; (2) a clean disconnect with no revocation ("merely asleep") still
  emits the plain pre-existing shape (no `needsReauth` key at all) — the exact scenario pair
  sub-task 4 asks for.
- `packages/server/src/app/routes/machines.test.ts` — new `describe("needsReauth (AH8)")`:
  register backfills `device_sessions.machineId` and reports `needsReauth: false`; revoking
  that session then updating reports `needsReauth: true`.
- `packages/web/src/features/session-list/use-machine-presence.test.ts` — full
  `deriveMachineStatus` suite (live event vs. bootstrap field vs. heuristic, precedence
  order) plus the updated `MachinePresence`-shaped fixtures for `deriveMachineOnline`.
- `packages/web/src/features/session-list/live-source.test.ts` — two new `buildSnapshot`
  tests: bootstrap `needsReauth` surfaces distinctly from a stale-heartbeat "asleep" machine;
  a live `needsReauth:true` event wins over an absent bootstrap field.
- `packages/web/src/features/session-list/components/machine-badge.test.ts` (new) — renders
  "Needs re-authentication" (not "Offline") for `needs-reauth`, "Offline" for `offline`, and
  asserts the two use different dot colors.
- `packages/web/src/features/unmanaged-sessions/live-source.test.ts` — existing presence
  fixture updated to the new `{ online }` shape (no new failures).

## Verification

- `pnpm --filter @falcon/wire test` — 178/178 pass (additive-only compat check included).
- `pnpm --filter @falcon/server test` — 375/375 pass (full suite, including the 2 new
  socket.test.ts cases + the new machines.test.ts describe block).
- `pnpm --filter @falcon/web test` — 1190/1190 pass (full suite).
- `pnpm build` — all 6 packages build clean (turbo).
- `pnpm typecheck` — all packages clean.
- `pnpm test` (repo root) — all 11 tasks pass. One transient failure was observed on an
  earlier run (`falcon` package's `src/index.test.ts` "--help" test timing out at 5s) that
  reproduced as a pass both in isolation and on a clean re-run of the full suite — CPU
  contention from running every package's tests in parallel, not a regression from this
  change (I never touched the `cli` package). Similarly `packages/server/src/db/seq.test.ts`'s
  row-lock-contention timing test flaked once under load and passed cleanly in isolation and
  on re-run — a pre-existing timing-sensitive test, unrelated to AH8.
- `pnpm lint` / `npx biome check .` reliably crashed with "Linter process terminated
  abnormally (possibly out of memory)" in this sandboxed tool-call environment specifically
  (reproduced repeatedly, including on a bare `--version` call) — but invoking the resolved
  platform binary directly (`node_modules/.bin/biome check .`) worked reliably every time
  and confirms this unit's changes are clean: before my two own-file fixes it reported 27
  pre-existing errors (all in unrelated `packages/cli` files: `claudeRemoteLauncher.test.ts`,
  `keyMaterial.ts`, `login.test.ts`, `pin.ts`, etc. — none touched by AH8); after fixing an
  unused-import lint error in my own new `machines.test.ts` code and letting the formatter
  reflow one line in `machines.ts`, the repo-wide count dropped to 25, with every file this
  unit touched checked individually and reporting zero errors/warnings. The `pnpm lint`/
  `npx biome` crash appears to be an artifact of this harness's process wrapping around
  `pnpm`/`npx` specifically (the direct binary never crashed once), not a real regression.
