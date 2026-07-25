# Review — `docs/auth-ux-hardening-plan.md`

**Reviewer stance:** independent, cold read. Every "current behavior" claim was re-verified
against the working tree (`v2-pty-injection`) as of this review; every piece of proposed code
was judged against the real surrounding source, not just for plausibility. No prior context
from the audit conversation.

---

## Verdict

The plan's *diagnosis* layer is excellent — every current-behavior quote I checked is accurate,
line numbers are almost all exact, and the three "audit-note corrections" are all genuine and
correct. Items 1, 5, 7, 9, 10, 12 are implementable as written. **But the centerpiece, item 2
(the OAuth step-up `/reset-keys/` flow), is broken as designed and cannot work at all** — not
in an edge case, in its primary path: after the OAuth redirect detour the page can never hold
an access token (the callback deliberately skips sign-in, the in-memory token is wiped by the
full-page redirects, and `silentRefresh` is structurally impossible in exactly the two states
the page exists to serve), so its `keys/bind` call is unreachable and every user dead-ends at
"You've been signed out." On top of that, its `bridge.getRefreshToken()` premise contradicts
the codebase's own F1 security invariant (the refresh token never crosses out of the worker),
and its state-guard excludes the `needs-unlock` state that "Forgot your PIN?" — the flow's
main entry point — arrives in. Since items 3 and 4 are explicitly sequenced behind item 2,
**the plan's three Critical items are all blocked on a redesign of item 2's session-handoff
mechanics. Do not implement as-is; revise item 2 first** (a concrete fix shape is given under
Problem 1). The rest of the plan can proceed, with the smaller corrections below.

---

## Verified accurate

All checked against current source; these are correct as quoted/cited:

- **Item 1:** `pair/page.tsx:64-74` gate (no `silentRefresh`), `session.ts:25-28,88-90`,
  `require-auth.tsx:66-78`. The proposed fix is correct and will work — when `bridgeStatus.kind
  === "ready"` the worker is unlocked, so `getSharedCryptoBridge()` is non-null and
  `silentRefresh()` has a token source. The `!identity` early-bounce split is right.
- **Item 2's server-side claims:** `StepUpProofSchema` (`keys.ts:63-70`), `verifyStepUp`
  (`keys.ts:82-108`, including the own-`auth_identities`-row match), the rotation gate
  (`keys.ts:191-205`), the other-sessions 409 interlock, the fence at `keys.ts:228-240`, web
  `StepUpProof`/`keysBind` (`api.ts:137-155`). "Nothing on the client ever constructs the
  `oauth` kind" — confirmed, only `rotateKeyEpoch`'s `{ kind: "password" }` exists.
- **Item 2's audit-note correction** that a fully proof-first ordering is impossible in one
  round trip is correct: `keys/bind` verifies step-up and the new-key signature in the same
  handler; there is no verify-step-up-only endpoint.
- **Item 3:** `config.ts:35` (web), `signin/page.tsx:88-116` (password link unflagged at
  93-100, dev bypass flagged at 106-115), server `config.ts:47` + `.refine()` at `170-173`,
  and the password routes are indeed unflagged (`password.ts:56,113,178,214` — all four line
  numbers exact). The `../../config.js` import path for `password.ts` is correct. Gating all
  four handlers (including reset) is the right scope.
- **Item 4:** `password/page.tsx:204-214` quoted verbatim, single unguarded destructive button
  confirmed. `Separator` exists (`components/ui/separator.tsx`).
- **Item 5:** `DevicesSection.tsx:73-94` (`handleRevoke`), `96-109` (`handleRevokeOthers`),
  `163-175` (row button) all exact. Proposed inline-confirm code is type-correct against the
  real component state.
- **Item 6:** `OAuthIdentity` (`auth/oauth.ts:18-22`), Google verifier ignoring email claims
  (`51-69`), GitHub `/user`-only with `scope=read:user` (`80-103`, `lib/oauth.ts:69` exact),
  email-less insert (`routes/oauth.ts:145-149`), columns on `auth_identities`
  (`schema.ts:60-61`). The §0 audit-note correction (columns live on `auth_identities`, not
  `accounts`) is right — `accounts` (schema:31-44) has no email columns. Google
  `email_verified === true` and GitHub `/user/emails` primary+verified handling are the
  correct verified-vs-unverified distinctions, and carrying `emailVerified` per-row preserves
  the ability to distrust unverified addresses downstream. The injectable-fetcher test shape
  matches the existing `fetchUser` pattern. No migration needed — confirmed.
- **Item 7:** `require-auth.tsx:14` (`SIGNIN_PATH`), `75-77` (silent redirect). The
  static-export caveat is real and the recommended `window.location.search`-in-effect approach
  correctly matches how the callbacks already do it (`google/page.tsx:13` reads
  `window.location.hash` directly).
- **Item 8:** `MachineRow` (`rows.ts:36-43`), `machine-presence` (`updates.ts:85-89`),
  `deriveMachineOnline` (`use-machine-presence.ts:55-62`), `status.ts:135`,
  `live-source.ts:371`, `tokenProvider.isDead`, `machineClient.ts:472-474` — all exact.
  The minimum-viable server-inferred design is feasible: `device_sessions` has both
  `clientKind` and a nullable `machineId` column (schema:90-92), so "most recent `cli-daemon`
  session for this machine is revoked" is a real query.
- **Item 9:** both leaked strings exist verbatim at `password/page.tsx:177` and `:238`, and a
  grep confirms they are the only JSX occurrences.
- **Item 10:** copy quoted accurately (`pin-setup-form.tsx:43-47`, `pin-unlock-form.tsx:37-39`).
- **Item 11:** `known-issues.md:14` row is `Open`; the body (~100-139) does still claim "no
  refresh-token mechanism at all" etc. All four "this is built" bullets check out against
  `tokenProvider.ts`, `machineClient.ts:388-415/465-475`, `device_sessions` +
  `DevicesSection`, and `require-auth.tsx:22`/`session.ts:102-113`.
- **Item 12:** `completePasswordSignIn` hardcodes `nextUrl: "/"` (`:123-130`),
  `completeOAuthSignIn:86-91` resumes the pair stash, sign-up hardcodes at `:112` — all exact.
  The caller-check caveat is accurate and load-bearing: `handleUnlockSubmit` really does
  `router.replace("/")` at `password/page.tsx:123`, so without threading `nextUrl` the fix is
  inert exactly as the plan warns.
- **Sequencing direction** (item 2 before item 3) is sound as a rule — see Problem 6 for a
  framing correction that actually makes item 2 *more* urgent than the plan states.

---

## Problems found

### 1. CRITICAL — Item 2's flow can never complete: `/reset-keys/` has no access token and no refresh token (plan §2b/§2c, `docs/auth-ux-hardening-plan.md:335-505`)

The proposed step-up branch in the callback (plan :482-500) **skips sign-in entirely** —
`completeOAuthSignIn` (the only thing that calls `register()` and `setToken()`) never runs.
Trace the real state at the moment `handleNewPin` (plan :381-405) executes:

- The in-memory access token (`session.ts:25-28`) was wiped by the two full-page navigations
  (app → provider → callback). Nothing has re-set it.
- `silentRefresh()` cannot save it: `getSharedCryptoBridge()` returns `null` unless the worker
  is *unlocked* (`use-crypto-bridge.ts:108-110`), and the page's two entry conditions are
  precisely `no-identity` (worker holds **no** refresh token at all) and `needs-unlock` (the
  wrapped refresh token can't be unwrapped — the user forgot the PIN; that's the premise).
- So `getToken()` is `null`, and the proposed code's own guard fires: *"You've been signed
  out. Please sign in again."* — for **every** user, on **every** path, deterministically.
  `keysChallenge`/`keysBind` (both `preHandler: app.authenticate`) are unreachable.
- Independently, `bridge.init(masterSecret, newPin, refreshToken)` needs a refresh token to
  PIN-wrap. In the password flow that token comes from `passwordLogin`'s response. Here there
  is none — see Problem 2.

The plan's own framing sentence gives the flaw away: §2b says the route "requires a live
session (this is post-login recovery — the user is authenticated...)". In both target
scenarios the user is **not** authenticated in the token sense and has no way to become so
without completing an OAuth sign-in — the very thing §2c skips.

**Concrete failure:** OAuth-only user forgets PIN → "Forgot your PIN?" → `/reset-keys/` →
Confirm with Google → returns with a valid proof → sets a new PIN → immediate "You've been
signed out." Loop forever. The flow that item 3 depends on ships broken, and if item 3 lands
anyway, password-identity users lose their working reset path too.

**Fix shape (for the revision):** in the callback's step-up branch, *complete the sign-in*
(`register({ oauthProvider, oauthProof })` → `setToken(token)`) **and** keep the proof for
step-up — the same `oauthProof` verifies fine twice (Google ID tokens are re-verifiable until
`exp`; GitHub access tokens re-verify via `/user`). Carry the fresh `refreshToken` and the
proof to `/reset-keys/` **in module-level memory, not `sessionStorage`**: the
`router.replace("/reset-keys/")` hop is an SPA navigation in the same JS context, so in-memory
state survives — which both closes the token gap and avoids parking a bearer credential (the
proof) and a refresh token in `sessionStorage` (see Problem 5). `rotateKeyEpochOAuth` then
takes `refreshToken` as a parameter exactly like the existing `rotateKeyEpoch` does — no new
bridge method needed.

### 2. CRITICAL — `bridge.getRefreshToken()` does not exist and *cannot* exist under the repo's own security invariant (plan :433, :473-474; real file `packages/web/src/crypto/client.ts`)

The plan flags the method name as an open assumption. Resolved: it is not a naming question —
the method is absent from `CryptoBridgeClient` (`client.ts:32-74`), and adding it would
violate the interface's stated F1 design: `refreshSession()`'s doc comment says the refresh
call happens *inside the worker* precisely so "the raw refresh token never crosses back out to
the main thread," and `api.ts:125-126` reiterates that nothing on the main thread is
authorized to hold it. A reviewer implementing the plan as written would either hit a compile
error or — worse — "fix" it by adding a worker RPC that exports the refresh token, quietly
undoing security-review finding F1. And even if it existed, the worker holds no recoverable
refresh token in either entry state (Problem 1). The fix in Problem 1 removes the need for it.

### 3. HIGH — Item 2's proposed page code doesn't type-check and locks out its primary entry state (plan :345-405)

Two concrete defects in the §2b sketch:

- `useUnlockedCryptoBridge()` only carries a `bridge` in the `ready` status
  (`use-unlocked-crypto-bridge.ts:11-18`); in `no-identity` and `needs-unlock` there is no
  `bridge` binding in scope. `handleNewPin` passes `bridge` to `rotateKeyEpochOAuth` after a
  guard that explicitly *allows* `no-identity` — under strict TS this doesn't compile; the
  page needs `useCryptoBridge()` (the raw client) instead, the way `password/page.tsx` and
  `oauth-callback-page.tsx` do.
- The guard `bridgeStatus.kind !== "ready" && bridgeStatus.kind !== "no-identity"` **excludes
  `needs-unlock`** — which is the state a "Forgot your PIN?" visitor (item 2d's repointed
  `require-auth.tsx:124` entry, the flow's single most important source) arrives in. That
  user's submit becomes a silent no-op.

### 4. HIGH — The "no key material orphaned in the worker" claim is false by the plan's own code (plan :375-378, :431-434, :544-545)

In the proposed `rotateKeyEpochOAuth`, `bridge.init(...)` still runs **before** `keysBind`. A
401 identity-mismatch (wrong Google account at the provider) therefore *does* leave the worker
init'ed — and, worse, `init` **persists** the new PIN-wrapped record to IndexedDB, overwriting
whatever was there — before the server has accepted anything. The genuine improvement the
reordering buys is narrower than claimed: a user who abandons at the provider never mutates
the worker (true), but the "What to verify" bullet "Wrong account at the provider → 401 → ...
no key material orphaned in the worker" is unachievable with this code and will fail its own
verification step. This matters most for the `needs-unlock` entrant: today their old wrapped
master secret is intact and a remembered PIN still recovers everything; after a 401-failed
reset attempt under this code, the old record is gone. (The existing password-path
`rotateKeyEpoch` has the same overwrite behavior — but it doesn't advertise the opposite.)
Either keep the honest framing ("only the abandonment case improves; a submitted-but-rejected
proof still orphans, same as today") or defer `init` until after a successful `keysBind` —
which requires holding the new masterSecret on the main thread briefly, a trade-off worth
stating explicitly.

### 5. MEDIUM — Stale step-up stash is a confused-deputy footgun and parks a bearer credential in `sessionStorage` (plan §2a/§2c, :277-333, :482-504)

- The outbound flag `{ provider }` has no TTL and no one-shot binding to a specific OAuth
  round trip. If the user starts a reset, abandons it, and later performs a **normal** sign-in
  from `/signin/` in the same tab, the callback's `peekPendingStepUp()` check fires, sign-in
  is silently skipped, and they are diverted into the destructive reset screen they never
  asked for — with the sign-in they *did* ask for swallowed. §2c also never checks
  `provider === pendingStepUp.provider`, so a Google-initiated step-up flag happily diverts a
  GitHub sign-in.
- On the return leg the plan stores the resolved `oauthProof` — a live bearer credential,
  replayable against `keys/bind` for up to ~1h (Google) — in `sessionStorage`. The
  callback→`/reset-keys/` hop is an SPA `router.replace` in the same JS context, so this
  persistence is unnecessary; module memory suffices (and the fix for Problem 1 needs the
  in-memory channel anyway, for the refresh token that must *never* be in `sessionStorage`).
- Minimal hardening for the revision: `consume` (not `peek`) in the callback, validate the
  provider matches, add a stash timestamp with a short TTL, and keep only the outbound flag in
  `sessionStorage`.

Not found: no CSRF/external-trigger vector — `sessionStorage` is same-origin/per-tab, a
malicious page cannot seed the stash, and the existing `state` check in
`consumeGoogleCallback`/`consumeGithubCallback` (which `resolveProof` runs before the step-up
branch) still guards the callback itself. The step-up proof's *server-side* replay window is a
pre-existing property of `verifyStepUp`, not introduced by this plan (see "Anything missing").

### 6. MEDIUM — The §0 sequencing rationale misstates today's baseline, and item 3 ignores existing production password accounts (plan :49-54, :554-674)

- **Framing correction:** an OAuth-only account has **no working reset path today either**,
  with or without item 3. The only rotate UI is `/password/`'s post-*password-login* step
  machine — an OAuth-only account cannot reach it (no password to log in with), and the only
  client-constructed proof is `{ kind: "password" }`, which `verifyStepUp` fails for them (no
  `passwordHash` row). Item 3 doesn't *create* the gap; it already exists. The sequencing rule
  ("2 before 3") remains correct — but for accounts holding *both* identity kinds — and item 2
  is actually *more* urgent than the plan claims: it fixes a live hole, not a future one. Also
  "bricked for encryption" is overstated: non-destructive pairing from another still-keyed
  device remains available; a full brick requires losing every device.
- **Migration gap:** if any production account ever registered via email+password (the current
  prod build offers it as a first-class path, which is the plan's whole premise), item 3's 404
  locks those accounts out entirely — login, reset, everything — with no linking or migration
  story. The plan should either assert "no production password accounts exist" as a checked
  precondition or add a migration note (e.g. OAuth-link-then-disable).
- Minor: the gated handlers return `reply.code(404)` on routes whose Zod response schemas
  declare only 200/400/401 — fastify serializes undeclared status codes through the default
  path so it works, but add `404: ErrorSchema` to keep the typed-response contract honest.

### 7. MEDIUM — Item 6 never delivers its own "display" goal, and sidesteps the schema's documented linking semantics (plan :876-1077; `schema.ts:46-49`)

- The stated motivation is "display + later analytics," but the plan adds **no** read path: no
  route returns the identity email to the client and no web surface renders it (verified —
  nothing under `packages/server/src/app/routes/` exposes it; `nav-user.tsx`/settings show
  nothing email-shaped for OAuth accounts). As written, item 6 is write-only storage. Fine if
  intentional — say so, or add the one-line `GET /v1/auth/me`-style field it implies.
- `auth_identities`' own schema comment (`schema.ts:46-49`) documents `emailVerified` as the
  gate for §5.4 **account-linking** ("an OAuth login only links to an existing password
  account when both sides are verified"). No linking is implemented anywhere today, and the
  plan's stance ("email is best-effort metadata, not an auth gate") is safe *now* precisely
  because `routes/oauth.ts` resolves accounts strictly by `(kind, subject)` — two providers
  reporting the same email just make two unlinked accounts, no takeover surface. But the plan
  should state this tension: the moment someone implements §5.4 linking on top of item 6's
  best-effort captured emails, the verified flag becomes security-load-bearing, and the
  backfill path (which happily stores a *changed* provider email only when the column is
  empty, never updating stale ones, never re-upgrading `emailVerified`) is not built to that
  standard.

### 8. LOW — Item 2's nested-pair promise is broken by its own hardcoded `nextUrl` (plan :527-533 vs :446)

The nesting note promises `/pair` → `/reset-keys/` → provider → rotate → "back toward
pairing," but `rotateKeyEpochOAuth` returns `nextUrl: "/"` unconditionally — the pending-pair
stash is never consumed, so the nested path strands the user on Home with the pairing silently
dropped (the exact bug item 12 fixes for the password path). Mirror
`completeOAuthSignIn:86-87`'s `consumePendingPair()` resolution here.

### 9. LOW — Item 11's rewrite violates `known-issues.md`'s own convention, and the plan misses that item 1 is already tracked there as issue #14

- `known-issues.md:28-29` states its own rule: *"remove its row from this table and its
  section below — don't mark it 'Fixed' and leave it here, per this file's own no-growing-
  archive convention."* The plan's proposed replacement body (a permanent "DONE (superseded)"
  entry) does exactly what the file forbids. The rewrite content is accurate; the disposition
  should be: delete row + section, and put the "what shipped / what remains" note in
  `issue-4-plan.md` or the new plan doc instead.
- `known-issues.md` issue #14 (line 24 and :505+) is precisely plan item 1, independently
  discovered, same root cause, same recommended fix — including a *second* recommendation the
  plan omits: a just-in-case `silentRefresh` retry inside `approve()` when `getToken()` comes
  back null (`pair/page.tsx:93-101`), which matters because `/pair` is outside `RequireAuth`'s
  60s re-check interval, so a user idling >15 min on the confirm screen hits "You've been
  signed out" with no recovery. Item 1 should adopt that retry and close issue #14 when it
  lands.

### 10. LOW — Citation errors (plan :1188-1199, :1228)

The wire-compat rule is cited as `schema.ts:14-20` — **`packages/wire/src/` has no
`schema.ts`** (verified by listing; the additive-only policy lives in `reserved.ts:22`,
`rpc.ts` comments, and design §5.3). Same wrong citation repeated in item 8's body. Everything
else in the appendix spot-checked accurate (a few one-to-four-line offsets of no consequence,
e.g. `keys.ts:195-205` → actually 191-205, `pin-setup-form.tsx:42-47` → 43-47).

---

## Resolved open questions

Things the plan flagged as uncertain that reading the real code settles:

1. **`bridge.getRefreshToken()`** (plan :473-474): does **not** exist on `CryptoBridgeClient`
   (`packages/web/src/crypto/client.ts:32-74`), and must not be added — the interface's F1
   contract keeps the raw refresh token worker-side (`refreshSession()` doc, and
   `api.ts:125-126`). The revision should pass the refresh token from the fresh `register()`
   response instead (Problem 1's fix shape).
2. **`AlertDialog` availability** (item 5, plan :860-863): not present —
   `packages/web/src/components/ui/` has `dialog.tsx` but no `alert-dialog.tsx`. The plan's
   fallback (inline confirm) is therefore the actual path; its conditional phrasing resolves
   cleanly.
3. **"WebSocket periodic re-validation" follow-up** (item 11, plan :1387-1390): **landed.**
   `packages/server/src/app/socket.ts` (~:168-196) implements the full §4.5b design: an expiry
   timer armed to the token's own `exp` that hard-disconnects at expiry, and a `renew-token`
   handler that re-verifies the token *and* re-checks `device_sessions.revokedAt` before
   re-arming. The rewritten known-issues note can state this as done rather than keeping it in
   follow-ups.
4. **`useSearchParams` static-export pattern** (item 7, plan :1131-1137): confirmed — the
   `(public)` callback routes read `window.location` directly in effects
   (`google/page.tsx:13`); no existing route uses `useSearchParams`, so the
   effect-reading-`window.location.search` variant is the one that matches conventions and
   avoids the Suspense-boundary build requirement.
5. **Item 8 server-inference feasibility**: `device_sessions` has both `clientKind`
   (`'cli-daemon'` among its values) and a nullable `machineId` column (`schema.ts:90-92`),
   so the minimum-viable "revoked recent `cli-daemon` session for this machine" query needs no
   schema change. The plan assumed but didn't verify this; it holds.

---

## Anything missing

Gaps in the audit's 12-item scope noticed while verifying the surrounding code — neither the
plan nor (apparently) the audit covers them:

1. **Returning OAuth user on a fresh browser hits a raw 409 dead-end — even after item 2.**
   `completeOAuthSignIn`'s new-identity path always calls `keysBind` *without* `rotate`
   (`complete-oauth-sign-in.ts:74-84`); for an account whose keys are already bound elsewhere,
   the server answers `409 "Key mismatch; rotation must be explicit"` (`keys.ts:191-193`),
   surfaced by the callback as a generic "Sign-in failed. Please try again."
   (`oauth-callback-page.tsx:89-93` / `handlePinSetup:107-110`) — after the user was already
   made to set a PIN that is now orphaned. This is the OAuth twin of `/password/`'s
   `needs-rotate` branch, and item 2's entry points (`RequireAuth`, `/pair`, forgot-PIN) never
   catch it because this user came in through `/signin/` → callback. The callback's `set-pin`
   branch should detect the 409 and offer `/pair/` (primary) or `/reset-keys/` — otherwise
   OAuth-only login on a second browser stays broken in the most common "new laptop" path.
2. **Step-up proof replay window.** `verifyStepUp` accepts any currently-valid provider proof
   for a matching identity; Google ID tokens stay verifiable until `exp` (~1h) and the `nonce`
   the web flow already sends (`lib/oauth.ts:54`) is never checked server-side (the code
   comments admit this). An attacker holding a victim's access token *and* a captured recent
   ID token can execute the destructive rotation. Binding the step-up to a fresh
   server-challenged nonce (echoed through the OIDC `nonce` claim) would close it. Pre-existing
   server design, but a key-destroying step-up is exactly where the audit should have looked.
3. **Rotate outcome routing on `/password/` drops pending-pair too.** Item 12 fixes
   `completePasswordSignIn`/`SignUp`, but `rotateKeyEpoch` (and the plan's own
   `rotateKeyEpochOAuth`) hardcode `nextUrl: "/"` — the third sibling with the same bug
   (Problem 8 covers the new code; the existing `rotateKeyEpoch` deserves the same one-liner).
4. **`/password/` sign-up UX pre-gates nothing** — `mode === "signup"` renders the PIN form
   immediately alongside email/password with no awareness that item 3 will hide the whole
   page; fine, but if the "keep password for self-hosters" alternative flag
   (`FALCON_PASSWORD_AUTH`) is ever chosen, the web gate in item 3a must key off the mirrored
   flag, not `DEV_AUTH_ENABLED` — the plan's alternative paragraph says this correctly; just
   don't let the two halves ship mismatched.

None of these block the plan's viable items; #1 is worth promoting into the item-2 revision
since it shares all of that item's infrastructure.
