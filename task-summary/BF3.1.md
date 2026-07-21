# BF3.1 — jwt-expiry-and-reconnect

Issues #9+#10 (`docs/bug-fix-plan.md`): the web app never inspected its stored JWT's own
`exp` claim, so an expired token looked identical to a fresh one right up until the
server rejected it at the socket handshake — at which point the app got stuck showing
"Reconnecting to Falcon…" forever, because `apiSocket.ts` never listened for
`connect_error` and Socket.IO's infinite-retry engine kept retrying the same doomed
handshake with the same expired token. Bundled per the plan's own note: issue #10's fix
"should share this same signal" as issue #9's `isTokenExpired()`.

No prior attempt existed in this worktree (`git log v2-pty-injection..HEAD` was empty at
the start of this session) — built from scratch against the plan's proposed-fix snippets.

## Sub-tasks

1. **Issue #9 — `isTokenExpired()`/`decodeJwtExp()`** (`packages/web/src/lib/session.ts`):
   added `decodeJwtExp(token)` (base64url-decodes the JWT's payload segment, reads `exp`;
   returns `null` for anything that doesn't parse — not exactly 3 dot-separated segments,
   non-base64 payload, non-JSON payload, non-numeric `exp`) and `isTokenExpired()` (no
   token, or an unparsable token, or `Date.now() >= exp * 1000` → `true`). `isSignedIn()`
   now requires both a present token and `!isTokenExpired()`. Matches the plan's snippet
   almost verbatim; the only deviation is avoiding two `noNonNullAssertion` warnings
   biome flags on the plan's literal `parts[1]!` (narrowed via an explicit
   `if (!payloadPart) return null` instead — same behavior, no lint warning).

2. **Issue #9 — proactive expiry surfacing** (`packages/web/src/features/auth/require-auth.tsx`):
   `RequireAuth` (the existing shared auth-gate for every route under the `(protected)`
   layout) already re-derives `isSignedIn()` once per mount; added a
   `setInterval(..., EXPIRY_CHECK_INTERVAL_MS)` (60s) inside the same effect that
   re-checks `shouldRedirectToSignin(isSignedIn())` and redirects to `/signin/` the
   moment it flips true, clearing the interval on unmount. Chose `RequireAuth` over a new
   standalone hook mounted at the app root (`Providers`/`OfflineBanner`'s spot) because
   (a) it's already the one file every protected route shares, (b) Next's App Router
   keeps a route-group layout mounted across navigations within that group, so the
   interval keeps running for the whole time a signed-in visitor stays in the app, and
   (c) mounting a redirect-on-expiry check at the *root* layout would also run on public
   pages like `/signin/` itself, needing its own "don't loop" guard the protected-only
   placement avoids for free. No dedicated test added for the interval itself (this
   package's vitest config has no DOM/timer-harness environment — `renderToStaticMarkup`
   never flushes effects, so there's nothing new to assert beyond what
   `require-auth.test.ts` already covers for `shouldRedirectToSignin`); the redirect
   *decision* the interval calls on every tick is exactly the already-tested pure
   function, so the only untested part is the timer plumbing itself, following this
   repo's own precedent (BF2.2 issue #3: "no automated test — jsdom doesn't compute real
   layout — note this honestly rather than fabricating an assertion").

3. **Issue #10 — `connect_error` → `authError`** (`packages/web/src/sync/apiSocket.ts`):
   added `authError: { message: string }` to `ApiSocketEventMap`; `handleConnectError`
   tests the server's `next(new Error(...))` message against `/authentication token/i`
   (matches both "Missing authentication token" and "Invalid authentication token" from
   `packages/server/src/app/socket.ts`'s middleware) — on a match it sets an internal
   `authExpired` flag, emits `authError`, and calls `teardown()` (stops the infinite
   retry loop, per the plan: "`reconnectionAttempts: Infinity` has no way to know the
   failure is permanent on its own"); a non-auth `connect_error` (e.g. a transport-level
   failure) is left alone for Socket.IO's own retry engine. Wired
   `nextSocket.on("connect_error", handleConnectError)` alongside the existing
   `connect`/`disconnect`/`update`/`ephemeral` listeners, and unsubscribed it in
   `teardown()`'s existing `.off(...)` block.

   One addition beyond the plan's literal snippet: exposed `isAuthExpired(): boolean` on
   the `ApiSocket` interface (a synchronous query mirroring the existing
   `isConnected()`), reset to `false` at the top of `connect()` (a fresh `connect(token)`
   attempt starts optimistic) and left `true` after a rejected handshake until the next
   successful `connect()`. This was necessary, not cosmetic: `use-connectivity.test.ts`'s
   established testing technique renders via `renderToStaticMarkup`, which never flushes
   `useEffect` — so a purely event-driven `authExpired` state (only ever set inside an
   effect's event handler) would be unobservable in this package's test environment at
   all. A synchronous query, read once at initial `useState`, is what makes the new state
   testable the same way `wsConnected`/`isConnected()` already are.

4. **Issue #10 — `useConnectivity`/`OfflineBanner`** (`packages/web/src/lib/use-connectivity.ts`,
   `packages/web/src/components/OfflineBanner.tsx`): `ConnectivitySource` gained
   `isAuthExpired()` and `"authError"` as a third `on()` event; `ConnectivityState` gained
   `authExpired: boolean`, initialized from `source.isAuthExpired()` and updated by the
   `authError` listener (and cleared again on the next successful `connect` — a
   reconnect can only succeed with a token the server just accepted).
   `OfflineBanner` now checks `authExpired` first, before the generic online/wsConnected
   branch, rendering "Your session expired. **Sign in again**." with a `next/link` to
   `SIGNIN_PATH` (`@/features/auth`, the same constant `RequireAuth` redirects to — no
   second hardcoded `/signin/` literal).

5. **Tests**:
   - `session.test.ts` — rewrote the fixture helper to build real JWT-shaped tokens
     (`fakeJwt()`, base64url-encoding a payload the same way a real JWT would) since
     `isSignedIn()` now depends on a parseable `exp` claim; the two pre-existing tests
     that stored a plain non-JWT string (`"jwt-abc-123"`) as a "signed in" fixture were
     updated to use `fakeJwt({exp: FAR_FUTURE_EXP})` — they'd otherwise now assert
     `isSignedIn() === true` against what the new code correctly treats as expired. Added
     cases: far-future exp, past exp, exp exactly `Date.now()` (boundary — `>=`, not
     `>`), malformed (not 3 segments), non-base64/non-JSON payload, no `exp` claim,
     non-numeric `exp`, and no-window-at-all.
   - `apiSocket.test.ts` — a fake socket's `serverEmit("connect_error", new
     Error("Invalid authentication token"))` → `authError` fires with that message,
     `isAuthExpired()` flips `true`, and the socket is torn down (`isConnected()` false,
     no more retries); a non-auth `connect_error` message is ignored; `isAuthExpired()`
     resets on the next `connect()`; `teardown()`/`disconnect()` genuinely unsubscribes
     (`connect_error` after `disconnect()` fires nothing).
   - `use-connectivity.test.ts` — `authExpired` reflects `source.isAuthExpired()` at
     mount (same "pre-effect frame" technique the file already used for
     `wsConnected`/`isConnected()`).
   - `OfflineBanner.test.ts` — `authExpired: true` renders the sign-in-again copy and a
     link, and wins priority over both the offline and reconnecting copy even when
     `online`/`wsConnected` are also false.

6. `[human]` live-verification sub-task — skipped per instructions.

## Verification

- `pnpm --filter @falcon/web exec vitest run` scoped to the five touched test files —
  all green (52 tests: 14 + 22 + 6 + 6 + 4).
- `pnpm test` (full monorepo, all 11 package test tasks) — green, 696 tests in
  `@falcon/web` alone.
- `pnpm build` — green, all 6 packages including `@falcon/web`'s `next build` (static
  export).
- `pnpm typecheck` — green, all packages.
- `pnpm lint` (`biome check .`, the actual `pnpm lint` script) hit the documented
  transient "Linter process terminated abnormally (possibly out of memory)" warning
  twice in a row in this session (this machine was running several concurrent
  worktrees'/agents' builds at the time). Ran the locally-installed `./node_modules/.bin/biome
  check .` directly instead (bypasses `npx`'s separate — and in this case broken —
  cached copy, which is a distinct problem from the OOM warning: `npx vitest`/`npx
  biome` in this environment resolve a different, native-binding-broken package
  install), which completed successfully and reported the repo's pre-existing lint debt
  (97 errors / 135 warnings, all in `packages/cli`/`e2e` files this unit never touches —
  same pre-existing-debt shape BF2.2's own summary already documented). Scoped
  `biome check` to exactly the 9 files this unit touched: clean, zero errors/warnings,
  after fixing one real formatting issue and two `noNonNullAssertion` warnings this
  unit's own new code introduced (both in `session.ts`/`session.test.ts`, resolved via
  explicit narrowing instead of `!`, not left as pre-existing-debt exceptions).

## Files touched

- `packages/web/src/lib/session.ts` — `decodeJwtExp`/`isTokenExpired`; `isSignedIn` now
  folds in expiry.
- `packages/web/src/lib/__tests__/session.test.ts` — JWT-shaped fixture helper; expiry
  test matrix.
- `packages/web/src/features/auth/require-auth.tsx` — periodic re-check + redirect while
  `RequireAuth` stays mounted.
- `packages/web/src/sync/apiSocket.ts` — `connect_error` → `authError` translation,
  `isAuthExpired()` query, retry-loop teardown on auth rejection.
- `packages/web/src/sync/__tests__/apiSocket.test.ts` — `connect_error`/`authError`/
  `isAuthExpired()` coverage.
- `packages/web/src/lib/use-connectivity.ts` — `authExpired` state, `isAuthExpired()`/
  `authError` on `ConnectivitySource`.
- `packages/web/src/lib/use-connectivity.test.ts` — `authExpired` initial-state coverage.
- `packages/web/src/components/OfflineBanner.tsx` — sign-in-again branch, ahead of the
  generic offline/reconnecting copy.
- `packages/web/src/components/OfflineBanner.test.ts` — priority-ordering coverage for
  the new branch.

## Skipped

- Sub-task 6, `[human]` live-verification (manually expiring a JWT in `localStorage` and
  confirming the proactive redirect + banner copy in a real browser) — per instructions,
  `[human]` sub-tasks are not executed by this pass.
