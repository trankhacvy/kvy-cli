# AH2 — oauth-stepup-reset-keys

Implements docs/auth-ux-hardening-plan.md item 2 (OAuth step-up flow for the "reset keys"
rotation) end to end, including its item 2c returning-user 409 fold-in.

## Status

Found in-progress, uncommitted work already in the worktree matching the plan almost
verbatim (no commits existed yet — `git log v2-pty-injection..HEAD` was empty, so this
wasn't a git-recorded prior attempt, just an unsaved working tree). Verified every file
against the plan's line-by-line snippets, found the code correct, found 4 test assertions
that were too strict (false-positiving on doc comments / a too-short slice window) and
fixed those, then ran build/typecheck/test/lint clean and committed.

## What shipped

- `packages/web/src/lib/pending-stepup.ts` (new) — the two-channel handoff: a TTL-guarded,
  one-shot, provider-validated `sessionStorage` flag (`stashPendingStepUp` /
  `consumePendingStepUp`) for the outbound `/reset-keys/` → provider → callback hop, plus an
  in-memory-only `stepUpReturn` module variable (`setStepUpReturn` / `takeStepUpReturn`) for
  the callback → `/reset-keys/` return leg — deliberately never `sessionStorage`, since it
  carries a live OAuth proof and a refresh token (security review finding F1).
- `packages/web/src/lib/reset-keys-phase.ts` (new) — `derivePhaseFromReturn`, the pure
  phase-transition function pulled out of the page component (same pattern as
  `require-auth.tsx`'s `shouldRedirectToSignin`) so it's unit-testable without mounting
  React/`next/navigation`.
- `packages/web/src/app/(public)/reset-keys/page.tsx` (new route) — three/four-phase client
  component (`confirm-identity` → provider redirect → `returned` → `rotating`/`error`). Uses
  the raw `useCryptoBridge()` (never `useUnlockedCryptoBridge()`, per the plan's review
  Problem 3 fix) so it can call `bridge.init(...)` from both `no-identity` and `needs-unlock`
  entrants identically — the page never branches on the caller's prior unlock-status kind at
  all. "Pair from another device" renders as the primary action; "Reset keys instead" is an
  outlined secondary that gates behind its own `confirmingReset` confirm step before showing
  the Google/GitHub buttons (item 7's hierarchy).
- `rotateKeyEpochOAuth` — new export alongside `rotateKeyEpoch` in
  `packages/web/src/lib/complete-password-sign-in.ts`. Takes the refresh token as a
  parameter (no `bridge.getRefreshToken()` — confirmed absent from `CryptoBridgeClient` and
  did not add one), signs the bind proof, calls `keysBind` with
  `stepUpProof: { kind: "oauth", provider, oauthProof }` and `rotate: true`, and resolves
  `nextUrl` via `consumePendingPair()` exactly like `completeOAuthSignIn` already does (the
  nested `/pair` → `/reset-keys/` case).
- `packages/web/src/components/auth/oauth-callback-page.tsx` — step-up branch added as the
  first check inside the resolve-proof effect: for `provider ∈ {google, github}`,
  `consumePendingStepUp(provider)` (one-shot + provider-matched, closing the confused-deputy
  hole) triggers `register()` + `setToken()` to actually complete sign-in and mint a fresh
  refresh token, then `setStepUpReturn({provider, oauthProof, refreshToken})` and
  `router.replace("/reset-keys/")`. Also folds in item 6: `handlePinSetup`'s `set-pin` branch
  now catches a `keys/bind` 409 and renders a new `{ kind: "already-bound" }` status offering
  "Pair from another device" (primary) / "Reset keys for this browser" (secondary) instead of
  a generic "Sign-in failed" over an orphaned PIN. The two provider pages
  (`auth/callback/google/page.tsx`, `auth/callback/github/page.tsx`) needed no changes — all
  the new logic lives in the shared `OAuthCallbackPage`.
- Three entry points wired to `/reset-keys/` (item 2d):
  `features/auth/require-auth.tsx`'s `no-identity` branch (new button) and `needs-unlock`
  `onForgotPin` (repointed from `/password/`); `app/(public)/pair/page.tsx`'s `no-identity`
  branch (new button alongside the existing paragraph).

## Tests (item 8)

- `lib/__tests__/pending-stepup.test.ts` — round-trip, single-use, TTL expiry, malformed
  JSON, and the confused-deputy guard (mismatched/expired stash rejected, a later unrelated
  sign-in for a different provider is not diverted); in-memory return channel round-trip.
- `lib/__tests__/reset-keys-phase.test.ts` — `derivePhaseFromReturn` reaches the PIN-setup
  phase identically regardless of entry state (the `no-identity` vs `needs-unlock` question
  the plan's review Problem 3 flags).
- `lib/complete-password-sign-in.test.ts` — `rotateKeyEpochOAuth`: calls `keysBind` with
  `stepUpProof.kind === "oauth"` and `rotate: true`; resolves `nextUrl` from a pending `/pair`
  stash; maps a 401 to `identity-mismatch` and a 409 to `other-devices-online`.
- `components/auth/oauth-callback-page.test.ts`, `app/(public)/reset-keys/page.test.ts`,
  `app/(public)/pair/page.test.ts`, `features/auth/__tests__/require-auth.test.ts` — source-text
  assertions (this vitest config is `environment: "node"`, no jsdom/App Router context, same
  technique the existing `signin/page.test.ts` uses) locking the wiring: consume-not-peek +
  provider match, register-then-setToken-then-setStepUpReturn-then-redirect ordering, the
  already-bound 409 branch and its Pair-before-Reset button order, the three `/reset-keys/`
  entry points, and the `useCryptoBridge`/no-`getRefreshToken`/no-`sessionStorage` guards.
- `[human]` (item 9, skipped per instructions): real Google + GitHub step-up round trip
  against a local dev stack.

## Fixes made to the found-in-progress work

Four test assertions were too strict and failed on a clean run — all were test-only bugs
(the code they were checking was already correct), fixed by tightening the assertions rather
than changing behavior:

1. `app/(public)/reset-keys/page.test.ts` — `not.toContain("useUnlockedCryptoBridge")` and
   `not.toContain("sessionStorage")` were failing because `page.tsx`'s own doc comments
   *name* both strings while explaining what not to do. Added a `codeOnlySource` (block/line
   comments stripped) and ran those two negative assertions against it instead of the raw
   source.
2. `components/auth/oauth-callback-page.test.ts` — same false-positive for `sessionStorage`
   (a comment on the step-up branch explains it's deliberately not used there); same
   comment-stripping fix.
3. `components/auth/oauth-callback-page.test.ts` — the "Pair before Reset" ordering check
   sliced a fixed 600-character window after the `already-bound` branch, but "Reset keys for
   this browser" sits at offset 659 in the real source, one character bucket short — the
   slice cut it off, so the button text was always absent regardless of order. Replaced the
   fixed-width slice with a slice bounded by the next real marker (`status.kind === "unlock"`),
   the same "slice between two source markers" pattern the rest of these source-text tests
   already use.

All four are documented inline in the test files.

## Verification

- `pnpm build` — clean (fresh, non-cached run of `@falcon/web`'s `next build`; `/reset-keys`
  route appears in the route table).
- `pnpm typecheck` — clean (fresh `tsc --noEmit` on `@falcon/web`).
- `pnpm test` — full web suite: 151 test files / 1164 tests, all passing after the four test
  fixes above. Full monorepo `pnpm test` also surfaced one unrelated failure,
  `packages/server/src/db/seq.test.ts`'s concurrent-lock-holding timing assertion — confirmed
  pre-existing/flaky (no `packages/server` files touched by this unit; passes standalone on
  retry) and not a regression from this change.
- `pnpm lint` — clean (biome).
- F1 grep: no `getRefreshToken` added anywhere in `CryptoBridgeClient` or its callers; the
  only `sessionStorage` reference outside doc comments is `pending-stepup.ts`'s `{provider,
  ts}` flag — the OAuth proof and refresh token only ever live in the module-level
  `stepUpReturn` variable.

## Files

New:
- `packages/web/src/lib/pending-stepup.ts`
- `packages/web/src/lib/reset-keys-phase.ts`
- `packages/web/src/app/(public)/reset-keys/page.tsx`
- `packages/web/src/lib/__tests__/pending-stepup.test.ts`
- `packages/web/src/lib/__tests__/reset-keys-phase.test.ts`
- `packages/web/src/app/(public)/reset-keys/page.test.ts`
- `packages/web/src/components/auth/oauth-callback-page.test.ts`
- `packages/web/src/app/(public)/pair/page.test.ts`

Modified:
- `packages/web/src/lib/complete-password-sign-in.ts` (+ `rotateKeyEpochOAuth`)
- `packages/web/src/lib/complete-password-sign-in.test.ts` (+ its tests)
- `packages/web/src/components/auth/oauth-callback-page.tsx` (step-up branch + already-bound
  409 status)
- `packages/web/src/features/auth/require-auth.tsx` (`no-identity` button, `onForgotPin`
  repoint)
- `packages/web/src/features/auth/__tests__/require-auth.test.ts` (+ wiring assertions)
- `packages/web/src/app/(public)/pair/page.tsx` (`no-identity` button)

Not committed (pre-existing untracked reference docs shared across units, identical to the
copies in the parent worktree — not this unit's to own):
- `docs/auth-ux-hardening-plan.md`, `docs/auth-ux-hardening-plan-review.md`
