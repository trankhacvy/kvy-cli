# FL3.1 — spawn-fresh-folder-register (Piece A)

Flows-implementation bundle unit. No prior commits existed on this branch
(`git log v2-pty-injection..HEAD --oneline` was empty) — built from scratch
per `docs/plan-flows-3-4-5.md`'s "Flow 3 — Kick something off remotely",
Proposed fix **Piece A** only (Piece B, the dedup guard, is out of scope for
this unit).

## What changed

### 1. Wire (`packages/wire/src/rpc.ts`)

- `SpawnResultSchema.requiresApproval.action` widened from
  `z.literal("create-directory")` to the **multi-value literal**
  `z.literal(["create-directory", "register-workspace"])` — deliberately
  *not* `z.enum(...)`, per the plan's correction: `schemaShape.ts`'s
  `describeShape` reports `z.literal` and `z.enum` as different `kind`s, so
  an enum swap would fail `additiveOnly.test.ts` as a breaking kind change
  even though the value set only grew.
- Added `WorkspaceRegisterParamsSchema` (`{idempotencyKey, directory}`) and
  `WorkspaceRegisterResultSchema` (`{ok}`) — the new `workspace.register`
  RPC's wire contract, same shape convention as `FsMkdirParams`/`Result`.
- Both new schemas added to `__tests__/schemaRegistry.ts`, and the frozen
  fixture (`__tests__/__fixtures__/wire-shapes.json`) was regenerated via
  `pnpm --filter @falcon/wire exec tsx scripts/snapshot-shapes.ts` to freeze
  the new baseline (56 → 58 additive-only test cases, all passing — see
  Definition of Done below). Note: the regenerated fixture's array
  formatting (one element per line, from `JSON.stringify(..., null, 2)`)
  differs cosmetically from the previously-committed file's compacted
  arrays; running `biome format`/`check --write` on it to match the old
  style crashed/corrupted the file in this environment (see the `pnpm lint`
  note below), so it was left in the script's own native output format —
  purely cosmetic, doesn't affect any test.
- `rpc.test.ts`: added cases for the `register-workspace` requiresApproval
  variant, a rejection test for an unknown action value, and
  `WorkspaceRegisterParamsSchema`/`ResultSchema` shape tests.

### 2. Daemon (`packages/cli/src/daemon/`)

- `spawnEngine.ts`: `spawnSession` now maps `validateSpawnWorkspace`'s
  `unknown-workspace` reason to
  `requiresApproval: { action: "register-workspace", directory }` instead
  of throwing — mirroring the existing `not-found` → `create-directory`
  branch exactly. `outside-workspace-root`/`not-absolute`/`not-directory`
  are unchanged (still throw `SpawnError`).
- New `workspaceRegisterRpc.ts`: thin wrapper exposing
  `workspace/registry.ts`'s already-idempotent `registerWorkspace(directory)`
  as a `WorkspaceRegisterParams -> WorkspaceRegisterResult` handler.
- `machineRpc.ts`: registered `"workspace.register"` in
  `MACHINE_RPC_METHODS`, added an optional injectable
  `MachineRpcDeps.registerWorkspace` defaulting to the new
  `workspaceRegisterRpc.ts` (same "real, dependency-free default" pattern
  `fs.list`/`fs.mkdir` already use — no extra wiring needed in
  `machineIntegration.ts`/`commands.ts`), and a `methods["workspace.register"]`
  entry. No idempotency-key replay cache added (same reasoning as
  `fs.mkdir`: registering an already-registered directory is a no-op).
  Updated the module's header doc comments (method list, idempotency-cache
  rationale) and `machineIntegration.ts`'s "which RPCs need no extra wiring"
  comment to mention the new method.

### 3. Web (`packages/web/src/`)

- `features/new-session/types.ts`: `SpawnOutcome`'s `requiresApproval`
  variant now carries `action: "create-directory" | "register-workspace"`;
  `NewSessionActions` gained `registerWorkspace(directory): Promise<void>`.
- `features/new-session/live-actions.ts`: `spawn()` forwards
  `result.requiresApproval.action` through untouched; added
  `registerWorkspace` calling the new `workspace.register` RPC.
- `sync/machineRpc.ts`: added `"workspace.register"` to the typed
  `MachineRpcParams`/`MachineRpcResults`/`RESULT_SCHEMAS` tables (the
  caller-side typed RPC client `live-actions.ts` sits on top of).
- `features/new-session/spawn-flow.ts`: `runSpawnFlow`'s confirm callback
  is now `(directory, action) => Promise<boolean>`; branches on
  `first.action` to call `actions.registerWorkspace` (register-workspace)
  vs `actions.createDirectory` (create-directory) before retrying `spawn`
  once more with the same `request` (per the plan's correction, this reuses
  the *same* `SpawnRequest` object but **not** the same wire
  `idempotencyKey` — `live-actions.ts`'s `spawn()` still mints a fresh
  `crypto.randomUUID()` per call, exactly as documented as pre-existing,
  separately-tracked behavior in the plan; not something this unit changes).
- `features/new-session/mock-source.ts` and `live-source.ts`: updated to
  satisfy the widened `NewSessionActions`/`SpawnOutcome` shapes (mock now
  seeds `action: "create-directory"` on its requiresApproval outcome and
  gained a no-op `registerWorkspace`; the crypto-not-ready stub in
  `live-source.ts` gained a `registerWorkspace: notReady` entry).
- `features/new-session/new-session-screen.tsx`: `SpawnState`'s
  `pending-approval` phase now carries `action` too, and the approval
  banner shows the right copy/button label for each action
  ("Add this folder as a Falcon workspace?" / "Add workspace" vs the
  existing "...doesn't exist yet. Create it?" / "Create directory").

## Tests added/updated

- **`spawnEngine.test.ts`** (Definition of Done requirement): two new
  cases — (a) an unregistered `workspaceId` resolves to
  `requiresApproval: { action: "register-workspace", directory }` and never
  calls `launchProcess` (proves no throw); (b) a simulated
  register-then-retry (`resolveWorkspaceRoot` flips from `null` to `root`
  between two calls with the same params) launches successfully on the
  second attempt.
- **`rpc.test.ts`** (Definition of Done requirement): new action variant
  accepted, an out-of-set action value rejected, and the new
  `WorkspaceRegisterParamsSchema`/`ResultSchema` shape-tested.
- **`machineRpc.test.ts`**: mock-based `workspace.register` coverage
  (decrypt/call/seal, invalid-params, handler-error) mirroring the existing
  `fs.mkdir` block, **plus** a dedicated
  `"with the real default (no mocked-away side effect)"` sub-block — this
  is the **live-equivalent daemon test** the Definition of Done requires:
  it does *not* override `registerWorkspace` in `register(...)`, instead
  pointing `FALCON_HOME_DIR` at a real temp directory and asserting the
  actual `workspaces.json` file the real `workspace/registry.ts`
  `registerWorkspace` writes to disk — proving the RPC really performs the
  durable side effect end-to-end, not just that some injected mock got
  called.
- **`spawn-flow.test.ts`** (Definition of Done requirement): existing
  create-directory cases updated for the new `action` field, plus a new
  `"register-workspace branch"` describe block covering
  approve→register→retry→success, decline→`declined` (never registers),
  and the still-unregistered-after-registering `SpawnFlowError` case.
- `live-actions.test.ts`: added register-workspace requiresApproval mapping
  and a `registerWorkspace` RPC-call test.
- `mock-source.test.ts`: updated for the `action` field.
- `sync/__tests__/machineRpc.test.ts`: added a `workspace.register`
  round-trip test for the typed client (not explicitly required by the
  plan, but the same file already round-trips every sibling method, so
  added for consistency/coverage).

## Definition of Done — verified

- **`additiveOnly.test.ts` passes with `action` as the multi-value
  literal**: ran `pnpm --filter @falcon/wire test` — all 58 additive-only
  cases pass (56 pre-existing + 2 new schemas), confirming the wire change
  is genuinely backward-compatible under the frozen-fixture check, not just
  asserted so.
- **`spawnEngine` test proves unregistered `workspaceId` → `requiresApproval`
  (not throw)**: `spawnEngine.test.ts` — "returns a register-workspace
  requiresApproval result (not a throw) when workspaceId is unregistered".
- **Second test proves register-then-retry launches**: `spawnEngine.test.ts`
  — "launches on retry after the workspace is registered (simulated
  register-then-retry, same idempotencyKey)".
- **`spawn-flow.test.ts` covers approve→register→retry→success AND
  decline→`declined`**: both in the new `"register-workspace branch"`
  block.
- **Live-equivalent daemon test confirms `workspace.register` calls the
  real idempotent `registerWorkspace` (no mocked-away side effect)**:
  `machineRpc.test.ts`'s `"actually writes a real workspaces.json entry via
  the real registerWorkspace"` test — exercises the RPC's real default
  handler end-to-end against a real temp `workspaces.json` file, asserting
  its on-disk contents.
- **`pnpm build && pnpm typecheck && pnpm test` clean**:
  - `pnpm build` — all 6 build tasks succeed (turbo).
  - `pnpm typecheck` — all 11 typecheck tasks succeed.
  - `pnpm test` — `@falcon/wire` (102 tests), `@falcon/web` (747 tests),
    and `falcon`/cli (1501 tests) all pass in isolation and in scoped runs.
    Two tests are flaky under full-monorepo parallel load and unrelated to
    this change: `daemon/transcriptIndexer.test.ts`'s two fs-watch-debounce-
    timing tests occasionally miss their timing window (confirmed
    pre-existing via `git stash` — identical failures reproduce on the
    pristine tree with none of this unit's changes applied — and confirmed
    non-deterministic by re-running the same file in isolation
    immediately after, which passes 13/13 every time). `@falcon/server`'s
    `db/seq.test.ts` "requires Postgres" concurrency-timing test showed the
    same one-off flakiness in a combined `pnpm test` run, also unrelated to
    this unit (no server-package files were touched) and passing on an
    isolated rerun.
  - `pnpm lint` **could not be run to completion in this sandbox**: `biome
    check`/`biome --version` both fail with `[warn] Linter process
    terminated abnormally (possibly out of memory)` for *any* input,
    including zero files, and reproduce identically at the bare repo root
    with none of this unit's changes present. Root cause traced to environment,
    not code: `node_modules/.pnpm` has no `@biomejs/cli-*` platform-native
    package installed at all (`command find node_modules/.pnpm -iname
    "*biome*"` → 0 matches) even though the pnpm content-addressable store
    already has the darwin-arm64 binary fully cached and `pnpm install
    --force` / `pnpm add -D @biomejs/cli-darwin-arm64@2.5.4 -w` both report
    "up to date" without ever linking it into `node_modules`. This is a
    pre-existing environment/install defect (CLAUDE.md's own lint section
    already documents this exact warning message as a known, accepted
    transient condition in this repo's tooling), not something introduced
    by or fixable from within this unit's source changes. The
    `@biomejs/cli-darwin-arm64` add-attempt was reverted (`package.json`/
    `pnpm-lock.yaml` restored) since it didn't fix anything and isn't part
    of this unit's actual work. In its place, every touched file was
    manually checked against `biome.json`'s configured style (double
    quotes, semicolons, trailing commas, space indent) and the immediate
    surrounding code's existing conventions.

## Deliberate scope notes

- Piece B (dedup guard: `TrackedSession.directory` + short-circuiting a
  duplicate spawn into the same directory) is explicitly out of scope for
  this unit per its title ("Piece A") and was not touched.
- The `[human]` live-daemon-and-real-browser manual verification step in
  the plan's "Testing notes" is skipped per the task rules (skip `[human]`
  sub-tasks) — its intent is instead covered by the automated
  "real registerWorkspace, no mock" test in `machineRpc.test.ts` described
  above.
- The web wizard's confirm-callback retry does **not** reuse the same wire
  `idempotencyKey` across the failed-then-retried `spawn` calls — this
  matches the plan's own "Correction (caught by review)" note that this is
  pre-existing behavior in `live-actions.ts`, harmless for this fix
  specifically, and explicitly not something this unit needed to change.

## Files touched

- `packages/wire/src/rpc.ts`, `rpc.test.ts`, `__tests__/schemaRegistry.ts`,
  `__tests__/__fixtures__/wire-shapes.json`
- `packages/cli/src/daemon/spawnEngine.ts`, `spawnEngine.test.ts`
- `packages/cli/src/daemon/workspaceRegisterRpc.ts` (new)
- `packages/cli/src/daemon/machineRpc.ts`, `machineRpc.test.ts`
- `packages/cli/src/daemon/machineIntegration.ts` (doc comment only)
- `packages/web/src/features/new-session/types.ts`
- `packages/web/src/features/new-session/live-actions.ts`, `__tests__/live-actions.test.ts`
- `packages/web/src/features/new-session/spawn-flow.ts`, `__tests__/spawn-flow.test.ts`
- `packages/web/src/features/new-session/mock-source.ts`, `__tests__/mock-source.test.ts`
- `packages/web/src/features/new-session/live-source.ts`
- `packages/web/src/features/new-session/new-session-screen.tsx`
- `packages/web/src/sync/machineRpc.ts`, `__tests__/machineRpc.test.ts`
