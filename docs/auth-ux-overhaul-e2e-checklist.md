# Auth UX Overhaul — E2E Verification Checklist

Companion to `docs/auth-ux-overhaul-plan.md`. Everything in that plan was verified by
typecheck + unit/integration suites only — **nothing has been run against a live stack**.
This checklist is that missing verification.

**Rule for the whole run: report, do not fix.** Do not edit source files. Every finding
needs evidence (a quoted string, a screenshot, a log line, a network response). A test you
could not run is reported as **BLOCKED**, never as passed.

---

## 0. Setup

### 0.1 Stack

Two long-lived tmux panes. No Docker, no local Postgres — `DATABASE_URL` in the repo root
`.env.local` already points at hosted Neon.

```bash
# pane: server
pnpm --filter @kvy/server dev          # :3005, migrates on boot

# pane: web
pnpm --filter @kvy/web dev             # :3000
```

- [ ] **S1** Server boot log shows migrations applied, including `0006` (pair_requests
      label/cwd) and `0007` (key_requests). Quote the lines.
- [ ] **S2** `NODE_ENV` is **not** `production` (otherwise `/v1/auth/password/*` 404s and
      you cannot create a test account).
- [ ] **S3** Web dev server is serving on :3000 and `/crypto-worker.js` loads (check the
      Network tab — the crypto bridge is a separate static worker bundle; a 404 here breaks
      everything downstream and is itself a finding).

### 0.2 CLI environment

Every CLI pane needs these, and an **isolated home dir** so you never touch the real
`~/.kvy`:

```bash
export KVY_BACKEND_URL=http://localhost:3005
export KVY_FRONTEND_URL=http://localhost:3000
export KVY_HOME_DIR=/tmp/kvy-e2e-A     # use -B, -C for extra machines
```

Run the CLI via `pnpm --filter kvy dev -- <args>` (tsx, no build needed).

### 0.3 Process hygiene

Only manage processes you started. Verify a PID's cwd before killing it. If :3000/:3005 are
taken by another worktree, pick free ports and set `PORT` / `NEXT_PUBLIC_API_URL` /
`KVY_BACKEND_URL` to match — never blanket-kill by process name.

### 0.4 Useful browser helpers

Via `mcp__claude-in-chrome__javascript_tool`:

```js
// What key material does this browser have?
indexedDB.databases().then(d => JSON.stringify(d))

// Make this browser KEYLESS but keep it SIGNED IN (the Phase 4a state).
// Deletes ONLY the key store. `kvy-session` must survive.
indexedDB.deleteDatabase("kvy-crypto-bridge")

// Full reset (signed out, no keys)
indexedDB.deleteDatabase("kvy-crypto-bridge");
indexedDB.deleteDatabase("kvy-session");
```

---

## 1. First run — CLI (Phase 1)

The headline complaint this work started from: `kvy claude` showed a red error telling
you to run another command.

- [ ] **E2E-1.1** With a brand-new `KVY_HOME_DIR` and **no** account yet, run
      `kvy claude --model haiku`.
      **PASS:** stdout shows `Welcome to Kvy.` → `Opening your browser…` → a QR code →
      `Waiting for approval…`.
      **FAIL:** any red/stderr output, or any text telling you to run `kvy auth login`.
- [ ] **E2E-1.2** The printed URL is `http://localhost:3000/pair#<fragment>`.
- [ ] **E2E-1.3** The URL fallback line (`If it didn't open, go to:`) appears **only** when
      the browser could not be opened. If a browser did open, that line must be absent.
- [ ] **E2E-1.4** After approving in the browser (§2), the terminal prints
      `✓ Connected as <the account email>` — a real address, not a placeholder — then
      `Starting your session…`, then continues **into the Claude session with no second
      command**.
- [ ] **E2E-1.5** `kvy auth status` reports logged in, key material
      `device-key-protected (OS Keychain)`, and an account-key fingerprint.
- [ ] **E2E-1.6** Non-interactive path: `echo "" | kvy claude` (or run with stdin not a
      TTY) fails with `kvy: not logged in, and there's no terminal here to sign in from.`
      — this is the one place a hard failure is correct.

---

## 2. Pairing approval — web (Phase 2)

- [ ] **E2E-2.1** **Signed-out visitor.** With no session in the browser, open the pairing
      URL from E2E-1.2.
      **PASS:** redirected to `/signin/`, and the heading reads **"Connect your machine"**
      (not the default "Sign in to Kvy").
      **FAIL:** any screen mentioning "key material", or a "Reset keys" button. That was the
      old dead end and its absence is the point of this test.
- [ ] **E2E-2.2** Sign up at `/password/` with a throwaway email + a ≥8-char password.
      **PASS:** you are **not** asked for a PIN at any point.
      Note: automated Chrome has no platform authenticator, so the key-protection choice
      auto-resolves to "stay signed in" and may not render. That is expected (see §8).
- [ ] **E2E-2.3** After sign-up you are returned to the pairing screen automatically (the
      pending pair was stashed), **without** re-opening the link by hand.
- [ ] **E2E-2.4** The approve card shows: **Machine** = the CLI host's hostname,
      **Folder** = the directory you ran `kvy` in, **Requested** = a relative time, and
      the warning *"Only approve this if you just ran `kvy` yourself."*
- [ ] **E2E-2.5** Click **Approve** → success screen reads *"… is connected. Go back to your
      terminal — your session is starting."*
- [ ] **E2E-2.6** **Malformed link.** Open `http://localhost:3000/pair#notavalidkey`.
      **PASS:** *"This link is out of date. Run `kvy` again…"*. No crash, no dead end.
- [ ] **E2E-2.7** **base64url regression guard.** Repeat pairing until you get a fragment
      containing `-` or `_` (retry `kvy auth login` a few times with a fresh home dir).
      **PASS:** it still pairs. This is the `+`/`/` conversion bug the helper exists to
      prevent; if pairing fails only for such keys, that is a real finding.

---

## 3. Zero-machine onboarding (Phase 3)

- [ ] **E2E-3.1** Sign up a **fresh** account in the browser and never run the CLI.
      **PASS:** the dashboard shows **"Connect your first machine"** with three numbered
      steps, two copy buttons, and a spinner reading *"Waiting for your first machine…"*.
      **FAIL:** the old *"Run `kvy` from a project on any **paired** machine"* text.
- [ ] **E2E-3.2** The **New session** button is **absent** while there are no machines.
- [ ] **E2E-3.3** Both copy buttons actually copy (`navigator.clipboard` — verify via
      `javascript_tool` reading the clipboard, or by pasting into a text input).
- [ ] **E2E-3.4** **Auto-advance.** With that dashboard open and untouched, pair a CLI in a
      tmux pane. **PASS:** the onboarding screen disappears on its own — no manual reload.
      Record roughly how long it took.
- [ ] **E2E-3.5** Deep-link `/dashboard/session/new/` with zero machines. **PASS:** no empty
      machine picker; you get onboarding or an honest message.

---

## 4. Key sharing between devices (Phase 4 + 4a) — **the most important section**

This is the new feature and the most security-sensitive UI in the product. Take your time.

### 4.1 Setup: a signed-in browser with no keys

With a paired CLI already working (§1–2), run in the browser console:

```js
indexedDB.deleteDatabase("kvy-crypto-bridge")   // keys gone, session store intact
```

Then reload `/dashboard/`.

- [ ] **E2E-4.1** **PASS:** you are **still signed in** — no bounce to `/signin/` — and you
      land on **"One more step"** with a 6-digit code.
      **FAIL:** any redirect to sign-in. That would mean the Phase 4a session-store split
      isn't working and the whole feature is unreachable.
- [ ] **E2E-4.2** The panel lists your other devices (the CLI daemon should appear) and
      shows *"This page continues automatically once they arrive."*
- [ ] **E2E-4.3** The destructive option is a **small text link** (*"Can't reach any of
      those devices?"*), **not** a button sitting next to a primary action. Clicking it
      reveals the consequence text *"This permanently erases all past sessions…"* before
      anything destructive is reachable.

### 4.2 Approving from the CLI

- [ ] **E2E-4.4** In a tmux pane on the paired machine: `kvy keys approve`.
      **PASS:** it prints the request with **Signed in as** (server-attested client kind),
      **Says it is** (the browser's self-reported label), **Asked** (relative time), and
      *"Check that device shows this code:  NNN NNN"*.
- [ ] **E2E-4.5** ⚠️ **The code printed by the CLI matches the code shown in the browser,
      digit for digit.** This is the security control — a mismatch is a CRITICAL finding.
- [ ] **E2E-4.6** Answer `n` (or anything but `y`). **PASS:** prints `Skipped.`, sends
      nothing, and the browser stays waiting.
- [ ] **E2E-4.7** Run it again and answer `y`. **PASS:** `✓ Keys sent.` and the **browser
      advances on its own within a few seconds** — no reload.
- [ ] **E2E-4.8** The browser can now actually decrypt: open an existing session's timeline
      and confirm real message content renders (not a decrypt-error placeholder). This is
      what proves the right key arrived, not just that the flow completed.

### 4.3 Approving from another browser (if you can get a second profile)

Only if a second Chrome profile / separate browser is available. Skip and mark **BLOCKED**
otherwise — do not fake it.

- [ ] **E2E-4.9** Requesting browser shows a code; the holder browser pops a card at the
      bottom with the **same** code, a server-attested row, and the button labelled
      **"Codes match — send my keys"** (not "Approve").
- [ ] **E2E-4.10** **"Not now"** dismisses it, and re-issuing the same request does **not**
      immediately re-show that card in the same page load.

### 4.4 Adversarial checks ⚠️

- [ ] **E2E-4.11** **Mismatch drill.** Trigger two different key requests (e.g. delete the
      key DB, note the code, delete again, note the new code). **PASS:** the codes differ.
      A code that is the same across different requests is a CRITICAL finding — it would
      mean the control is decorative.
- [ ] **E2E-4.12** **Cross-account refusal.** Sign in as a *second, different* account in
      another browser/profile and try to approve the first account's request. Easiest at the
      API level with that account's access token:
      ```
      POST /v1/keys/request/approve  {"ephPub":"<victim's>","response":"c2VhbGVk"}
      ```
      **PASS:** `404`. **FAIL (CRITICAL):** anything 2xx.
- [ ] **E2E-4.13** **Self-approval refusal.** With one session's token, create a request and
      approve it with that *same* token. **PASS:** `404`.
- [ ] **E2E-4.14** **Single-use claim.** After a successful claim, claim the same `ephPub`
      again. **PASS:** `{"state":"expired"}`.
- [ ] **E2E-4.15** **Status code.** `POST /v1/keys/request` with `{"ephPub":"not-a-key"}` and
      a valid token. **PASS:** `400`. **FAIL:** `401` (would trigger spurious re-auth loops
      in any client with a 401 interceptor).
- [ ] **E2E-4.16** **Untrusted label is inert.** Create a request with
      `label: "<img src=x onerror=alert(1)>"` and view the approve card.
      **PASS:** rendered as literal text, no alert, no HTML injection.

---

## 5. No PIN anywhere (Phase 5)

- [ ] **E2E-5.1** Reload `/dashboard/` five times. **PASS:** never a PIN prompt, never a
      bounce to sign-in. (In automated Chrome expect **zero** prompts; on a machine with
      Touch ID you may get one biometric tap — both are correct, record which you saw.)
- [ ] **E2E-5.2** Grep the running app for dead UI: no "Enter your PIN", "Create a PIN",
      or "Forgot your PIN?" anywhere in the sign-in, pairing, callback, or reset-keys flows.
- [ ] **E2E-5.3** Confirm the stored record shape:
      ```js
      // in the browser console
      const db = await new Promise(r => { const q = indexedDB.open("kvy-crypto-bridge"); q.onsuccess = () => r(q.result); });
      const tx = db.transaction("keys", "readonly");
      tx.objectStore("keys").get("keyRecord").onsuccess = e => console.log(JSON.stringify(Object.keys(e.target.result)), e.target.result.v, e.target.result.mode);
      ```
      **PASS:** `v: 2`, `mode: "device"` (or `"prf"`), and **no** `wrappedRefreshToken` key —
      the session credential lives in the separate `kvy-session` database now.
- [ ] **E2E-5.4** Confirm `kvy-session` exists as its own database (`indexedDB.databases()`).
- [ ] **E2E-5.5** **Logout wipes both.** Sign out via the sidebar. **PASS:** both
      `kvy-crypto-bridge` and `kvy-session` are gone. A surviving session DB would be
      a live 60-day credential left behind — report as HIGH.

---

## 6. Session lifetime and revocation

- [ ] **E2E-6.1** Leave `/dashboard/` open for >15 minutes (the access-token TTL).
      **PASS:** it keeps working, silently — no sign-in bounce, no visible reconnect.
- [ ] **E2E-6.2** Settings → **Devices** lists the browser and the CLI daemon, shows the
      account email, and carries the explainer *"Anyone using one of these devices can read
      your sessions…"*.
- [ ] **E2E-6.3** "Log out all other devices" → the CLI daemon's socket drops **immediately**
      (watch the daemon log), not after a delay.
- [ ] **E2E-6.4** ⚠️ **Dead refresh token → inline re-pair (the AX-1.5 path).** After
      revoking the CLI's session, run `kvy claude --model haiku` again.
      **PASS:** prints `Your session expired. Reconnecting…` and runs the pairing flow
      **inline** — no red error, no instruction to run another command.
      **PASS (critical half):** after re-pairing, **send a message in the session and
      confirm the web can decrypt it.** This is the stale-content-key regression the whole
      `runPreflight` restructure exists to prevent — if the web shows a decrypt error, that
      is a CRITICAL finding.
- [ ] **E2E-6.5** Machine presence: stop the daemon and confirm the web marks the machine
      offline; if its session was revoked, it should indicate re-auth is needed.

---

## 7. Copy quality (Phase 6)

Walk every auth screen: `/signin/`, `/password/`, `/pair/`, `/reset-keys/`, the OAuth
callback, `RequireAuth`'s no-keys state, Devices.

- [ ] **E2E-7.1** No visible occurrence of: `key material`, `masterSecret`, `keyEpoch`,
      `epoch`, `DEK`, `custody`, `bridge`, `ephPub`, `bind`. Quote any hit with its screen.
- [ ] **E2E-7.2** Every error state offers a **button or link**, never "go run this command"
      as the only recovery.
- [ ] **E2E-7.3** Every destructive action states its consequence *before* it can be
      triggered.
- [ ] **E2E-7.4** `/signin/?reason=expired` shows *"Your session expired — sign in to
      continue."*

---

## 8. Known-expected — do NOT report these as bugs

- **No biometric prompt / no key-protection choice screen.** Automated Chrome has no
  platform authenticator, so `isPrfAvailable()` is false and the flow auto-resolves to
  `"device"`. Correct behaviour.
- **`kvy keys approve` is a separate command** you must run by hand. Deliberate — the
  daemon sees key requests but never auto-approves, because silent approval would hand full
  read access to anyone with a stolen session.
- **A ~2s delay** before the requesting browser advances. It polls; the socket push is an
  optimisation, and a stale service-worker build may drop the new ephemeral entirely.
- **Two server unit tests fail** (`ntfy`, `telegram`) from an unrelated uncommitted edit to
  `app/push/channels/messageText.ts`. Not part of this work.
- **`db/seq.test.ts`** fails intermittently — it talks to real Neon and has a latency
  assertion.
- **`pnpm lint` reports an OOM warning.** The wrapper is broken in this environment;
  `./node_modules/.bin/biome check` works.

---

## 9. Report format

For each item: `PASS` / `FAIL` / `BLOCKED`, with evidence.

For every FAIL:

```
ID:        E2E-4.5
Severity:  CRITICAL | HIGH | MEDIUM | LOW
Expected:  <what the checklist says>
Observed:  <exact quoted text / status code / screenshot ref>
Repro:     <numbered steps>
Evidence:  <log line, response body, screenshot>
Suspect:   <file:line if you can point at it — optional, do not guess>
```

Finish with:

1. A pass/fail table across all sections.
2. Anything **BLOCKED** and precisely why.
3. The single most serious finding, stated plainly.
4. An explicit answer to: **did the three original complaints actually get fixed?**
   - `kvy claude` no longer shows a red error on first run
   - the pairing link no longer dead-ends on a confusing message
   - a web-first user with no CLI gets real onboarding
