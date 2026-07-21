# FL4.2 — sharing-crypto-roundtrip-test

## What

Added `packages/crypto/src/__tests__/sessionSharing.test.ts`, a dedicated test proving
Flow 4's ("pair with a teammate") reused sharing primitive: an owner re-wraps a session
DEK to a teammate's content public key, the teammate can recover it, and the owner's own
content secret key cannot open that same wrapped value.

The test derives two **independent** key trees (`deriveKeyTree(getRandomBytes(32))` called
twice, once for `owner` and once for `teammate` — two different random 32-byte
`masterSecret`s, not two views of the same key) and, in one test:

1. `wrapDek(sessionDek, teammate.content.publicKey)` — the grant step.
2. Asserts `unwrapDek(wrapped, teammate.content.secretKey)` equals the original `sessionDek`
   (the teammate direction).
3. Asserts `unwrapDek(wrapped, owner.content.secretKey)` is `null` (the owner direction —
   proving the grant is genuinely scoped to the teammate, not incidentally openable by the
   owner's own key).

## Why

Per `docs/plan-flows-3-4-5.md`'s Flow 4 section: Flow 4 (teammate sharing) is real net-new
feature work gated behind a human design review (FL4.1), but the one crypto claim the
design doc leans on — that `wrapDek`/`unwrapDek` (`packages/crypto/src/dek.ts`) already
supports scoped, per-session sharing to a genuinely different identity with no new
cryptography — is code-grounded today and independently testable. FL4.2's scope is fixed
regardless of FL4.1's outcome; this unit only validates that existing primitive.

## Assumptions

- A new, purpose-named test file (rather than adding to the existing generic
  `dek.test.ts`) makes this specific Flow-4-shaped scenario easy to find and keeps the
  narrative (owner/teammate, not "keyA/keyB") aligned with the sharing story in
  `docs/plan-flows-3-4-5.md`. `dek.test.ts`'s existing "wrong content secret key" test was
  already structurally similar (two `deriveKeyTree` calls, cross-key failure) but wasn't
  framed as the sharing scenario and didn't assert the success path in the same test — this
  unit's Definition of Done requires both directions proven together, in one test, under a
  sharing-specific narrative.
- No production code changes: `wrapDek`/`unwrapDek` already exist and are unmodified,
  matching the plan's explicit "no new cryptography" framing.

## Definition of Done — how it's satisfied

Per `docs/plan-flows-3-4-5.md`'s FL4.2 Definition of Done:

- **"the round-trip test proves BOTH directions in one test file"** — both assertions
  (teammate recovers, owner does not) live in the single test
  `"wraps a session DEK to a teammate's content key and only the teammate can unwrap it"`
  inside `sessionSharing.test.ts`.
- **"`unwrapDek(wrapDek(dek, teammate.content.publicKey), teammate.content.secretKey)`
  recovers the original `dek`"** — asserted via
  `expect(unwrapDek(wrappedForTeammate, teammate.content.secretKey)).toEqual(sessionDek)`.
- **"the same wrapped value fails (`unwrapDek` returns `null`) when unwrapped with the
  owner's content secret key"** — asserted via
  `expect(unwrapDek(wrappedForTeammate, owner.content.secretKey)).toBeNull()`, using the
  *same* `wrappedForTeammate` value from the first assertion (not a re-wrap), so it's
  genuinely "the same wrapped value," not a fresh wrap under different conditions.
- **"using two genuinely independent `deriveKeyTree` outputs, not two views of the same
  key"** — `owner` and `teammate` are each `deriveKeyTree(getRandomBytes(32))` — two
  separate, freshly-random 32-byte `masterSecret`s.
- **"`pnpm test && pnpm typecheck` clean"** — verified in this worktree:
  - `pnpm --filter @falcon/crypto test` — 9 test files, 76 tests passed (including the new
    `sessionSharing.test.ts`).
  - `pnpm build` — all 6 packages built clean (turbo).
  - `pnpm typecheck` — all packages clean (turbo, 11/11 tasks successful).
  - `pnpm test` (full monorepo) — 133 test files / 1495 tests passed. (One run hit a
    transient 5s timeout on two unrelated `packages/cli/src/index.test.ts` `--help`/
    `--version` spawn tests under full parallel load — re-running `falcon`'s test suite
    alone, and the full `pnpm test` again, both came back 100% green; this is the kind of
    resource-contention flake CLAUDE.md already documents for `pnpm lint`, and it is
    unrelated to this unit's crypto-only change.)
- **"commit lands"** — see the commit created alongside this file
  (`feat: FL4.2 — sharing-crypto-roundtrip-test`).

This unit's scope was fixed regardless of FL4.1 (the Flow 4 design-review gate): no
schema/authz/socket/invite code was touched, only a test against the already-existing
`wrapDek`/`unwrapDek` primitives.
