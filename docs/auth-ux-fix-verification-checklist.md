# Auth UX Fix Verification Checklist

Companion to [`auth-ux-overhaul-fix-plan.md`](./auth-ux-overhaul-fix-plan.md) (all 11 fixes
marked ✅ Implemented) and the original [`auth-ux-overhaul-e2e-results.md`](./auth-ux-overhaul-e2e-results.md)
that found them. This checklist verifies each fix actually holds up live, plus a short
regression sweep of the flows those fixes touch.

**Rule: report, do not fix.** If you find a problem, write it down with evidence (exact
copy, exact repro steps, log lines) and move on. Do not edit any source file.

## 0. Setup

- Server on :3005, web on :3000 — both already running (confirmed fresh restart with
  rebuilt `crypto-worker.js`, verify the worker bundle's `API_URL` fallback is present:
  `grep -o 'API_URL??"http://localhost:3005"' packages/web/public/crypto-worker.js` should
  match).
- Use a **fresh** `FALCON_HOME_DIR` (e.g. `/tmp/falcon-e2e-B`) for the CLI — do not reuse
  `/tmp/falcon-e2e-A`, it's left in a dead-token state from prior testing.
- Use throwaway emails (`e2e-fix-<timestamp>@example.com`). The DB is a shared hosted Neon
  instance — don't delete data you didn't create.
- Chrome MCP for the web half, tmux for the CLI half, same pattern as the original E2E pass.

---

## 1. Fix 2 + Fix 3 — session freshness (the two biggest regressions)

These were the most severe original findings. Test them first and thoroughly.

- **F2.1** Pair a fresh CLI + browser account (normal first-run flow). Once you land on
  `/dashboard/`, **hard-reload the page** (not a link click — an actual browser reload or
  re-navigate to the same URL). **PASS:** dashboard loads normally, no bounce to
  `/signin/?reason=expired`. **FAIL:** any sign-out on reload — this was the core E2E-4.1/6.1
  bug; if it still reproduces, that's the most important thing to report.
- **F2.2** While reloaded, open the Network tab / use console tooling to confirm a
  `POST /v1/auth/refresh` (or equivalent) actually fires on load. Confirm it hits `:3005`,
  not a relative path against `:3000`.
- **F2.3** Revoke the CLI's session from Settings → Devices → Log out (on the daemon row).
  Confirm the daemon log shows an immediate disconnect (this part already passed originally
  — just confirm it still does).
- **F3.1** With that CLI session now dead, run `falcon claude` again in the same interactive
  terminal. **PASS:** prints `Your session expired. Reconnecting…`, then actually shows a
  fresh QR code / pairing flow (not an immediate hard-fail). **FAIL:** the old
  `falcon: not logged in, and there's no terminal here to sign in from` hard-fail without
  ever attempting to re-pair.
- **F3.2** Approve that re-pair from the browser. Confirm the CLI continues into a working
  session with no second manual command.
- **F3.3** Send a message from the CLI post-re-pair, open its timeline in the web, confirm
  the message actually renders decrypted (not a decrypt-error placeholder, not stuck on "No
  messages yet"). This is the specific regression check the original plan called out as most
  important and that the original E2E pass could never actually complete — try hard to get a
  clean answer either way this time.

## 2. Fix 4 — account-bound key material

- **F4.1** Sign up Account A on a fresh browser (or after clearing `falcon-crypto-bridge` +
  `falcon-session` IndexedDB). Complete signup normally, confirm dashboard loads.
- **F4.2** Without wiping anything, log out, then sign up a **brand-new** Account B on the
  *same* browser (so it still has Account A's leftover key material in IndexedDB).
  **PASS:** Account B gets its own fresh key material; signup completes normally into
  Account B's own dashboard, no "Something went wrong," no cross-contamination.
  **FAIL:** any sign of Account B ending up with Account A's keys, or signup failing at all.
- **F4.3** Log out of B, log back in as **Account A** on that same browser. **PASS:**
  Account A's own dashboard/messages work correctly (its keys should still be intact and
  correctly scoped, not overwritten by B's signup in F4.2).
- **F4.4** Check `falcon-crypto-bridge`'s stored record via devtools/console — does it now
  carry some form of account identifier alongside the key material? Note what you find.

## 3. Fix 5 — logout deletes databases

- **F5.1** While signed in with valid keys, log out via the sidebar.
- **F5.2** Check `indexedDB.databases()` immediately after. **PASS:** neither
  `falcon-crypto-bridge` nor `falcon-session` appears in the list at all (not just empty —
  actually gone). **FAIL:** either still listed (the original bug).

## 4. Fix 6 — unmanaged sessions no longer backfill pre-Falcon history

- **F6.1** Pick a project directory that has **pre-existing** plain `claude` / Claude Code
  history on this machine from before this test (there should be plenty from prior sessions
  today). Pair a **brand-new** account's CLI to run `falcon claude` in that same directory
  for the first time.
- **F6.2** Check the dashboard's "Unmanaged sessions" list. **PASS:** it does NOT show old,
  pre-existing transcripts from hours/days ago under the new account — only sessions from
  at or after this account's own pairing (allowing for whatever grace window the fix
  documents). **FAIL:** old unrelated history still appears (the original bug).
- **F6.3** Run a **second** `falcon claude` message in a plain (non-Falcon) `claude` session
  in that same directory, then check whether it now correctly appears (or correctly doesn't,
  per whatever the fix's intended scoping is) — report exactly what you see either way.

## 5. Fix 7 — key request reaches the terminal

- **F7.1** With a paired CLI actively running an interactive `falcon claude` session, trigger
  a key request from a second (keyless) browser context for the same account.
- **F7.2** Watch the **active CLI terminal** (not the log file) for any visible indication
  that a device is requesting keys. **PASS:** something visible appears in the terminal
  (bell, OSC9 notification, banner line — whatever the fix implemented) without needing to
  tail log files. **FAIL:** nothing visible changes in the terminal at all (matches the
  original bug — note which terminal emulator you're using, since OSC9 support varies).
- **F7.3** Confirm `falcon keys approve` still works exactly as before (code match, approve,
  browser continues automatically) — this is a regression check, not new behavior.

## 6. Fix 8 — `/password/` default mode on a pairing continuation

- **F8.1** Start a CLI pairing (`falcon claude` on a fresh home dir), open the printed URL in
  a signed-out browser, click through to `/password/`. **PASS:** lands on (or clearly
  defaults toward) **sign-in**, not "Create your account," given this is a pairing
  continuation. Note the exact default you see.
- **F8.2** Separately, visit `/password/` directly with **no** pending pair context. Confirm
  behavior here (report whether it's still signup-default, and whether that's reasonable
  given no pairing context to react to).

## 7. Fix 9 — "One more step" copy

- **F9.1** Get a browser into the "no local keys" state (sign in with an account that has no
  keys on this browser). Read the "One more step" screen's copy carefully. **PASS:** it
  clearly explains *why* (this browser doesn't have your keys yet) rather than reading like
  an unexplained pairing request. Quote the exact copy you see.

## 8. Fix 10 — `/pair/` key-fetch detour is no longer a dead end

- **F10.1** Set up the two-step scenario: a brand-new CLI pairing request pending, AND the
  approving browser itself has no local keys yet (needs to fetch keys from another device
  first). Open the pairing link in that keyless browser.
- **F10.2** Approve the key request from another device/CLI so the browser receives keys.
  **PASS:** the browser automatically continues from the key-request screen to the actual
  "Connect this machine?" pairing-approval card (not stuck on the key-request screen forever).
  **FAIL:** browser stays stuck showing the key-request screen with no path forward, CLI
  still waiting (the original bug).
- **F10.3** Approve the pairing card. Confirm the CLI completes normally.

## 9. Regression sweep (quick pass — these already passed originally, just confirm no new breakage)

- **R1** First-run CLI (`falcon claude`, no account, fresh home dir): welcome → QR → waiting,
  no red error.
- **R2** Pairing approval card shows correct machine/folder/requested-time, approve works.
- **R3** Key-sharing code match: CLI-printed code === browser-shown code, digit for digit.
- **R4** `falcon auth status` after a successful pairing shows `device-key-protected`.
- **R5** Settings → Devices lists sessions correctly, "Log out" works with a confirm step.

---

## Report format

For each item: **PASS** / **FAIL** / **BLOCKED** (with why), plus for any FAIL: exact copy/
screenshot description/log line, and repro steps. End with:
1. Pass/fail table.
2. Whether the two most critical regressions (F2.1, F3.1) are actually fixed — say so
   plainly, this is the headline result.
3. Anything you found that isn't in this checklist but looks wrong.
