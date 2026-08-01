# Review of `auth-ux-overhaul-fix-plan.md`

Independent verification of the fix plan against the working tree as of this review
(branch `main`, post-`0b245dd`). Every file the plan cites was re-opened and every
load-bearing claim re-derived from source — nothing below is taken from the plan on trust.

**Scorecard: 5 SOUND · 5 MOSTLY SOUND · 1 PROBLEMATIC.**

| # | Fix | Grade |
|---|---|---|
| 1 | Migrations on boot | **SOUND** |
| 2 | Worker `API_URL` / refresh outcome | **MOSTLY SOUND** — call-site enumeration wrong; two secondary claims false |
| 3 | CLI re-pair on dead token | **SOUND** |
| 4 | Account-bound key material | **MOSTLY SOUND** — OAuth sign-in path omitted entirely |
| 5 | Logout deletes databases | **SOUND** |
| 6 | Transcript backfill gate | **MOSTLY SOUND** — one semantic edge vs FR-9.1 |
| 7 | Key request reaches the terminal | **MOSTLY SOUND** — facts right, fix under-specified |
| 8 | `/password/` default mode | **PROBLEMATIC** — diff as written breaks the static build |
| 9 | "One more step" copy | **SOUND** |
| 10 | `/pair/` dead end | **SOUND** |
| 11 | Swallowed first click | **MOSTLY SOUND** — hypothesis 2 self-contradictory |

---

## Fix 1 — Migrations must apply on boot, or fail loudly — **SOUND**

Everything re-verified:

- `packages/server/src/db/migrate.ts` is 41 lines; the blocking lock is at :33 and the
  unlock at :36 — the plan's correction of the E2E report's `:20-31` citation is right.
- `packages/server/drizzle/meta/_journal.json` has 8 entries (verified by parsing it).
- `src/main.ts:9` awaits `runMigrations()` before `buildServer()`, with the top-level
  `.catch` → `process.exit(1)` — so a thrown failure is loud, a silent no-op is not.
  The plan's framing ("verify-and-throw is the change that would have caught S1
  regardless of which pooler theory is right") is exactly correct, and honest about not
  confirming the pooler mechanism.
- `config.ts:34` (`DATABASE_URL`) and `:198` (`OPTIONAL_ENV_KEYS`) are where the plan
  says; adding `DATABASE_URL_UNPOOLED` to both is the right shape and matches the
  existing empty-string-is-unset convention.

Two footnotes, neither blocking:

1. The `pg_try_advisory_lock` still travels through the same (possibly pooled) client,
   so under the pooler hypothesis the lock is decorative there too — but the plan never
   claims otherwise; the verification step is what carries the guarantee. Fine.
2. One oddity the plan (rightly) doesn't try to explain: the E2E report says the manual
   `db:migrate` run *returned* without applying anything — a blocking `pg_advisory_lock`
   would be expected to *hang*, not return. That mildly undercuts the lock-leak theory,
   and mildly strengthens the plan's decision to make the fix mechanism-independent.

Test plan (new `migrate.test.ts`, config empty-string case, live pooled/unpooled check)
is proportionate; the "throws when count < journal" case genuinely is the S1 regression
test.

## Fix 2 — The crypto worker's `API_URL` is empty — **MOSTLY SOUND**

### Root cause: confirmed, mechanically

This is the plan's strongest section and the E2E report's hypothesis (React
effect-ordering race) is indeed replaced by something better-evidenced:

- `packages/web/scripts/build-worker.mjs:65` is exactly
  `"process.env.NEXT_PUBLIC_API_URL": JSON.stringify(process.env.NEXT_PUBLIC_API_URL ?? "")`.
- `packages/web/src/lib/config.ts:15` is `process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3005"` —
  `??` does not fire on `""`, so the define defeats the fallback. Correct.
- **The shipped artifact in this working tree confirms it live:** `rg -o 'DC="[^"]*"'
  packages/web/public/crypto-worker.js` → `DC=""` right now.
- `packages/web` has no `.env*` file (verified), `public/crypto-worker.js` is gitignored
  (`.gitignore:26`, verified), and both `dev` and `build` scripts rebuild it
  (`packages/web/package.json:8-9`).
- `worker-handler.ts:426-447` (`refreshSession` case), `protocol.ts:233`,
  `client.ts:74/:159`, `session.ts:102-113`, `require-auth.tsx:48-68` all match the
  plan's "before" text verbatim. The prod-unaffected claim checks out too
  (`deploy/web.Dockerfile:46`, `ENV NEXT_PUBLIC_API_URL=$API_ORIGIN`).

### Where the plan is wrong or incomplete

1. **"Call sites of `silentRefresh()` are only two" is false.** There are four, plus a
   type dependency:
   - `features/auth/require-auth.tsx:56` — handled by the plan.
   - `app/(public)/pair/page.tsx:109` — handled by the plan.
   - **`app/(public)/pair/page.tsx:66`** — `if (!isSignedIn() && !(await silentRefresh()))`,
     the page's identity gate. Under the tri-state, `"unreachable"` is truthy, so an
     offline visitor is treated as *signed in*, skips `stashPendingPair` + the
     `/signin/` redirect, and falls through to `fetchPairDetails` with no token. This is
     the same silent-meaning-change hazard the plan flags for :109, on the line 43
     lines above the one it flagged. Must become `=== "ok"` in the same commit.
   - **`sync/index.ts:36`** — `renewAccessToken()` for the socket:
     `const refreshed = await silentRefresh(); return refreshed ? getToken() : null;`.
     `"unreachable"` truthy → returns a stale-or-null token instead of `null`. The plan
     only says "confirm with a grep before landing" about `apiSocket.ts`; the caller is
     real and needs the `=== "ok"` treatment (or a deliberate decision that a stale
     token retry is acceptable — either way, it must be addressed, not discovered).
   - **`app/(public)/pair/pair-gate.ts:17`** types its dep as
     `silentRefresh: () => Promise<boolean>`. Passing the new function fails typecheck
     (good — compiler catches it), but the module and `pair-gate.test.ts` need updating
     and the plan never mentions them.

2. **The "OfflineBanner already covers `unreachable`" claim is wrong.**
   `app/(protected)/layout.tsx:17-22` mounts `OfflineBanner` *inside* `<RequireAuth>`.
   In the new `"unreachable"` state, `RequireAuth` keeps `sessionReady === false` and
   returns `null` (require-auth.tsx:70) — so the banner never renders and an offline
   cold load is an indefinite blank page with a silent 60-second retry. Still better
   than today's spurious sign-out, but the plan's stated reason for rejecting a visible
   "reconnecting" state rests on a false premise. Recommend: render *something* in the
   unreachable state (or move the banner outside the gate).

3. **The build-script assertion regex is close to a no-op.** In the minified bundle the
   URL is runtime-concatenated (`fetch(`${DC}/v1/auth/refresh`)`), so the first
   alternation (`https?:\/\/[^"'`]+\/v1\/auth\/refresh`) can never match even in a
   *good* build; all the work is done by the second (`["'`]https?:\/\//`), which passes
   if *any* absolute-URL string literal exists anywhere in the bundle, for any reason.
   Cheaper and strict: the script knows the expected base
   (`process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3005"`) — assert the emitted
   file contains exactly `JSON.stringify(expectedBase)`.

4. Minor: the plan says the existing worker-handler test
   "`refreshSession` works in a fresh worker with no key material … needs its assertion
   updated". No such test exists — `rg refreshSession
   packages/web/src/crypto/__tests__/worker-handler.test.ts` → zero matches (the matrix
   entry in the overhaul plan was never implemented). Nothing to update; the new cases
   the plan proposes are still the right ones.

The parts it does cover are accurate to the line: the three `session.test.ts` case names
exist verbatim (:154/:166/:177), and `require-auth.test.ts:61` really does grep for
`const refreshed = await silentRefresh(`.

**Verdict:** right root cause, right two-part fix, but the blast-radius section must be
redone against the real call-site list before implementation.

## Fix 3 — A dead refresh token must trigger a real re-pair — **SOUND**

Every claim verified, including the two the plan added beyond the E2E report:

- `auth/login.ts:77` — `if (readCredentials(homeDir)) return { ok: true };` is
  `ensureLoggedIn`'s first statement (73-87). `readCredentials`
  (`auth/credentials.ts:81-90`) is a pure disk read; `clearCredentials` (:107-110)
  exists, exported, sole caller `auth/logout.ts`.
- `startPreflight.ts:111` — the dep type really is looser than the real function
  (`Promise<{ ok: boolean; message?: string }>`); :132-135 (RECONNECTING → injected
  `ensureLoggedIn` → `auth.message ?? NO_TTY_CANNOT_SIGN_IN`); :141 `reloadDaemonAuth`;
  :143-146 second preflight and hard-fail. The `??`-vs-`||` inconsistency with
  `ensureCredentials.ts:23` (which uses `||`) is real and the one-line alignment is
  correct.
- **Three call sites, confirmed:** `index.ts:348` (`runStart`),
  `ensureCredentials.ts:22` (used by `keysApprove.ts`), and the injected
  `startPreflight.ts:133` (wired from `start.ts:425` and `startCodex.ts:143` via
  `typeof ensureLoggedInDefault`, which absorbs the new optional parameter with no
  edits). The double-round-trip / premature-QR argument for opt-in `force` is valid.
- The `runAuthLogin`-ignores-`homeDir` latent bug is real: `login.ts:138`
  (`wrapNewKeyMaterial(..., resolveHomeDir())`) and `:143`
  (`writeCredentials(credentials)` — the second parameter exists,
  `credentials.ts:93-95`, and is simply not passed).
- Test claims verified: `login.test.ts`'s `vi.mock("./credentials.js")` factory stubs
  only `writeCredentials`/`readCredentials` (must gain `clearCredentials`, as stated);
  the `toEqual({ok:false, message:""})` exact-equality case exists; and
  `startPreflight.test.ts`'s dead-token test really does stub `ensureLoggedIn` with an
  unconditional `paired = true` fake — the plan's diagnosis that this stub masked the
  bug is accurate, and the proposed replacement (a stub that consults `readCredentials`
  and only re-pairs on `force`) is the correct hardening.

One implementation nit: the proposed `login.ts` diff calls `clearCredentials(homeDir)`
but does not add it to the file's import from `./credentials.js` (currently only
`readCredentials, writeCredentials` — login.ts:28). Trivial; the compiler will catch it.

The Ctrl-C-safety ordering (delete only after the TTY check, immediately before
`runAuthLogin`) and the rejected alternatives are all well-reasoned. Ship as written
plus the import.

## Fix 4 — Key material must be bound to the account it belongs to — **MOSTLY SOUND**

### The two high-risk re-derivations both check out

- **The server 409 refutation is verbatim correct.**
  `packages/server/src/app/routes/keys.ts:207-214` is exactly the quoted conflict check
  (`accounts.signPublicKey = X AND accounts.id != me` → 409 "Key already bound to
  another account"), and `password/page.tsx` catches a 409 from sign-up and converts it
  to `needs-keys` (the catch block after `completePasswordSignUp`). So the E2E-feared
  "silent cross-account bind" indeed cannot happen against a live account, and the plan's
  residual-hole framing (deleted account, or a key rotated away by `/reset-keys/` — the
  conflict check only sees *current* `signPublicKey`) is accurate.
- **The `isNewIdentity`-is-backwards argument is correct.**
  `complete-password-sign-in.ts:85-93` returns `{kind:"existing-account"}` early
  whenever `passwordRegister` blanks the tokens, so line 96 onward only ever runs for a
  genuinely new account — and a genuinely new account can never legitimately have key
  material on this browser. The reuse branch (:96-113) can only ever be wrong. Deleting
  it is right.

The storage/worker claims are also verified: `key-storage.ts:28-38` has no account
field, `RECORD_KEY = "keyRecord"` at :67, `worker-handler.ts:290-307` (`getIdentity`)
has no account check, and `getAccountId()` exists at `lib/session.ts:69-74`. The
`useCryptoBridgeStatus` cold-load timing argument matches the real hook
(`use-crypto-bridge-status.ts:35-58`). The adoption-not-strict migration policy is a
defensible, honestly-argued trade.

### The significant gap: the OAuth path has the same bug and is not in the plan

`lib/complete-oauth-sign-in.ts:56-62` is a byte-for-byte sibling of the pattern this fix
exists to kill:

```ts
let identity = await bridge.getIdentity();
const isNewIdentity = !identity;
if (!identity) { … bridge.init(masterSecret, refreshToken, protection); … }
```

and `components/auth/oauth-callback-page.tsx:82` does a bare `bridge.getIdentity()` the
same way `password/page.tsx:57` does. Neither file appears anywhere in Fix 4's affected
files, diffs, tests, or blast radius. Consequences:

- Since `belongsTo()` is deliberately permissive when the caller passes no `accountId`,
  the OAuth flow keeps today's exact cross-account behaviour after the fix lands:
  signing in with Google as account B on a browser holding account A's keys still gets
  `isNewIdentity = false`, skips both `init` and `bind`, and produces a worker loaded
  with A's key tree silently failing `setSessionKey` for all of B's sessions — failure
  mode (a), verbatim, on the flow that (unlike `/password/`, which per its own header
  "404s in production") is the **production** sign-in path.
- Note the OAuth reuse branch is *not* simply deletable the way the password one is:
  OAuth `register` is find-or-create, so same-account re-sign-in on a browser that
  already holds that account's keys is a legitimate reuse. The correct change there is
  to thread the account id (`getIdentity(decodeAccountId(token))`) so reuse survives for
  the same account and a foreign record reads as absent — plus handling for the
  existing-account-with-bound-keys-elsewhere case (blind `init` + non-rotate `keysBind`
  will 409 "Key mismatch; rotation must be explicit", keys.ts:191-193, which needs a
  `needs-keys` conversion like the password page has).

Also worth stating more precisely than the plan does: "`ensureLoaded` refuses a foreign
record outright (so the worker can never operate under the wrong key tree)" only holds
for account-aware entry points. The worker's *internal* `ensureLoaded()` calls
(`setSessionKey` :246, `bindKeysProof` :310, `sealForPeer`) have no account id to pass,
so the in-worker enforcement is only as strong as the main-thread gating that precedes
those calls. That's acceptable, but the sentence overclaims.

**Verdict:** correct analysis, correct mechanism, one production-path caller missing.
Add `complete-oauth-sign-in.ts` + `oauth-callback-page.tsx` to the fix (and its tests)
before implementation; without them the fix's own title is not satisfied.

## Fix 5 — Logout must delete the databases, not just empty them — **SOUND**

All claims re-verified:

- Both `clear()`s delete one record key; `deleteDatabase` appears nowhere in
  `packages/web` (repo grep). Both modules open/close a fresh connection per operation
  (`key-storage.ts:85-122`, `session-storage.ts` same shape) — the enabling fact for
  worker-side deletion holds.
- `logout()` (`lib/logout.ts:43-55`) awaits a throwaway bridge's `clear()` then
  terminates it; the shared-singleton residue is real
  (`use-crypto-bridge.ts:21-52`, `RELEASE_GRACE_MS = 2000`, and `logout()` touches
  neither `release` nor the singleton) — the plan's "step 0: terminate shared bridge
  first, or it can re-create the DB we just deleted" addition is a genuine catch the E2E
  report didn't have.
- Both logout callers navigate immediately after (`components/nav-user.tsx:45`,
  `features/settings/components/DevicesSection.tsx:112`), and
  `logout.test.ts` really asserts `["wipe","disconnect","clear"]` (:18), so the test
  update is described accurately.
- `terminateSharedCryptoBridge()` is safe against stale `release()` calls: `release`
  early-returns when `sharedBridge !== instance`, so a mounted component unmounting
  after termination cannot double-free.

The `onblocked → resolve` posture (never fail logout because a second tab is open) is
right, and the fake-indexeddb restraint ("add it only if the interface test proves
insufficient") is the correct call for a package with a node-only vitest environment.

## Fix 6 — Stop backfilling transcripts that predate Kvy — **MOSTLY SOUND**

Code claims all verified:

- `claude/scanner.ts:117-125` — `getProjectPath` reads `CLAUDE_CONFIG_DIR || ~/.claude`,
  no `home.ts` import.
- `transcriptIndexer.ts` — `RegisteredWorkspace {workspaceId, path}` (~:60-64),
  `isManaged: () => false` default, `scanExisting` schedules every `.jsonl` from a bare
  `readdir` and is re-run by the watcher's ready hook, `processFile` already has
  `mtimeMs` in hand from a parallel `stat` feeding the `lastActivity` fallback, and
  `computeRunning` already stats every `.jsonl` — so both "zero extra I/O" claims hold.
- **The adapter really does structurally drop `registeredAt`**
  (`workspace/adapters.ts:50-51`), and the registry sets it once and never mutates it
  (`registry.ts:220-231`, type at :57). The plan's "missing link nobody cited" is real.
- Test-compat claims verified: `baseWorkspace()` (`transcriptIndexer.test.ts:95-97`)
  has no timestamp (so optional keeps all fixtures compiling), and the :177-196 case
  writes both files at test time (fresh mtime), so it survives the gate as claimed.

One semantic concern the plan under-weighs: the gate's own justifying sentence — "a
transcript whose file has not been touched since Kvy started watching this workspace
is, by definition, not the session the user just left" — is not true at **first
registration**. FR-9.1's canonical entry path (kvy-prd.md:221: run plain `claude`,
work, *then* reach for Kvy) means the user's just-exited plain session has
`mtime < registeredAt` by minutes, and is now filtered out of the very surface built to
capture it. A *still-running* plain session survives (its next write re-triggers the
watcher with a fresh mtime), and the plan's failure-mode analysis ("under-indexing is
recoverable — touch the file / send a message") is honest, so this is not disqualifying
— but the fix should either (a) add a small grace window at first registration
(e.g. `registeredAt - N minutes`), or (b) explicitly document that the just-exited-
before-first-run case is deliberately excluded and `kvy adopt`/resume is the answer.
Right now the plan asserts the exclusion can't happen, which is the one part of this
section that doesn't survive contact with the PRD scenario it quotes.

The residue honesty (11 stranded rows, no dismiss affordance —
`unmanaged-session-card.tsx` verified to have only View/Take over) and the rejected
alternatives are all accurate.

## Fix 7 — A key request must reach the person at the terminal — **MOSTLY SOUND**

The load-bearing discovery is verified and is a genuinely good find:

- `eventRouter.ts:118` — **every** connection joins `user:${accountId}` regardless of
  type, and `all-user-authenticated-connections` routes to exactly that room (:238-240).
- `session/sessionClient.ts` registers exactly three socket handlers (`connect`,
  `connect_error`, `disconnect`) — no `"ephemeral"`. So the running `kvy claude`
  process really does receive and discard the event today; no new transport needed.
- `machineClient.ts:457-468` (log-only handler, AX-4.17 comment), `logger.ts:5-19`
  (stdout prohibition), `ptyClaudeSession.ts:582/592-593` (pty spawn + byte relay),
  `keysApprove.ts:46-50` (`verificationCode` mirror), :62-70 (`defaultConfirm` readline)
  — all as cited.

Why not SOUND: this is the least implementation-ready section. The post-exit approve
flow ("extract a reusable `runKeysApprove`", surface through `ptyClaudeSession`, wire in
`start.ts`) is described but not diffed, and it touches the most delicate part of the
CLI (raw-mode teardown ordering, both providers' exit paths). Two small technical notes
the plan omits: (1) an OSC 9 write interleaved between two pty output chunks can, in
principle, land mid-escape-sequence of the provider's own output — one more reason the
"verify live on Terminal.app / iTerm2 / tmux before enabling by default" gate it already
imposes is mandatory, not optional; (2) codex sessions go through `startCodex.ts` — the
"seen a key request during the session" bookkeeping needs to live somewhere both
providers share, or the feature silently applies to claude only. Neither invalidates the
approach; both belong in the implementation notes.

The rejected-alternatives table (no TUI painting, no daemon→session channel — confirmed:
`controlServer.ts` is inbound-only — no new deps) is accurate and well-argued.

## Fix 8 — `/password/` must not default to sign-up — **PROBLEMATIC**

The diagnosis is fully verified: `password/page.tsx` has the unconditional
`useState<Mode>("signup")`, no query/param/storage read, the signup-mode
`handleSubmit` short-circuit into `choose-protection` without an API call, the two
`setMode` sites, `signin/page.tsx:131`'s bare `router.push("/password/")` with both
test literals at `signin/page.test.ts:35`/`:44`, and `peekPendingPair`'s non-consuming
contract. The choice of `peekPendingPair` over a query param is right, and the
`peek`-vs-`consume` hazard note is exactly the right warning.

**But the proposed one-line diff breaks the build, and the plan's safety argument for it
is factually false.** The plan says the lazy initializer "is inert during the static
prerender because `peekPendingPair` guards on `typeof window`." It does not:

```ts
// lib/pending-pair.ts:18-20 — no guard of any kind
export function peekPendingPair(): string | null {
  return window.sessionStorage.getItem(PENDING_PAIR_KEY);
}
```

A `useState` lazy initializer runs during the server-side render. This package is a
static export (`next.config.ts` gates `output: "export"` on the build phase), so
`next build` prerenders `/password/` — `window` is undefined there, the initializer
throws `ReferenceError`, and the build fails. (In `next dev` it throws during the dev
server's SSR pass instead.) The existing call sites are safe only because they run
inside `useEffect` (`signin/page.tsx:36`) or post-interaction (`pair/page.tsx:68`).

The repair is small — either:

- add a guard inside `pending-pair.ts` (`if (typeof window === "undefined") return null;`
  — arguably the right fix, since it makes the whole module prerender-safe), or
- guard at the call site:
  `useState<Mode>(() => (typeof window !== "undefined" && peekPendingPair() ? "signin" : "signup"))`.

Note the guarded-initializer form runs with `"signup"` on the server-rendered HTML and
`"signin"` on the client's first render when a pair is pending — a hydration mismatch
warning in React. Given this page is client-gated and dev-only, that's tolerable, but
the *cleanest* shape is the `useEffect`-set-mode variant (one extra render, no
mismatch). Either way: the plan's diff must not land as written, and its proposed
source-text test (assert `peekPendingPair()` appears in the initializer) would happily
pass on the broken version — add a build (`pnpm --filter @kvy/web build`) to the
acceptance criteria for this fix.

Graded PROBLEMATIC not for direction (which is right) but because the exact diff ships a
build-breaking bug on the back of a false claim about the code — the precise failure
class this review exists to catch.

## Fix 9 — "One more step" must say what will happen next — **SOUND**

All constraints re-verified against `lib/copy.ts` and `lib/__tests__/copy.test.ts`:

- `needKeysTitle`/`needKeysBody` at copy.ts:34-36; `codeMismatch` exists and is rendered
  only by the approver (`key-request-listener.tsx:119`) — the requester really has no
  mismatch line.
- The test walks the copy object (invoking functions with `"Sample"`), bans
  `/key material|masterSecret|keyEpoch|epoch|DEK|custody|bridge|ephPub/i`, and pins
  `needKeysBody` to not start with "run" — all four assertions exactly as described.
  The proposed strings pass all of them (checked by hand: no banned substring, no
  leading "run", `codeMismatchRequester` matches `/code/i`).
- The `starting` phase truly renders nothing today (`request-keys-panel.tsx` renders
  `waiting` at :110; `starting` has no branch), and the inline
  `Run <code>kvy keys approve</code>…` JSX at :128-129 is indeed the one user-facing
  string the copy test cannot see. Moving it into `copy.ts` is the right call.

Copy quality is good, the loader for the `starting` phase closes a real blank-first-
paint, and the risk section ("run the copy test before assuming a sentence is safe") is
the correct level of caution. No corrections.

## Fix 10 — The `/pair/` key-fetch detour is a dead end — **SOUND**

The severity upgrade is justified and the state machine is exactly as the plan quotes:

- `pair/page.tsx:93-98` — the effect demotes `confirm → needs-keys` and has **no**
  inverse; `:130-136` renders `RequestKeysPanel onReady={() => void refresh()}` — and
  `refresh()` only moves `bridgeStatus`, never `gate`. Once the keys arrive the page
  re-renders `needs-keys` forever. Functional dead end confirmed; the CLI is left
  polling. The contrast with the other two call sites is also accurate
  (`password/page.tsx` navigates via `router.replace(status.nextUrl)`;
  `require-auth.tsx:95-101` needs only `refresh()` because `status` *is* the render
  condition).
- The proposed two-way effect is correctly guarded on the *current* gate kind in both
  arms, which prevents the flicker-bounce it warns about; preserving `ephPub` through
  the round trip is handled; and the plan honestly notes the `confirm` variant needs
  `label/cwd/requestedAt` hoisted into their own state rather than smuggled through
  `needs-keys` — which matches the real `Gate` union (:16-29).
- The `onReadyRef` trap is real (`request-keys-panel.tsx:35-42`, docstring records the
  fresh-request-per-render incident) and the "do not add `context` to any effect deps"
  warning is exactly right. The optional `context` prop is additive across the three
  call sites (verified: pair :133, password needs-keys branch, require-auth :98).
- Test guidance matches this package's real conventions — `pair/page.test.ts` and
  `pair-gate.test.ts` exist, and the extract-a-pure-`nextGate()` suggestion mirrors
  `signin-gate.test.ts`/`devices-revoke-state.test.ts`, which do exist.

One small addition for the implementer: after this fix, consider whether the *promoted*
`confirm` should re-fetch pair details rather than reuse stashed ones — the pairing
request may have expired during the key fetch (CLI polls have a TTL), and re-entering
`confirm` against an expired `ephPub` will surface as an approval error. Reusing the
stash and letting the error state handle it (as today's `error → confirm` retry does at
:198-216) is acceptable; just don't add a silent success path.

## Fix 11 — First click after load is swallowed — **MOSTLY SOUND**

The two confirmed sub-fixes are verified and correct:

- `pair/page.tsx:100-101` — `approve()` silently returns unless
  `bridgeStatus.kind === "ready"`, while the Approve button (:169) is enabled. Literal
  swallowed click, on the most important button in the flow. `disabled` + pending label
  is the right fix and matches `password/page.tsx`'s existing
  `disabled={status.kind === "pending" || !bridge}` pattern (verified).
- `key-request-listener.tsx:81` — same shape (`if (!token || !bridge) return;`).

The environment facts spot-checked all hold (`next.config.ts` phase-gated `output:
"export"`; the SRI/Vercel blank-page history in its comments; button component with no
default `type`). One internal inconsistency to fix before anyone spends time on it:

**Hypothesis 2 (pre-hydration native GET submit leaking credentials into the URL) is
contradicted by the plan's own hypothesis 3.** The `/password/` submit button is
rendered `disabled` in the prerendered HTML (`!bridge` is true until hydration + worker
acquisition — the plan itself says so under H3: "dead but visibly disabled"). A disabled
submit button can't be clicked, and HTML implicit submission (Enter in a field) does
nothing when the form's default button is disabled. So the pre-hydration native-submit
window effectively doesn't exist on this form, and the "security finding in its own
right" framing overstates it. Keep the URL-bar check in the diagnostic script if it's
free, but demote H2 below H3; H1 (stuck Radix body lock) deservedly stays first — it is
the only listed mechanism that explains the account-menu button also failing.

Sub-fixes: land now, as the plan says. The diagnosis plan is otherwise sensible and
correctly scoped as read-only.

---

## Sequencing and scope — verified

The 1→11 order contains no forward dependencies: Fix 4's dependence on Fix 2
(`getAccountId()` needs a cold-load token, which needs a working refresh) is real and
correctly ordered; Fix 3 is genuinely independent of Fix 2 in code; Fix 10's reuse of
Fix 9's copy tokens is real; Fixes 1 and 6 are isolated. Landing 4 and 5 adjacent for
one `key-storage.ts` review pass is sensible. The "no `@kvy/wire` changes, no schema
migrations" claim was checked and holds — both protocol changes (Fix 2's
`RefreshOutcome`, Fix 4's account ids) live entirely in `packages/web/src/crypto`'s
main-thread↔worker protocol, which ships as one bundle pair.

One sequencing addendum from this review: the Fix 4 correction (OAuth path) belongs *in*
Fix 4's PR, not a follow-up — shipping Fix 4 without it produces a release where the
password path (dev-only) is protected and the production sign-in path is not, which is
worse than the current uniform behaviour from an auditing standpoint.

## Overall verdict

**Needs one corrective pass before implementation — but a narrow one.** This is an
unusually well-verified plan: of the three sections where it overruled the E2E report's
root cause (2, 4, 10), all three re-derivations are correct, and two of them
(the `DC=""` bundle proof; the `/pair/` gate dead end) are verifiable to the exact line
in the current tree. Fixes 1, 3, 5, 9, 10 can be handed to an implementer as-is.

The corrective pass must cover, in order of importance:

1. **Fix 8**: the diff breaks `next build` — `peekPendingPair` has no `typeof window`
   guard, contrary to the plan's claim. Add the guard (preferably in `pending-pair.ts`)
   and add a build run to the fix's acceptance criteria.
2. **Fix 4**: add `lib/complete-oauth-sign-in.ts` and
   `components/auth/oauth-callback-page.tsx` — the production sign-in path has the same
   `getIdentity()` reuse bug and is currently absent from the plan.
3. **Fix 2**: redo the `silentRefresh` blast radius against the real four call sites
   (add `pair/page.tsx:66`, `sync/index.ts:36`, and `pair-gate.ts`'s dep type); fix the
   false OfflineBanner claim (it mounts *inside* `RequireAuth` and can't render in the
   `unreachable` state — decide what the user sees there); replace the over-broad build
   assertion regex with an exact-expected-base check.
4. **Fix 6**: decide the first-registration edge (grace window vs. documented exclusion)
   rather than asserting it away.
5. **Fix 11**: demote hypothesis 2 (contradicted by the plan's own H3 observation).

Nothing in the pass changes the plan's architecture, ordering, or scope estimate
materially; it is call-site completeness and two factual corrections, not redesign.
