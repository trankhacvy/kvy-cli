# AH5 — devices-revoke-confirm

Unit: `docs/auth-ux-hardening-plan.md` item 5 —
`web/src/features/settings/components/DevicesSection.tsx`.

## What / why

`DevicesSection`'s `handleRevoke` used to fire `revokeSession` (and, for the current-device
row, `logout()` + redirect to sign-in) directly on a single button click. A misclick logged out
a device instantly and irreversibly from this screen — worse for the "This device" row, which
signs the current browser out entirely. This unit adds an inline confirm step so revoking a
session always requires two clicks: "Log out" → "Log out this device? [Confirm] [Cancel]".

No `AlertDialog` primitive exists under `components/ui/` in this repo (checked — only `dialog.tsx`,
a plain, non-alert Dialog), so per the plan's own fallback this uses the inline-confirm variant
(no new dependency), matching the exact shape given in the plan doc (`confirmId` state,
`requestRevoke`/`confirmRevoke`, two-state row render).

## Implementation

- **`packages/web/src/features/settings/devices-revoke-state.ts`** (new) — pure state-transition
  helpers for the confirm gate (`requestRevoke`, `clearRevokeConfirm`, `canConfirmRevoke`), kept
  in their own module so the "second click required" logic is directly unit-testable. This
  mirrors the repo's existing precedent for exactly this constraint —
  `features/git-diff/git-toolbar-state.ts`, `features/unmanaged-sessions/
  take-over-dialog-state.ts`, `features/session-control/perm-card-state.ts` — all noting that
  this package's vitest config has no jsdom/`@testing-library/react` wired up (confirmed: no
  `jsdom`/`@testing-library` anywhere in the repo's `package.json`s), so a real click/keystroke
  can't be simulated in a component test; pure logic gets extracted and tested instead, and the
  component itself gets an untouched, unit-tested wiring layer.
- **`packages/web/src/features/settings/components/DevicesSection.tsx`** — added `confirmId`
  state; split the row's click handling into `requestRevokeClick` (first click — shows the
  confirm affordance, clears any stale error) and `confirmRevoke` (second click — gated by
  `canConfirmRevoke`, clears the confirm state, then calls the original, unchanged `handleRevoke`
  body). Row rendering is now the two-state control from the plan: plain "Log out" /
  "Log out this device" trigger, or (once requested) copy calling out the current-device case
  ("Log out this browser?" / "Log out this device?") plus destructive "Confirm" and ghost
  "Cancel" buttons. Cancel just resets `confirmId` to `null` — no API call.
- Scope: only `handleRevoke` (sub-task 1) got the confirm gate, per this unit's explicit
  sub-task list. The plan doc's "What to verify" section separately *recommends* (does not
  require) the same treatment for `handleRevokeOthers` ("Log out all other devices") — left
  untouched, out of scope for this unit.

## Tests added

`packages/web/src/features/settings/devices-revoke-state.test.ts` (8 tests, all passing):
- `requestRevoke`/`clearRevokeConfirm` transitions.
- `canConfirmRevoke` gate: passes only for the exact row that requested confirmation; rejects a
  different row's id and rejects when nothing was requested.
- End-to-end (at the logic level, with a `vi.fn()` standing in for the real `revokeSession` call)
  reproduction of the two-click flow: first click never calls the API; only after the gate
  passes does the fake call fire; a cancelled row's stray Confirm click still never reaches the
  API. This is the sub-task-2 requirement ("revoke requires a second confirmation click; cancel
  leaves the session intact") reproduced without needing jsdom.

## Checks run

- `pnpm --filter @falcon/web build` — clean (`next build` succeeded, static export as usual).
- `pnpm --filter @falcon/web exec vitest run src/features/settings/devices-revoke-state.test.ts`
  — 8/8 passed. Full `pnpm --filter @falcon/web test` — 153/153 test files, 1178/1178 tests
  passed (nothing else regressed).
- `pnpm typecheck` (turbo, all packages) — clean.
- `pnpm lint` scoped to the touched directory (`biome check --write
  packages/web/src/features/settings/`) — fixed two pre-existing-style nits in the new files
  (import ordering, one JSX line-collapse) introduced by my own edits; re-ran clean. The
  repo-wide `pnpm lint` has pre-existing failures in unrelated files (mostly `packages/cli`) —
  confirmed none are under `features/settings/`.

## Live verification (real stack, real browser, real CLI)

Followed CLAUDE.md's end-to-end runbook in the `AH5` worktree:

1. Brought up Postgres (already running), `@falcon/server` on :3005 and `@falcon/web` on :3000
   in tmux panes inside the worktree.
2. Chrome MCP: registered a fresh throwaway account (`ah5-test2@falcon.local`) via
   `/password/` (had to clear a stale `falcon-crypto-bridge` IndexedDB + localStorage left over
   from earlier local dev-testing in this same browser profile — the first registration attempt
   failed client-side with "Something went wrong" until that stale state was cleared; unrelated
   to this unit's code), set PIN `123456`.
3. tmux: `FALCON_BACKEND_URL=http://localhost:3005 FALCON_FRONTEND_URL=http://localhost:3000
   FALCON_HOME_DIR=/tmp/falcon-e2e-ah5 falcon auth login` — printed a pairing URL, opened it in
   the signed-in Chrome tab, clicked **Approve**. CLI reported "Logged in to Falcon."; `falcon
   auth status` confirmed real credentials with device-key-protected key material.
4. Chrome MCP: opened Settings → **Devices**. Real list showed two live sessions: **CLI daemon**
   and **Web browser · This device**.
5. **Drove the actual confirm gate**:
   - Clicked "Log out" on the CLI daemon row → row switched to "Log out this device? [Confirm]
     [Cancel]" in place — verified via server log grep that zero `revoke` requests had reached
     the server at this point.
   - Clicked **Cancel** → row reverted to the plain "Log out" trigger, the CLI daemon session
     was still listed (session intact), and the server log still showed zero revoke requests —
     this is exactly sub-task 2's requirement.
   - Clicked "Log out" again, then **Confirm** → the row disappeared from the list immediately;
     server log then showed exactly one real `POST /v1/auth/sessions/<id>/revoke` request (grep
     `revoke` in the server log went from 0 to 2 matching lines — one from an earlier
     request-only test with no match, confirmed the 2 lines were both from this single revoke
     call's request+response log pair).
   - This directly reproduces both AH5 sub-tasks against the real running server/DB/browser,
     not just against the pure-logic test file.

### Incident during cleanup (disclosed in full)

While tearing down processes I started, I ran the CLI's `falcon kill all-force` (scoped to
`FALCON_HOME_DIR=/tmp/falcon-e2e-ah5`) expecting it to only touch Falcon-owned session/daemon
processes. Its process-scan heuristic instead also matched and `SIGKILL`ed several **idle local
Postgres backend processes** (not started by me, not Falcon's) — Postgres's postmaster then shut
the whole local cluster down defensively (its normal reaction to a backend receiving `SIGKILL`
rather than a graceful signal), and `pg_isready` started reporting "rejecting connections".
I did not use `--force`/destructive git ops or touch anything outside this recovery — I ran
`brew services restart postgresql@15`, waited for `pg_isready` to report "accepting
connections" again, and confirmed the `falcon` database and its `device_sessions` table (631
rows, matching pre-incident state) survived intact. I then stopped the `@falcon/server` and
`@falcon/web` dev processes directly with `kill <pid>` (each PID's `cwd` verified to be under
this worktree first) instead of trusting `kill all-force` again, and closed the tmux session.
Postgres was confirmed healthy again before finishing. Flagging this because it's a real,
if transient, disruption to the shared local Postgres instance other worktrees/agents may
depend on — not something a normal-looking cleanup command should be expected to risk, and worth
someone looking at `falcon kill all-force`'s process-matching logic separately.

## Assumptions

- Scope held to exactly the two listed sub-tasks; `handleRevokeOthers` intentionally left
  without a confirm step (plan doc marks that as a recommendation, not a requirement, for this
  unit).
- No `AlertDialog` primitive exists in this repo, so the plan's inline-confirm fallback was used
  as-is rather than introducing a new dependency.
