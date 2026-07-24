# AH7 — session-expiry-reason

docs/auth-ux-hardening-plan.md item 7: "Session-expiry redirect carries a reason".

## What

- `require-auth.tsx`: added `SIGNIN_EXPIRED_PATH = "/signin/?reason=expired"` next to the
  existing `SIGNIN_PATH`, and pointed the failed-`silentRefresh()` branch of `RequireAuth`'s
  `ensureSession` effect at it instead of plain `SIGNIN_PATH`. Re-exported from
  `features/auth/index.ts`.
- `signin/page.tsx`: reads the reason via `window.location.search` inside a `useEffect`
  (no `useSearchParams`/`Suspense`, matching the OAuth callback pages' established
  convention — e.g. `github/page.tsx`'s `consumeGithubCallback(window.location.search)`
  called from an effect). Renders an amber banner ("Your session expired — sign in again
  to continue.") above the sign-in card when the reason is `expired`.
- `signin/signin-gate.ts` (new): `isExpiredReason(search): boolean`, the actual query-string
  parsing pulled out of `page.tsx` into its own module — mirroring `pair/pair-gate.ts` exactly
  — because a Next.js `page.tsx` may only export the default component plus known metadata
  fields; a stray named export (I first tried exporting `isExpiredReason` straight from
  `page.tsx`) fails `next build`'s page-shape check. Caught this via `pnpm build`, moved it out.
- `DevicesSection` (deliberate "log out this device") and `nav-user.tsx` (deliberate sign-out)
  both still redirect to plain `SIGNIN_PATH`, unchanged — per the plan, a deliberate logout
  should never look like a surprise expiry.

## Why

A session that expires while the user is mid-page silently drops them onto `/signin/`,
indistinguishable from a cold visit — confusing. Carrying `?reason=expired` through the
existing redirect and rendering a one-line explanation closes that gap with no new state
machine, no server involvement (this is a static-export SPA, design §5.3), and no risk to the
deliberate-logout paths.

## Tests added

- `features/auth/__tests__/require-auth.test.ts`: `SIGNIN_EXPIRED_PATH` constant value +
  distinctness from `SIGNIN_PATH`; source-text assertion that the failed-`silentRefresh()`
  branch calls `router.replace(SIGNIN_EXPIRED_PATH)` and not plain `SIGNIN_PATH` (this package
  has no DOM test environment — `environment: "node"` in `vitest.config.ts`, no jsdom/RTL — so
  the actual effect can't be mounted and exercised; asserted against shipped source the same
  way the file's existing `/reset-keys/` wiring tests do).
- `signin/signin-gate.test.ts` (new, mirrors `pair/pair-gate.test.ts`): `isExpiredReason`
  recognizes `SIGNIN_EXPIRED_PATH`'s exact query string as expired; does NOT treat
  `SIGNIN_PATH`'s plain (no-query) visit as expired; ignores an unrelated/malformed
  `reason` value.
- `signin/page.test.ts`: added a source-text check that the banner render is gated on
  `isExpiredReason(window.location.search)` and that the banner copy is present.

`pnpm --filter @falcon/web test` (full suite): 154 files / 1188 tests passed, including the
above. `pnpm build` and `pnpm typecheck` both green from repo root (turbo, 11/11 tasks).

## Live verification

- Brought up the real stack in the worktree: Postgres reachable at
  `postgres://falcon:falcon@localhost:5432/falcon` (pre-existing, verified with `psql`),
  `@falcon/server` dev on `:3005` (tmux `ah7-server`, migrated cleanly — "already exists,
  skipping" notices only), `@falcon/web` dev on `:3000` (tmux `ah7-web`, ready in 2.8s).
- Confirmed the real dev server serves `/signin/` (`curl` → HTTP 200) and that its actual
  compiled client bundle (`/_next/static/chunks/app/(public)/signin/page.js`, fetched over
  HTTP from the running dev server) contains the real `isExpiredReason` export, the mount
  effect calling it against `window.location.search`, and the exact banner copy — i.e. this
  isn't just present in source, it's present in what the browser would actually execute.
- **Could not complete the browser-driven leg**: the Chrome MCP extension reported "not
  connected" (`tabs_context_mcp` failed with that error) in this environment, so I could not
  drive a real sign-up/PIN-setup, force a real failed `silentRefresh()` (e.g. by corrupting
  the in-memory access token with a dead/absent refresh token) on a protected page, and watch
  the actual redirect + banner paint, nor screenshot a plain cold `/signin/` visit showing no
  banner. That specific check is a **live check I could not perform** — reporting honestly
  rather than fabricating a screenshot or browser trace. Everything short of that (build,
  typecheck, full test suite, real stack reachability, and the served-bundle content check
  above) was verified for real, not just asserted from source.
- Killed the `ah7-server`/`ah7-web` tmux sessions I started after the verification pass;
  left Postgres running (pre-existing, not mine to stop).

## Assumptions

- "Plain unauthenticated visit" in sub-task 3 = the existing cold `/signin/` visit
  (`SIGNIN_PATH`, no query string) — same route the deliberate-logout paths already use,
  so no new route was needed for that case.
- Kept the banner styling (amber border/background) and copy exactly as specified in the
  plan doc's proposed-fix snippet, for consistency with the settled design.
