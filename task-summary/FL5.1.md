# FL5.1 — notify-callsite-guard

docs/plan-flows-3-4-5.md, Phase 0 "Flow 5 close-out", unit `FL5.1 [inline]
"notify-callsite-guard"`. Test-only unit — no production code changed.

## What / why

Flow 5's terminal-path push fix (docs/bug-fix-plan.md task 4) already wires
`onPendingAttention("perm")` / `("question")` into
`PreToolPermissionBridge.handlePermissionRequest`
(`packages/cli/src/claude/pretoolPermissionBridge.ts:651-652`) and the
`AskUserQuestion` `PreToolUse` path (`:588-589`), and the existing test suite
(`pretoolPermissionBridge.test.ts`'s "onPendingAttention" `describe` block)
already asserts both calls happen. But those existing assertions all `await`
the handler's returned promise (or otherwise let the decision resolve) before
checking the spy — they would pass identically whether the call fires before
the decision is made (today's real behavior, the actual "push arrives before
the tool runs" property Flow 5 depends on) or only as a side effect of
resolving it. That's exactly the "snapshot that would pass either way" the
Definition of Done calls out.

This unit adds two narrower regression tests that assert the call already
happened **strictly before any decision is supplied** — i.e. before
`bridge.resolve()` is ever invoked — which is the actual timing guarantee the
two call sites exist for, and a guard a future refactor (e.g. someone moving
the call into the `settle` closure) could silently violate without either of
the pre-existing tests catching it.

## What changed

- `packages/cli/src/claude/pretoolPermissionBridge.test.ts` only. Two new
  tests added to the existing "onPendingAttention (docs/user-flows.md
  fix-plan task 4)" `describe` block:
  - `"invokes onPendingAttention('perm') from handlePermissionRequest before
    the decision resolves (guards bridge.ts:651-652)"` — calls
    `handlePermissionRequest` without awaiting, asserts
    `onPendingAttention` was already called with `"perm"` exactly once
    *before* `bridge.resolve()` is called at all, then resolves and asserts
    the call count is still exactly one (proving the resolve path itself
    doesn't also fire it).
  - `"invokes onPendingAttention('question') from the AskUserQuestion path
    before the decision resolves (guards bridge.ts:588-589)"` — same shape,
    driving `handlePreToolUse({ tool_name: "AskUserQuestion" })`.
- No production code touched. `git status`/`git diff` confirm the only
  changed file in this unit is the test file above.

## How the Definition of Done is satisfied

- **"a new test exists that FAILS if either `onPendingAttention` call site is
  deleted/commented out ... prove this by temporarily removing the call
  locally and watching the new test fail, then restoring it"** — done and
  verified live in this session:
  - Removed `this.deps.onPendingAttention?.("perm");` (and its preceding
    comment) from `handlePermissionRequest` (`:651-652`) → reran
    `vitest run src/claude/pretoolPermissionBridge.test.ts` → exactly the two
    tests that assert the `"perm"` call failed (the pre-existing
    "fires 'perm' from handlePermissionRequest ..." test AND this unit's new
    guard test), both with "Number of calls: 0", 58/60 otherwise passing.
    Restored the file from a saved copy (`git diff` confirmed a clean
    revert — zero production diff).
  - Removed `this.deps.onPendingAttention?.("question");` (and its preceding
    comment) from `handleAskUserQuestion` (`:588-589`) → reran the same
    suite → exactly the two `"question"`-asserting tests failed the same way
    (58/60 passing). Restored the file again, confirmed clean via `git diff`.
  - Not just an existence check: the new tests specifically fail if the call
    is *moved* to fire only after/inside the resolution path too, since the
    assertion runs before `bridge.resolve()` is ever called in the test —
    at that point no decision exists yet for a post-hoc call to piggyback
    on.
- **"full `pnpm test` and `pnpm typecheck` clean in the worktree"** — both
  run from the repo root against the restored (real) source tree:
  - `pnpm typecheck` — all 11 turbo tasks green (`@falcon/wire`,
    `@falcon/crypto`, `@falcon/server`, `falcon`, `@falcon/web`,
    `@falcon/e2e`, ...).
  - `pnpm test` — all 11 turbo tasks green; `falcon` package: 133 test files,
    1484 tests passed (including the 60-test
    `pretoolPermissionBridge.test.ts`, up from 58 before this unit);
    `@falcon/web`: 98 test files, 741 tests passed.
  - `pnpm build` also run and green (root `turbo run build`, including
    `@falcon/web`'s `next build` static export).
- **"no production behavior changed (this unit is test-only)"** —
  `git status --porcelain` after landing shows only
  `packages/cli/src/claude/pretoolPermissionBridge.test.ts` modified; the
  production file `pretoolPermissionBridge.ts` is byte-identical to its
  pre-unit state (confirmed via `git diff` showing no changes to it).
- **"commit lands"** — see the commit for this unit,
  `feat: FL5.1 — notify-callsite-guard`.

## Scope notes

- This unit is deliberately narrow per its checklist item: a regression
  guard for the already-resolved terminal path, no new implementation. The
  real remaining Flow 5 work — wiring `reportSessionAttention` into the
  headless/ACP permission path — is `FL5.2` (`[solo]`, its own worktree/unit,
  not touched here).
- Reused the existing `makeBridge()` test harness
  (`pretoolPermissionBridge.test.ts`'s own helper) rather than introducing a
  new one, per the task's "reuse the existing bridge test harness"
  instruction.
