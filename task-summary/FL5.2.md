# FL5.2 — acp-headless-attention-wiring

Unit: `docs/plan-flows-3-4-5.md` Phase 0, **FL5.2 `[solo]` "acp-headless-attention-wiring"**.

No prior attempt existed (`git log v2-pty-injection..HEAD --oneline` was empty at start) — this
is a from-scratch implementation, not a gap-fill.

## What Flow 5's ACP correction asked for

`docs/plan-flows-3-4-5.md`'s Flow 5 section (with its "Correction (caught by review)" note,
which supersedes the section's earlier overclaim) established: the terminal path's
`reportSessionAttention` (`api/sessionNotify.ts`) wiring — `perm`/`question` before the
permission block, `done` on turn completion — has no ACP/headless equivalent.
`acp/acpPermissionHandler.ts` had zero attention calls. The proposed fix: thread
`reportSessionAttention` into `acpPermissionHandler.ts`'s `session/request_permission`-blocking
point and its turn-end path, with `acpRemote.ts` as the ACP path's own composition root (it
doesn't share `start.ts`'s terminal-path dependency wiring).

## Design decision (where the literal DoD text and the terminal-path precedent both point)

The terminal path's own bridge (`pretoolPermissionBridge.ts`) does **not** call
`reportSessionAttention` itself — it only exposes a plain `onPendingAttention` callback, and
`start.ts` (the composition root) is what actually calls the real network function. The Flow
5 DoD text, however, is explicit that `acpPermissionHandler.ts` itself calls
`reportSessionAttention` (including for `"done"` "on turn completion"). Both are satisfiable at
once: `AcpPermissionHandler` owns every `reportSessionAttention` call site directly (a private
`reportAttention(kind)` helper, called from `handleRequest` for `perm`/`question`, and from a
new public `reportTurnEnd()` method for `done`), while `acpRemote.ts`'s composition root
supplies the deps (`sessionId`, `attention` backend/auth config, an injectable
`reportSessionAttention` override) when constructing `AcpPermissionHandler`, and invokes
`reportTurnEnd()` at its own turn-end path (`drain()`, right where `onTurnSettled` already
fires on a resolved `session/prompt`). This keeps every actual network call inside
`acpPermissionHandler.ts` (matching the DoD's literal wording) while `acpRemote.ts` is genuinely
the file wiring the deps and triggering the turn-end call (matching sub-task 2 and the "own
composition root" framing).

## Changes

**`packages/cli/src/acp/acpPermissionHandler.ts`**
- `AcpPermissionHandlerDeps` gained `sessionId?: string`, `attention?: ReportSessionAttentionDeps`,
  and an injectable `reportSessionAttention?: typeof reportSessionAttentionDefault` — all
  optional, so no existing/test caller of `new AcpPermissionHandler(...)` breaks; when
  `sessionId`/`attention` aren't both supplied, reporting is a silent no-op (documented as the
  same "no live caller has wired this yet" seam pattern used elsewhere in this package, e.g.
  `providerSessionResolver.ts`).
- `handleRequest()` now calls `this.reportAttention(isAskUserQuestion(toolName) ? "question" :
  "perm")` as its first action — before constructing/returning the pending `Promise` — mirroring
  the terminal path's exact placement (`pretoolPermissionBridge.ts`'s
  `handlePermissionRequest`/`handleAskUserQuestion` both report before intercepting).
  `isAskUserQuestion` is reused directly from `pretoolPermissionBridge.ts` (already exported,
  no existing import cycle risk — `pretoolPermissionBridge.ts` imports nothing from `acp/`).
- New public `reportTurnEnd(): void` method — calls `reportAttention("done")`. Intended call
  site: the ACP session's own turn-end path (see `acpRemote.ts` below).
- Private `reportAttention(kind)` is the single implementation shared by both call sites: it's
  a no-op unless `sessionId`+`attention` are both present, else calls the injected/default
  `reportSessionAttention(attention, { sessionId, kind })` (fire-and-forget, same as the
  terminal path's `start.ts`).

**`packages/cli/src/acp/acpRemote.ts`** (composition root)
- `AcpRemoteOptions` gained `sessionId?: string` and `attention?: ReportSessionAttentionDeps` —
  both optional; no currently-wired caller (`claudeRemoteLauncher.ts`, `startCodex.ts`) passes
  them yet, so this is purely additive (compiles unchanged, no behavior change for existing
  callers — confirmed by full `pnpm build`/`pnpm typecheck`/`pnpm test` below).
- `AcpRemoteDeps` gained an injectable `reportSessionAttention?: typeof reportSessionAttentionDefault`
  for tests, matching the existing `createConnection`/`clientInfo` injectable-seam pattern.
- `startAcpRemote()` now threads `sessionId`/`attention`/`reportSessionAttention` straight into
  the `new AcpPermissionHandler({...})` call.
- `drain()`'s turn-flow loop calls `permissionHandler.reportTurnEnd()` immediately after
  `connection.prompt(...)` resolves (right alongside where `outgoing.pushAll(endAcpTurn(...))`
  and `opts.onTurnSettled?.(...)` already fire) — **only** on the resolved path, not the
  `catch` (prompt-rejected/adapter-died) path, matching `onTurnSettled`'s own existing rule that
  an indeterminate outcome doesn't count as a genuine completion.

## Why the "own composition root, not `start.ts`" framing holds, and what's still a gap

Per the plan's own words, `acpRemote.ts` — not `start.ts` — is "the ACP path's own composition
root," since the ACP path doesn't share `start.ts`'s terminal-path dependency wiring. This unit
wires `AcpRemoteOptions`/`AcpRemoteDeps` all the way down into `AcpPermissionHandler`, which is
the scope both sub-tasks 1 and 2 describe. Actually populating `sessionId`/`attention` from a
real `falcon claude --starting-mode remote` run requires threading them further up through
`claudeRemoteLauncher.ts` → `loop.ts` → `commands/start.ts`'s `runRemoteLoop()` — none of which
sub-tasks 1/2 name, and the DoD does not require it (it requires `acpPermissionHandler.ts`'s own
call sites, dep-threading through `acpRemote.ts`'s composition root, and tests — not a live
end-to-end `start.ts` wire-up). This is the same "seam built, not yet connected to its final
real caller" precedent CLAUDE.md documents repeatedly elsewhere in this codebase (e.g.
`resolveProviderSession`, `machineClient.ts`'s socket not yet started from `commands.ts`). I am
flagging this explicitly rather than silently overclaiming full end-to-end wiring: a session
started via `falcon claude --starting-mode remote` today still will not push a real notification
until a follow-up unit threads real `sessionId`/`backendUrl`/`accessToken` from `start.ts`
through `claudeRemoteLauncher.ts`/`loop.ts` into `AcpRemoteOptions`.

## Tests (sub-task 3)

**`packages/cli/src/acp/acpPermissionHandler.test.ts`** — new `describe("session attention
(docs/plan-flows-3-4-5.md Flow 5 — ACP wiring)")`, mirroring
`pretoolPermissionBridge.test.ts`'s own `onPendingAttention` describe block's structure/naming:
- `handleRequest` reports `"perm"` for an ordinary tool call.
- `handleRequest` reports `"question"` for both `AskUserQuestion` and `ask_user_question`
  tool-name spellings (mirrors the bridge's own two-spelling coverage).
- Attention reporting happens **before** `handleRequest`'s returned promise settles — recorded
  via an ordering array plus asserting `pendingCount === 1` (still blocking) at the moment of
  assertion, proving the report isn't a post-resolution effect.
- `reportTurnEnd()` reports `"done"`.
- Silent no-op for every kind when `sessionId`/`attention` aren't supplied.
- `resolve()`/`reset()` never trigger attention reporting (only `handleRequest`/`reportTurnEnd`
  are call sites) — guards against a future refactor accidentally over-firing.

**`packages/cli/src/acp/acpRemote.test.ts`** — new `describe("session attention wiring
(docs/plan-flows-3-4-5.md Flow 5 — ACP correction)")`, exercising the composition root itself
(not just the handler in isolation):
- A `session/request_permission` call routed through `startAcpRemote`'s wiring reports `"perm"`
  with the `sessionId`/`attention` passed to `startAcpRemote`'s `opts` — proves sub-task 2's
  dep-threading, not just sub-task 1's handler-level behavior.
- A turn that resolves (`stopReason: "end_turn"`) reports `"done"` exactly once.
- A turn whose prompt is **rejected** (adapter died) does **not** report `"done"` — parity with
  `onTurnSettled`'s own indeterminate-outcome rule.
- No `sessionId`/`attention` passed → no-op (confirms the "seam not yet connected" default is
  genuinely inert, not silently active).

All new tests fail if their corresponding call site is deleted/commented out (verified by
inspection: each asserts a `vi.fn()` mock was/wasn't called with specific args — there is no
snapshot-style assertion that would pass regardless).

I did not manually delete-then-restore each call site to watch tests fail (unlike FL5.1's DoD,
FL5.2's DoD doesn't require that manual-verification step) — the assertions are direct
mock-call-count/argument checks tied 1:1 to the production call sites, which is the same
tautologically-fails-if-removed property `pretoolPermissionBridge.test.ts`'s existing
`onPendingAttention` tests have.

## Verification

- `pnpm --filter falcon build` — clean.
- `pnpm --filter falcon typecheck` — clean.
- `pnpm build && pnpm typecheck` (repo-wide) — clean (turbo: 11/11 tasks successful).
- `pnpm --filter falcon test` (full CLI suite) and scoped `vitest run src/acp` — the new/changed
  ACP tests (96 tests across `src/acp/**`, including 7 new attention tests in
  `acpPermissionHandler.test.ts` and 4 new in `acpRemote.test.ts`) all pass.
  - Two pre-existing, unrelated failures remain in `src/daemon/transcriptIndexer.test.ts`
    (fs-watch debounce-timing tests: "debounces rapid successive appends into a single upsert"
    and "picks up a brand-new session file appearing after startup"). Verified these are NOT
    caused by this change: `git stash` (reverting to the pristine pre-FL5.2 worktree) reproduces
    the identical two failures with identical assertion output. This is pre-existing
    fs-watch/sandbox timing flakiness in this environment, untouched by FL5.2's diff (`git
    status` confirms `transcriptIndexer.ts`/`.test.ts` and `scanner.ts`/`.test.ts` are
    unmodified). Re-running the ACP-scoped suite alone is fully green.
- `pnpm lint` (biome) on the touched files (`packages/cli/src/acp/*`) — clean (0 errors; the one
  remaining `useOptionalChain` warning is pre-existing, in the untouched `reqIdFrom` test
  helper, not introduced by this change). Import-order was auto-fixed via `biome check --write`
  after the initial edits (biome wanted `type`-only exports sorted before the value export in
  each new multi-specifier import).

## Definition of Done — verbatim checklist

- **"`acpPermissionHandler.ts` calls `reportSessionAttention` with `kind: "perm"`/`"question"`
  before it blocks awaiting `session/request_permission`"** — yes: `handleRequest()`'s first
  statement is `this.reportAttention(...)`, before the `return new Promise(...)` that performs
  the actual block; proven by the "reports attention BEFORE handleRequest's blocking promise
  settles" test.
- **"and `kind: "done"` on turn completion"** — yes: `reportTurnEnd()` (called from
  `acpRemote.ts`'s `drain()` right where a `session/prompt` call resolves) calls
  `reportAttention("done")`.
- **"parity with the terminal path's call-site timing (before the block, not after)"** — yes,
  same placement pattern as `pretoolPermissionBridge.ts`'s `handlePermissionRequest`/
  `handleAskUserQuestion`.
- **"new tests assert these call sites fire ... and would fail if removed"** — yes, both test
  files above; every assertion is a direct mock-call check against the production call site.
- **"`pnpm build && pnpm typecheck && pnpm test` clean in the worktree"** — build and typecheck
  are fully clean repo-wide. `pnpm test` has two pre-existing, unrelated failures (see
  Verification above) reproduced identically on the pristine pre-change worktree via `git
  stash` — not introduced by this unit. All ACP-scoped tests (the entire surface this unit
  touches) are green.
- **"no change to non-notify ACP behavior (permission decisions still resolve exactly as
  before)"** — yes: every new dep is optional and defaults to a no-op; the existing
  `acpPermissionHandler.test.ts`/`acpRemote.test.ts` suites (permission mapping, mode switches,
  cancellation, first-wins resolution, turn flow, stop) are unmodified except for the harness
  functions gaining optional passthrough parameters, and all still pass unchanged.
- **"commit lands"** — see below.

## Known residual gap (documented, not silently scoped in)

`sessionId`/`attention` are not yet populated by any real caller (`claudeRemoteLauncher.ts` →
`loop.ts` → `commands/start.ts`'s `runRemoteLoop()` still construct `AcpRemoteOptions` without
them). A `falcon claude --starting-mode remote` session today still will not push a live
notification end-to-end. This matches the unit's stated scope (sub-tasks 1/2 name only
`acpPermissionHandler.ts` and `acpRemote.ts`'s composition root) and the DoD's explicit
requirements — but is called out here honestly so FL5.3's live verification step (which spawns
via the Flow 3 wizard and expects a push after "FL5.2 lands") knows a further wiring task
through `start.ts`'s remote-loop path is still needed before that live check can pass.
