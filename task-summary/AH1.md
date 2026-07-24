# AH1 — pair-silent-refresh

## What

Fixes `docs/auth-ux-hardening-plan.md` item 1: `/pair` (`packages/web/src/app/(public)/pair/page.tsx`)
was gating on `isSignedIn()` alone, with no `silentRefresh()` attempt first. Since the pairing
link is very plausibly the first thing opened in a new tab, the in-memory access token
(`lib/session.ts`) is always `null` on that load, so a fully provisioned, PIN-unlocked browser
holding a live refresh token still got bounced to `/signin/` on every single pairing attempt —
the single most common pairing path was broken.

Changes:

1. `pair/page.tsx` now imports `silentRefresh` from `@/lib/session` alongside the existing
   `getToken`/`isSignedIn`, and calls it (via a new `resolvePairGate` helper) before deciding to
   bounce, mirroring `require-auth.tsx`'s `ensureSession`.
2. The bounce condition is split into two cases, extracted into a new, independently-testable
   `resolvePairGate(identity, { isSignedIn, silentRefresh })` in a new
   `pair/pair-gate.ts` module (same "pull the decision out of the effect into a plain function"
   technique `require-auth.tsx` already uses for `shouldRedirectToSignin`, since this package has
   no DOM test environment):
   - `!identity` → bounce to `/signin/` immediately (nothing local to refresh from — a browser
     with no key material genuinely can't approve; unchanged from before).
   - `identity` present but `!isSignedIn()` → attempt one `silentRefresh()` and only bounce if
     that also fails; succeed → land on the "confirm/Approve" screen.
3. Added the just-in-case retry inside `approve()`: if `getToken()` comes back `null` at
   click-time, attempt `silentRefresh()` once more before showing "You've been signed out."
   `/pair` sits outside `RequireAuth`'s mounted 60s re-check interval, so a token that expires in
   the gap between the initial gate and the user actually clicking Approve had no other chance to
   refresh. This closes the second recommendation in `known-issues.md` #14.
4. New `pair/pair-gate.test.ts` (4 cases): no-identity bounces immediately without ever calling
   `silentRefresh`; already-signed-in lands on confirm without calling `silentRefresh`; signed-out
   but `silentRefresh` succeeds lands on confirm; signed-out and `silentRefresh` fails bounces to
   signin.

## Files changed

- `packages/web/src/app/(public)/pair/page.tsx` — import `silentRefresh`, call
  `resolvePairGate` before the bounce decision, add the `approve()` retry.
- `packages/web/src/app/(public)/pair/pair-gate.ts` (new) — `resolvePairGate` extracted decision
  function.
- `packages/web/src/app/(public)/pair/pair-gate.test.ts` (new) — unit tests for the four gate
  outcomes (sub-task 4).

## Assumptions

- This inline unit's code (the `page.tsx` diff, `pair-gate.ts`, `pair-gate.test.ts`) was already
  present, uncommitted, in the `AH1` worktree when this task started — matching the plan
  document's proposed fix and the `require-auth.tsx` pattern it's meant to mirror. I reviewed it
  line-by-line against the plan's "## 1." section and `require-auth.tsx`/`require-auth.test.ts`,
  confirmed it's correct and idiomatic, ran the full build/typecheck/test suite, and additionally
  live-verified the actual pairing flow end-to-end (see below) rather than assuming the
  pre-existing diff was correct untested.
- `pnpm lint` hit the known transient `[warn] Linter process terminated abnormally (possibly out
  of memory)` noted in CLAUDE.md, and — unusually — repeated on a second try, and even on a bare
  `npx biome --version`. This turned out to be the user's global `rtk` (Rust Token Killer) CLI
  hook intercepting `biome`/`find` invocations and failing itself, not a project or code problem:
  calling `node_modules/.bin/biome` directly worked (`Checked 3 files in 12ms. No fixes applied.`
  for the pair directory; a full-repo `biome check .` surfaced 26 pre-existing errors, all in
  unrelated `packages/cli/src/auth/*` files predating this task, none touching anything AH1
  changed).

## Verification

- `pnpm build` — full turbo build, all 6 tasks succeeded (`@falcon/web` static export included
  `/pair` at 2.96 kB).
- `pnpm typecheck` — full turbo typecheck, all 11 tasks succeeded (cache-hit on `@falcon/web`,
  confirming no type errors against the current diff).
- `pnpm --filter @falcon/web test` — 147 test files, 1132 tests, all passed, including the new
  `pair/pair-gate.test.ts` (4/4) and the existing `require-auth.test.ts` (4/4).
- `node_modules/.bin/biome check "packages/web/src/app/(public)/pair"` — clean, no issues.

## Live verification (real stack, real browser, real CLI)

Followed CLAUDE.md's E2E runbook exactly, in the `AH1` worktree:

1. **Stack up**: confirmed the existing local Postgres (`postgres://falcon:falcon@localhost:5432/falcon`)
   was already up; started `@falcon/server` on :3005 and `@falcon/web` on :3000 in the background
   from this worktree (`/tmp/ah1-logs/{server,web}.log`), confirmed both listening and the server
   migrated cleanly (idempotent "already exists, skipping" notices).
2. **Registered a fresh throwaway account (Chrome MCP)**: opened `http://localhost:3000` →
   `/signin/` → "Continue with email + password" → `/password/` → signed up
   `ah1-test+20260724@example.com` / a throwaway password, set PIN `123456`. Landed authenticated
   on the Sessions home screen.
3. **Paired the CLI (tmux)**: with `FALCON_BACKEND_URL=http://localhost:3005`,
   `FALCON_FRONTEND_URL=http://localhost:3000`, `FALCON_HOME_DIR=/tmp/falcon-e2e-ah1`, ran the CLI
   login flow. It printed the pairing URL
   `http://localhost:3000/pair#dvxgmzpgeYbrFaasFbYYFzEKB6sbK6Bo6XYaZ-QDF0s` + QR and started
   waiting for approval.
4. **Exercised the exact AH1 fix**: navigated the already-signed-in Chrome tab to that pairing URL
   via a **full navigation** (not a same-tab state carry-over) — this is precisely the "in-memory
   access token is always null" / crypto-worker-torn-down scenario the plan document describes as
   the common case. Observed:
   - The crypto-bridge PIN-unlock gate appeared first ("Enter your PIN" / "Unlocks this browser's
     encrypted key material for this session") — expected, unrelated gate, still correct (no
     regression noted in the plan's "What to verify").
   - After entering PIN `123456` and unlocking, the page landed directly on the **"Device
     pairing" / Approve / Cancel confirm screen** — **not** a bounce to `/signin/`. This is the
     sub-task 4 scenario made concrete: `isSignedIn()` was false (fresh module load, `getToken()`
     null) and `resolvePairGate` fell through to `silentRefresh()`, which succeeded once the
     worker had a recovered refresh token, landing on `"confirm"` per the new logic. Before this
     fix (per the plan doc's documented current behavior), this exact click sequence would have
     stashed the pending pair and bounced to `/signin/` instead.
   - Clicked **Approve** → "Device approved. You can close this tab and return to the new
     device."
5. **Confirmed the CLI actually completed**: the tmux pane printed `Logged in to Falcon.`
   immediately after the browser approval, and a follow-up `falcon auth status` (invoked directly
   via `npx tsx src/index.ts auth status` to avoid an unrelated pnpm-arg quirk, see below) reported
   `Logged in.` with a real device-key-protected credentials file and a present refresh token.
6. **Confirmed the paired machine showed up on the web side**: reloaded `http://localhost:3000/`
   (another full navigation → PIN-unlock gate again, as documented/expected), unlocked, and the
   Sessions list showed two entries tagged `Trans-MacBook-Pro.local` — proof the newly-paired CLI
   machine registered against the account and reported to the server.

Net: the signed-in-but-token-expired visitor to `/pair#eph` landed on the confirm screen, not
`/signin/` — verified live, not just via the unit test.

### Noted but out of scope for AH1

While driving the CLI in tmux, one invocation was accidentally shaped as
`pnpm --filter falcon dev -- auth login` (an extra `--` that pnpm forwards literally into
`argv`), which the CLI's arg parser falls through to the *default* `claude` provider path rather
than the `auth login` subcommand. That path still calls the same underlying `ensureLoggedIn()` →
`runAuthLogin()` → `pairDevice()` flow (identical pairing UX, confirmed by reading
`auth/login.ts`), so it did not invalidate the live verification above — it just meant the CLI
went on to also try starting a `claude` session afterward, which failed with "a Falcon session is
already running in this directory" (a stale session/lockfile left over from earlier work in this
same shared worktree, unrelated to this unit). Re-ran the same check cleanly with
`npx tsx src/index.ts auth status` directly, which is the invocation whose output is reported
above. This is a pre-existing CLI arg-parsing/worktree-hygiene quirk, not something introduced by
or in scope for AH1.

## Cleanup

Killed the background `@falcon/server`/`@falcon/web` dev processes and the tmux session started
for this verification; ran `falcon kill all-force` (against the isolated `FALCON_HOME_DIR`) to
clear the daemon/session processes the pairing test spawned. Confirmed local Postgres still
healthy afterward. Left no stray listeners on :3000/:3005.
