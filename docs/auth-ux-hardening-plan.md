# Auth UX hardening plan

**Status:** proposed (implementation plan) — code-grounded against `v2-pty-injection`.
**Builds on:** [`docs/issue-4-plan.md`](./issue-4-plan.md) (identity ↔ key-custody split, refresh
tokens, `keys/bind` fenced rotation, device sessions).
**Scope:** `@falcon/web` (most items), `@falcon/server` (`auth/oauth.ts`, `config.ts`, OAuth
register route), `@falcon/wire` + `falcon` CLI (item 8 only), docs (items 11).

This document is the implementation/fix plan produced from a UX/security audit of Falcon's auth
flow after the issue-4 re-architecture landed. It follows the same section shape and rigour as
`docs/issue-4-plan.md` and `docs/plan-flows-3-4-5.md`: one numbered phase per audit finding,
each with the **current behavior** (real code quoted, `file:line`), the **problem**, the
**proposed fix** (real proposed TypeScript matching this repo's conventions — strict null
checks, no `any`, Zod discriminated unions the way `keys.ts`/`api.ts` already do it, no
unnecessary comments), any **new files/routes/env vars**, and **what to verify**.

**Every code quote below was read fresh from current source**, not paraphrased from the audit
notes. Places where the real code diverged from the audit notes are called out inline as
**Audit-note correction**.

> **Revision note (post-review).** An independent cold review
> ([`docs/auth-ux-hardening-plan-review.md`](./auth-ux-hardening-plan-review.md)) found that
> **item 2's original session-handoff design could never complete** — the OAuth step-up branch
> skipped sign-in entirely, so `/reset-keys/` held no access token and every `keys/bind` call
> was unreachable; it also assumed a non-existent `bridge.getRefreshToken()` (which the repo's
> F1 invariant forbids ever adding), mis-typed the bridge hook, and excluded the `needs-unlock`
> state its own primary entry point arrives in. Item 2 below is **redesigned**, not patched:
> the callback now *completes* sign-in (`register()` + `setToken()`) and carries the fresh
> refresh token + OAuth proof to `/reset-keys/` in **module-level in-memory state** (same JS
> realm across an SPA `router.replace`), never through the crypto bridge and never as a bearer
> credential in `sessionStorage`. The returning-OAuth-user 409 dead-end (review "Anything
> missing #1") is folded into item 2's scope. Smaller review corrections are applied to items
> 1, 3, 6, 8, 11, 12 and the appendix, each noted where it lands.

---

## 0. Product decision & why

Two decisions frame the whole plan:

1. **Production login is OAuth-only (Google + GitHub).** Email+password stays, but becomes a
   **dev/local-testing** identity gated behind the same `FALCON_DEV_AUTH` / `DEV_AUTH_ENABLED`
   flag that already hides the "Continue without OAuth (dev only)" bypass. No email
   verification is added (email+password is never a production credential).

2. **When a user logs in via Google/GitHub, capture and store their email** (display + later
   analytics). The `auth_identities` table already carries `email` / `email_verified`
   (`packages/server/src/db/schema.ts:60-61`) but nothing populates them from OAuth today
   (`packages/server/src/auth/oauth.ts` never references email — verified).

   > **Audit-note correction:** the audit brief said the `accounts` table (schema ~47-61) has
   > the `email` / `email_verified` columns. It does not — those columns live on
   > **`auth_identities`** (`schema.ts:60-61`), which is the correct place (identity-scoped, one
   > row per provider). The register route already writes `auth_identities` rows
   > (`routes/oauth.ts:145-149`); item 6 just adds `email` / `emailVerified` to that insert.

**Passkeys/WebAuthn are explicitly out of scope for this pass.** The plan keeps the current
PIN-based local key-custody model (device-key wrap for CLI via `@napi-rs/keyring`; PIN-wrap for
web via the crypto worker) unchanged.

### Cross-cutting sequencing (read before scheduling any of this)

- **Item 2 (OAuth step-up for "reset keys") MUST land and be verified before item 3 (gate
  password off in production).** The only step-up proof the client constructs today is
  `{ kind: "password" }` (`complete-password-sign-in.ts:169`).
  > **Baseline correction (review Problem 6).** An OAuth-only account has **no working reset
  > path *today* either**, independent of item 3: the only rotate UI is `/password/`'s
  > post-*password-login* step machine, which an OAuth-only account can never reach (it has no
  > password to log in with), and the only client-constructed proof — `{ kind: "password" }` —
  > `verifyStepUp` rejects for it (no `passwordHash` row, `keys.ts:90-95`). So item 2 fixes a
  > **live hole**, not a future one — it is *more* urgent than "a prerequisite for item 3," even
  > though the "2 before 3" ordering still holds (for accounts that hold *both* identity kinds,
  > item 3 would otherwise remove their last working reset UI). "Bricked for encryption" is also
  > overstated: non-destructive pairing from another still-keyed device stays available; a true
  > brick needs losing *every* device.
  Land item 2, verify end-to-end, *then* item 3.
- **Item 4 (reset-keys button hierarchy) is part of the item 2 route** — it describes that
  route's final UI, so they ship together.
- **Item 6 (capture email)** is independent and can land any time; item 3 does not depend on it.
- Items 5, 7, 9, 10, 12 are independent and can land in any order.

### Severity groups

| # | Severity | Item |
|---|----------|------|
| 1 | Critical | `/pair` bounces everyone to sign-in (no `silentRefresh`) |
| 2 | Critical | OAuth step-up flow for "reset keys" rotation (new `/reset-keys/` route) — incl. returning-OAuth-user 409 recovery |
| 3 | Critical | Gate email+password auth off in production |
| 4 | High | Reset-keys screen: pairing primary, rotate secondary+confirm |
| 5 | High | Devices settings: confirm before revoking a session |
| 6 | High | Capture & store email from Google/GitHub sign-in |
| 7 | Medium | Session-expiry redirect carries a reason |
| 8 | Medium | Machine status: "Offline" vs "Needs re-authentication" |
| 9 | Low | Remove leaked `issue-4-plan.md` doc strings from `/password/` |
| 10 | Low | Reword PIN copy to "this browser only" |
| 11 | Low | Remove resolved known-issues.md #4 (and #14 once item 1 lands) |
| 12 | Low | Password sign-in drops pending-pair context |

---

# Critical

## 1. `/pair` bounces everyone to sign-in (missing `silentRefresh`)

### Current behavior

`packages/web/src/app/(public)/pair/page.tsx:64-74` gates on `isSignedIn()` with no refresh
attempt first:

```tsx
    (async () => {
      const identity = await bridge.getIdentity();
      if (cancelled) return;

      if (!identity || !isSignedIn()) {
        stashPendingPair(ephPub);
        router.replace("/signin/");
        return;
      }
      setStatus({ kind: "confirm", ephPub });
    })();
```

`isSignedIn()` (`lib/session.ts:88-90`) is `getToken() !== null && !isTokenExpired()`, and
`getToken()` is a plain in-memory variable (`session.ts:25-28`) that is `null` on every fresh
page load. `RequireAuth` handles exactly this by calling `silentRefresh()` first
(`features/auth/require-auth.tsx:66-78`):

```tsx
    async function ensureSession(): Promise<void> {
      if (isSignedIn()) {
        if (!cancelled) setSessionReady(true);
        return;
      }
      const refreshed = await silentRefresh();
      if (cancelled) return;
      if (refreshed) {
        setSessionReady(true);
      } else {
        router.replace(SIGNIN_PATH);
      }
    }
```

### Problem

The pairing link (`app.falcon.dev/pair#<ephPub>`) is very plausibly the **first** thing opened
in a new tab — its own docblock (`pair/page.tsx:29-33`) says so. On that first load the
in-memory access token is always `null`, so `isSignedIn()` is `false` even for a fully
provisioned, PIN-unlocked browser that holds a live refresh token in the worker. The page
therefore stashes the pending pair and bounces to `/signin/` **every time**, forcing a full
re-login detour before the user can approve their own CLI — the single most common pairing path
is broken. (This effect only runs once `bridgeStatus.kind === "ready"`, i.e. the worker is
already unlocked, so a `silentRefresh()` here has a refresh token to work with.)

### Proposed fix

Mirror `require-auth.tsx`: attempt `silentRefresh()` before the sign-in bounce. Add
`silentRefresh` to the existing `@/lib/session` import (`pair/page.tsx:10`):

```tsx
import { getToken, isSignedIn, silentRefresh } from "@/lib/session";
```

```tsx
    (async () => {
      const identity = await bridge.getIdentity();
      if (cancelled) return;

      if (!identity) {
        stashPendingPair(ephPub);
        router.replace("/signin/");
        return;
      }

      const signedIn = isSignedIn() || (await silentRefresh());
      if (cancelled) return;
      if (!signedIn) {
        stashPendingPair(ephPub);
        router.replace("/signin/");
        return;
      }
      setStatus({ kind: "confirm", ephPub });
    })();
```

The `!identity` case stays a straight bounce (nothing to refresh from — a browser with no local
key material genuinely can't approve; that's item 2's dead-end, surfaced separately via the
`no-identity` bridge branch at `pair/page.tsx:126-135`).

**Also add a just-in-case retry inside `approve()`** (`pair/page.tsx:89-101`). `/pair` sits
*outside* `RequireAuth`, so it never runs the `EXPIRY_CHECK_INTERVAL_MS` (60s) re-check
(`require-auth.tsx:22,82-84`); a user who leaves the confirm screen open longer than the 15-minute
access-token TTL then clicks "Approve" hits `getToken() === null` → "You've been signed out." with
no recovery. Attempt a `silentRefresh()` before that bail-out (the worker is `ready`/unlocked in
this branch, so it has a token source):

```tsx
    let token = getToken();
    if (!token && (await silentRefresh())) token = getToken();
    if (!token) {
      setStatus({ kind: "error", message: "You've been signed out. Please sign in again.", ephPub });
      return;
    }
```

> **Cross-ref (review Problem 9).** This finding is the same bug as `known-issues.md` **issue
> #14** ("`/pair` approval page can never actually complete"), independently discovered — same
> root cause, same primary fix, and issue #14 already recommends this second `approve()` retry.
> Item 1 adopts both; **item 11 closes/removes issue #14** (not only issue #4) once item 1 lands.

### What to verify

- On a provisioned, PIN-unlocked browser, opening `/pair#<ephPub>` cold lands on the
  **"Approve" confirm** screen, not `/signin/`.
- A genuinely signed-out browser (no refresh token recoverable) still bounces to `/signin/` and
  resumes at the pairing link after sign-in (existing `consumePendingPair` path,
  item 12 covers the password variant of resume).
- No regression to the `needs-unlock` PIN gate (it still renders before this effect runs, since
  the effect early-returns while `bridgeStatus.kind !== "ready"`, `pair/page.tsx:42`).

---

## 2. OAuth step-up flow for the "reset keys" rotation (new `/reset-keys/` route)

### Current behavior

Key-epoch rotation ("lost my PIN, generate fresh keys") lives entirely inside `/password/`'s
post-login step machine and uses a **password** step-up proof. `rotateKeyEpoch`
(`lib/complete-password-sign-in.ts:142-186`) generates new key material *first*, then binds:

```ts
export async function rotateKeyEpoch(
  bridge: CryptoBridgeClient,
  accessToken: string,
  refreshToken: string,
  stepUpPassword: string,
  newPin: string,
): Promise<RotateKeyEpochOutcome> {
  await ready;
  const masterSecret = getRandomBytes(32);
  await bridge.init(masterSecret, newPin, refreshToken);
  markCryptoBridgeUnlocked();

  const identity = await bridge.getIdentity();
  if (!identity) {
    return { kind: "error", message: "Crypto bridge failed to provision new key material." };
  }

  try {
    const accountId = decodeAccountId(accessToken);
    const { nonce } = await keysChallenge(accessToken);
    const proof = await bridge.bindKeysProof(accountId, nonce);
    await keysBind(accessToken, {
      signPubKey: proof.signPubKey,
      contentPubKey: proof.contentPubKey,
      nonce,
      signature: proof.signature,
      rotate: true,
      stepUpProof: { kind: "password", password: stepUpPassword },
    });
    return { kind: "ok", nextUrl: "/" };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { kind: "wrong-password", message: "That password is incorrect." };
    }
    if (err instanceof ApiError && err.status === 409) {
      return {
        kind: "other-devices-online",
        message:
          "Another device is still signed in — pair this browser from that device instead of rotating keys blind.",
      };
    }
    const message = err instanceof ApiError ? err.message : "Could not rotate keys. Please retry.";
    return { kind: "error", message };
  }
}
```

The server already accepts an **OAuth** step-up proof. `StepUpProofSchema` (`routes/keys.ts:63-70`)
is a discriminated union, and `verifyStepUp` (`routes/keys.ts:82-108`) handles both kinds —
including checking the OAuth identity resolves to one of *this* account's `auth_identities`
rows. The web `StepUpProof` type (`lib/api.ts:137-139`) and `keysBind` (`lib/api.ts:143-155`)
already carry the `oauth` variant end-to-end:

```ts
export type StepUpProof =
  | { kind: "password"; password: string }
  | { kind: "oauth"; provider: "google" | "github" | "dev"; oauthProof: string };
```

**Nothing on the client ever constructs the `oauth` kind.** The only reachable rotate entry
point is `/password/`'s `handleRotatePinSubmit` (`password/page.tsx:140-165`), password-only.
The two other dead-ends that should reach a reset flow don't have a button:

- `RequireAuth`'s `no-identity` branch (`require-auth.tsx:101-110`) is a bare paragraph, no
  action.
- `PinUnlockForm`'s "Forgot your PIN?" routes to `/password/` (`require-auth.tsx:124`,
  `password/page.tsx:202`).

### Problem

Once password login is dev-only (item 3), `/password/` — and therefore the *only* rotate UI —
is gone from production. An OAuth-only account that loses its PIN would have no way to prove
step-up and no reset path. We need a **provider-agnostic** reset-keys route that can step up via
Google/GitHub, reusing the existing server support and the existing `beginGoogleSignIn()` /
`beginGithubSignIn()` redirect machinery unchanged.

A secondary improvement: the reset flow should generate new key material **as late as possible**
relative to the step-up, narrowing today's `rotateKeyEpoch` window (which `bridge.init`s a new
master secret and unlocks the worker *before* it knows the step-up will succeed). See the
**orphaned-key-material** discussion in §2b — the improvement is real but narrower than "prove
step-up first," because the server's contract and the worker API together make a fully
proof-first ordering impossible without a new worker RPC.

**Third, folded in from the review ("Anything missing #1") — the returning-OAuth-user 409
dead-end.** A returning OAuth user on a *fresh* browser (no local identity, but their account's
keys are already bound on another device) goes `/signin/` → provider → callback → `set-pin`, and
`completeOAuthSignIn`'s new-identity path calls `keysBind` **without** `rotate`
(`complete-oauth-sign-in.ts:74-84`). The server answers `409 "Key mismatch; rotation must be
explicit"` (`keys.ts:191-193`), which the callback surfaces as a generic *"Sign-in failed. Please
try again."* (`oauth-callback-page.tsx:89-93,107-110`) — **after** the user already set a PIN that
is now orphaned. This is the OAuth twin of `/password/`'s `needs-rotate` branch; item 2's three
entry points (`RequireAuth`, `/pair`, forgot-PIN) never catch it because this user came in through
`/signin/` → callback. It shares all of item 2's new infrastructure, so §2c below handles it
rather than deferring it to a separate item.

### Proposed fix

A new provider-agnostic route `/reset-keys/` plus a small handoff module and a step-up branch in
the OAuth callback. The handoff is **split across two channels** (this is the core of the review
fix):

- **Outbound flag** (`/reset-keys/` → provider → callback): a non-sensitive `{ provider, ts }`
  marker in `sessionStorage`, so it survives the full-page provider redirect. TTL-guarded,
  one-shot (`consume`), and provider-validated on return so a stale/abandoned attempt can't
  hijack a later unrelated sign-in in the same tab (review Problem 5).
- **Return payload** (callback → `/reset-keys/`): the fresh **refresh token** and the resolved
  **oauthProof** in a **module-level in-memory variable** — *never* `sessionStorage`. The
  callback→`/reset-keys/` hop is an SPA `router.replace` in the same JS realm, so a module
  variable survives it; and neither a bearer credential (the proof, replayable against
  `keys/bind` for up to ~1h) nor a refresh token may ever sit in `sessionStorage` (F1). This
  channel is also what closes the "no access token at `/reset-keys/`" gap (review Problem 1): the
  callback now *completes* sign-in, so a fresh access token is in memory and the refresh token
  rides this channel.

Five moving parts:

#### 2a. New handoff module — `packages/web/src/lib/pending-stepup.ts`

The `sessionStorage` half mirrors `lib/pending-pair.ts` (single-visit) but carries a provider tag
and a timestamp; the in-memory half is a plain module variable, not persisted anywhere:

```ts
/**
 * Preserves an in-progress "reset keys" step-up across the OAuth redirect detour.
 * `/reset-keys/` calls `stashPendingStepUp({ provider })` before sending the browser to
 * Google/GitHub. The OAuth callback, seeing this flag, COMPLETES sign-in (register + setToken)
 * and then hands the fresh refresh token + resolved proof to `/reset-keys/` via the in-memory
 * `stepUpReturn` channel below — NOT sessionStorage: the proof is a live bearer credential and
 * the refresh token must never leave the worker's custody model into web storage (F1). The
 * callback→/reset-keys/ hop is an SPA navigation in the same JS realm, so a module variable
 * survives it. The sessionStorage flag exists only because the *provider* redirect is a real
 * full-page navigation that wipes module memory.
 */

const PENDING_STEPUP_KEY = "falcon:pendingStepUp";
const PENDING_STEPUP_TTL_MS = 5 * 60_000; // an OAuth consent round trip; abandoned attempts expire

export type StepUpProvider = "google" | "github";

interface PendingStepUpFlag {
  provider: StepUpProvider;
  ts: number;
}

export function stashPendingStepUp(value: { provider: StepUpProvider }): void {
  const flag: PendingStepUpFlag = { provider: value.provider, ts: Date.now() };
  window.sessionStorage.setItem(PENDING_STEPUP_KEY, JSON.stringify(flag));
}

/** One-shot: reads AND clears the flag. Returns null if absent, malformed, expired, or (when
 * `expectProvider` is given) for a different provider than the one that started this round trip
 * — the confused-deputy guard (review Problem 5). */
export function consumePendingStepUp(expectProvider?: StepUpProvider): StepUpProvider | null {
  const raw = window.sessionStorage.getItem(PENDING_STEPUP_KEY);
  window.sessionStorage.removeItem(PENDING_STEPUP_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "provider" in parsed &&
      "ts" in parsed &&
      (parsed.provider === "google" || parsed.provider === "github") &&
      typeof (parsed as PendingStepUpFlag).ts === "number" &&
      Date.now() - (parsed as PendingStepUpFlag).ts < PENDING_STEPUP_TTL_MS
    ) {
      const provider = (parsed as PendingStepUpFlag).provider;
      if (expectProvider && provider !== expectProvider) return null;
      return provider;
    }
  } catch {
    // fall through
  }
  return null;
}

/** In-memory-only return channel (callback → /reset-keys/). Deliberately NOT sessionStorage —
 * holds a live OAuth proof and a refresh token; both die with a real page reload, which is the
 * correct fail-safe (the user just re-runs the step-up). */
export interface StepUpReturn {
  provider: StepUpProvider;
  oauthProof: string;
  refreshToken: string;
}

let stepUpReturn: StepUpReturn | null = null;

export function setStepUpReturn(value: StepUpReturn): void {
  stepUpReturn = value;
}

/** One-shot read: returns and clears the in-memory payload. */
export function takeStepUpReturn(): StepUpReturn | null {
  const value = stepUpReturn;
  stepUpReturn = null;
  return value;
}
```

> Note the parse-don't-trust guard on the `sessionStorage` flag matches the repo's convention
> (`tokenProvider.ts:46-49`). The flag never carries the proof or the token — those go through
> `setStepUpReturn`/`takeStepUpReturn` in module memory.

#### 2b. New route — `packages/web/src/app/(public)/reset-keys/page.tsx`

A three-phase client component. This is post-login recovery, so it consumes the **in-memory
return payload** (fresh access token already set by the callback; refresh token + proof from
`takeStepUpReturn()`) — it does **not** rely on `silentRefresh()`, which is structurally
impossible in the two states this page serves (`no-identity` = worker holds no refresh token;
`needs-unlock` = the wrapped refresh token can't be unwrapped, the user forgot the PIN — that's
the premise). It does **not** block on `getIdentity()` — a `no-identity` worker is a valid entry.

**Bridge hook (review Problem 3):** use `useCryptoBridge()` (the raw `CryptoBridgeClient`, always
available once the worker mounts), **not** `useUnlockedCryptoBridge()` — the latter only exposes a
`bridge` binding in its `ready` status (`use-unlocked-crypto-bridge.ts:11-18`), and this page
must call `bridge.init(...)` from the `no-identity`/`needs-unlock` states where `useUnlocked…`
carries no `bridge`. This mirrors how `oauth-callback-page.tsx` and `password/page.tsx` already
take the raw client.

Phase machine:

```tsx
type Phase =
  | { kind: "confirm-identity" }                              // show Google/GitHub buttons
  | { kind: "returned"; provider: StepUpProvider; oauthProof: string; refreshToken: string } // set PIN
  | { kind: "rotating"; error?: string }
  | { kind: "error"; message: string };
```

Outbound (Phase 1 button handlers) — stash the flag, then reuse the unchanged redirect helpers:

```tsx
  function beginStepUp(provider: StepUpProvider): void {
    stashPendingStepUp({ provider });
    if (provider === "google") beginGoogleSignIn();
    else beginGithubSignIn();
  }
```

Return leg (on mount, if the callback left an in-memory payload):

```tsx
  useEffect(() => {
    const ret = takeStepUpReturn();
    if (ret) {
      setPhase({
        kind: "returned",
        provider: ret.provider,
        oauthProof: ret.oauthProof,
        refreshToken: ret.refreshToken,
      });
    }
  }, []);
```

Phase 2 (`returned`) renders `PinSetupForm`. Its submit runs the OAuth-variant rotate, passing the
carried refresh token straight through (no bridge round trip for it):

```tsx
  async function handleNewPin(pin: string): Promise<void> {
    if (!bridge) return;                          // useCryptoBridge() → CryptoBridgeClient | null
    if (phase.kind !== "returned") return;
    const token = getToken();                     // set by the callback's completed sign-in
    if (!token) {
      setPhase({ kind: "error", message: "You've been signed out. Please start over." });
      return;
    }
    setPhase({ kind: "rotating" });
    const outcome = await rotateKeyEpochOAuth(bridge, token, phase.refreshToken, pin, {
      provider: phase.provider,
      oauthProof: phase.oauthProof,
    });
    if (outcome.kind === "ok") {
      router.replace(outcome.nextUrl);
      return;
    }
    if (outcome.kind === "identity-mismatch") {
      setPhase({ kind: "confirm-identity" }); // 401: wrong account — re-prove
      return;
    }
    setPhase({ kind: "rotating", error: outcome.message }); // 409 / other
  }
```

> **Review Problem 3 (guard fix):** the `bridge` here is the raw `useCryptoBridge()` client, so
> the only guard needed is `if (!bridge) return`. The original sketch's
> `bridgeStatus.kind !== "ready" && bridgeStatus.kind !== "no-identity"` guard was wrong twice
> over — it excluded `needs-unlock` (the state a "Forgot your PIN?" visitor arrives in, item 2d's
> most important entry), turning their submit into a silent no-op; and it referenced a `bridge`
> binding that `useUnlockedCryptoBridge()` does not provide outside `ready` (a compile error under
> strict TS).

New sibling of `rotateKeyEpoch` in `lib/complete-password-sign-in.ts` (or a new
`lib/rotate-key-epoch.ts` — either matches conventions; keeping it beside the password variant
minimises churn). It takes the refresh token **as a parameter** — exactly like the existing
`rotateKeyEpoch` does — and carries the OAuth proof through `keys/bind`'s `stepUpProof`. It also
resolves `nextUrl` from the pending-pair stash (review Problem 8 — the nested `/pair` case):

```ts
export type RotateKeyEpochOAuthOutcome =
  | { kind: "ok"; nextUrl: string }
  | { kind: "identity-mismatch"; message: string }
  | { kind: "other-devices-online"; message: string }
  | { kind: "error"; message: string };

export async function rotateKeyEpochOAuth(
  bridge: CryptoBridgeClient,
  accessToken: string,
  refreshToken: string,
  newPin: string,
  step: { provider: "google" | "github"; oauthProof: string },
): Promise<RotateKeyEpochOAuthOutcome> {
  await ready;
  const accountId = decodeAccountId(accessToken);
  const { nonce } = await keysChallenge(accessToken);

  // Provision the new master secret (this PIN-wraps and persists it in the worker), then sign
  // the bind nonce. `bridge.init` MUST run before `bridge.bindKeysProof` — the worker rejects
  // the signing call when it isn't initialized (`crypto/client.ts:60`). See the orphaned-key
  // note below: a proof the server later rejects (401/409) will already have overwritten this
  // browser's previous wrapped record, same as the password-path `rotateKeyEpoch`.
  const masterSecret = getRandomBytes(32);
  await bridge.init(masterSecret, newPin, refreshToken);
  markCryptoBridgeUnlocked();
  const proof = await bridge.bindKeysProof(accountId, nonce);

  try {
    await keysBind(accessToken, {
      signPubKey: proof.signPubKey,
      contentPubKey: proof.contentPubKey,
      nonce,
      signature: proof.signature,
      rotate: true,
      stepUpProof: { kind: "oauth", provider: step.provider, oauthProof: step.oauthProof },
    });
    const pendingEphPub = consumePendingPair();
    return { kind: "ok", nextUrl: pendingEphPub ? `/pair/#${pendingEphPub}` : "/" };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { kind: "identity-mismatch", message: "That account doesn't match this one." };
    }
    if (err instanceof ApiError && err.status === 409) {
      return {
        kind: "other-devices-online",
        message:
          "Another device is still signed in — pair this browser from that device instead of rotating keys blind.",
      };
    }
    const message = err instanceof ApiError ? err.message : "Could not rotate keys. Please retry.";
    return { kind: "error", message };
  }
}
```

> **Audit-note correction — orphaned key material (review Problems 2 & 4):**
>
> 1. **No `bridge.getRefreshToken()`.** The original sketch called a non-existent
>    `bridge.getRefreshToken()`. That method is **absent** from `CryptoBridgeClient`
>    (`crypto/client.ts:32-74`) and **must not be added**: `refreshSession()`'s own doc comment
>    (`client.ts:67-71`) and `lib/session.ts`'s F1 header state that the raw refresh token never
>    crosses out of the worker to the main thread. Adding a getter would silently undo security-
>    review finding F1. Instead the refresh token is threaded from the callback's completed
>    `register()` response (§2c) through the in-memory return channel and passed as a parameter
>    here — mirroring how the password-path `rotateKeyEpoch` already takes `refreshToken` as a
>    parameter.
> 2. **The "no key material orphaned in the worker" claim is narrowed, honestly.** A *fully*
>    proof-first ordering is impossible with the current server + worker API: `keys/bind` verifies
>    the step-up **and** the new-key signature in the same call (`routes/keys.ts:191-205`, no
>    verify-step-up-only endpoint), and the signature requires `bridge.bindKeysProof`, which
>    **rejects unless the worker is already `init`ed** (`client.ts:60`). Since `bridge.init`
>    persists the new PIN-wrapped record to IndexedDB, a subsequently-rejected proof (a 401 from
>    picking the wrong provider account) *does* overwrite this browser's prior wrapped record —
>    the exact behavior today's password `rotateKeyEpoch` already has. So the accurate claim is:
>    **only the "abandoned/cancelled before submitting" case improves** (a user who bails at the
>    provider never reaches `bridge.init`); the "submitted but rejected" case still orphans, same
>    as today. This matters most for a `needs-unlock` entrant, whose old wrapped secret (still
>    recoverable with the remembered PIN) is destroyed by a failed reset attempt. A truly
>    orphan-free rejected-proof path would need a **new worker RPC** (provision-in-memory, persist
>    only on commit) and/or a **new server endpoint** (`POST /v1/auth/keys/stepup` returning a
>    short-lived rotation ticket) — flagged as a possible follow-up, **not** built in this pass.
>
> **Step-up replay window (review "Anything missing #2") — recommended follow-up, not built.**
> `verifyStepUp` accepts any currently-valid provider proof for a matching identity and never
> checks the OIDC `nonce` the web flow already sends (`lib/oauth.ts:50-54` — the comment there
> admits it), so a Google ID token stays replayable until `exp` (~1h). An attacker holding a
> victim's access token *and* a captured recent ID token could replay this destructive rotation.
> Binding step-up to a fresh server-challenged nonce (echoed through the OIDC `nonce` claim) would
> close it. This is a **pre-existing server-side property**, not something this plan introduces —
> flagged here because a key-destroying step-up is exactly where it matters.

#### 2c. Step-up branch in the OAuth callback (and the returning-user 409 fix)

`OAuthCallbackPage` (`components/auth/oauth-callback-page.tsx:52-99`) currently always drives
`completeOAuthSignIn` after resolving the proof. Add a first-thing check: if a matching pending
step-up flag is present, **complete sign-in to mint a fresh token pair, then hand the proof and
refresh token to `/reset-keys/` in memory** and redirect. This is the review Problem 1 fix — the
callback must *not* skip sign-in; that was the fatal flaw.

```tsx
    (async () => {
      const proof = await resolveProof();
      if (cancelled) return;
      if (!proof.ok) {
        setStatus({ kind: "error", message: proof.error });
        return;
      }

      // `dev` never stashes a step-up (only beginGoogle/GithubSignIn do), so this is
      // provider ∈ {google, github}. `consume` (one-shot) + provider match closes the
      // confused-deputy hole (review Problem 5): an abandoned Google step-up can't divert a
      // later GitHub — or a plain — sign-in in the same tab.
      if (provider === "google" || provider === "github") {
        const stepUpProvider = consumePendingStepUp(provider);
        if (stepUpProvider) {
          // Complete sign-in for THIS proof to obtain a fresh access + refresh token, then carry
          // the refresh token + proof to /reset-keys/ in memory. register() upserts by
          // (provider, subject) (complete-oauth-sign-in.ts:13-14), so re-using the proof to sign
          // in AND to step up is safe — Google ID tokens / GitHub access tokens re-verify until
          // exp. setToken() puts the access token in memory; the refresh token never touches
          // sessionStorage (F1).
          const { token, refreshToken } = await register({
            oauthProvider: provider,
            oauthProof: proof.value,
          });
          if (cancelled) return;
          setToken(token);
          setStepUpReturn({ provider, oauthProof: proof.value, refreshToken });
          router.replace("/reset-keys/");
          return;
        }
      }

      const identity = await bridge.getIdentity();
      // ...unchanged sign-in path below...
```

`register` / `setToken` are imported the same way `completeOAuthSignIn` imports them
(`lib/api.ts`, `lib/session.ts`).

**Returning-user 409 (review "Anything missing #1").** In the *normal* sign-in path's `set-pin`
branch (`handlePinSetup`, `oauth-callback-page.tsx:101-111`), `completeOAuthSignIn` can throw an
`ApiError` with `status === 409` (`keys.ts:191-193`) when the account's keys are already bound
elsewhere. Today that surfaces as a generic "Sign-in failed. Please try again." Detect it and
offer recovery instead of a dead end:

```tsx
  async function handlePinSetup(pin: string) {
    if (!bridge || status.kind !== "set-pin") return;
    setStatus({ kind: "working" });
    try {
      const outcome = await completeOAuthSignIn(bridge, provider, status.oauthProof, pin);
      router.replace(outcome.nextUrl);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Account already has keys bound on another device — this browser can't first-bind.
        // Offer the non-destructive path (pair) primary, and the destructive reset secondary.
        setStatus({ kind: "already-bound" });
        return;
      }
      const message = err instanceof ApiError ? err.message : "Sign-in failed. Please try again.";
      setStatus({ kind: "error", message });
    }
  }
```

The new `{ kind: "already-bound" }` status renders a small screen: **"This account already has
keys on another device"** with **"Pair from another device"** (`router.push("/pair/")`, primary)
and **"Reset keys for this browser"** (`router.push("/reset-keys/")`, secondary/destructive) — the
OAuth twin of `/password/`'s `needs-rotate` branch, reusing item 2's `/reset-keys/` and item 4's
hierarchy. (The user did set a PIN that is now orphaned; both offered paths overwrite it cleanly —
pairing re-provisions from the peer, reset rotates — so no stranded state remains.)

#### 2d. Wire the three entry points to `/reset-keys/`

- `RequireAuth` `no-identity` branch (`require-auth.tsx:101-110`) — add a button:

  ```tsx
  <Button type="button" onClick={() => router.push("/reset-keys/")}>
    Reset keys for this browser
  </Button>
  ```

- `RequireAuth` `needs-unlock` "Forgot your PIN?" (`require-auth.tsx:124`) — repoint:

  ```tsx
  onForgotPin={() => router.push("/reset-keys/")}
  ```

- `pair/page.tsx` `no-identity` branch (`pair/page.tsx:126-135`) — the empty-browser-tries-to-
  approve edge case — add a button to `/reset-keys/` alongside the existing paragraph.

#### Nesting note (must test)

This stashes-and-resumes and can nest: `/pair#eph` → (no identity) → `/reset-keys/` →
`beginGoogleSignIn()` → Google → `/auth/callback/google/` → (matching pending step-up flag) →
completes sign-in → `/reset-keys/` (in-memory payload) → rotate → `nextUrl` resolves to
`/pair/#eph` (the pending-pair stash the rotate now consumes, §2b) → back at the approve screen.
The `pending-pair` (`sessionStorage`) and `pending-stepup` (flag in `sessionStorage` + payload in
module memory) channels are independent and don't collide. It needs **explicit end-to-end
testing** of the full nested path, since a dropped stash at any hop strands the user — and the
in-memory return payload specifically dies on a real reload (by design), so the test must not
reload between callback and `/reset-keys/`.

### New files / routes

- `packages/web/src/lib/pending-stepup.ts` (new) — `sessionStorage` flag + in-memory return
  channel.
- `packages/web/src/app/(public)/reset-keys/page.tsx` (new route).
- `rotateKeyEpochOAuth` in `lib/complete-password-sign-in.ts` (new export; takes `refreshToken`
  as a parameter — no `bridge.getRefreshToken()`).
- `{ kind: "already-bound" }` status + screen in `components/auth/oauth-callback-page.tsx` (the
  returning-user 409 recovery).

### What to verify

- OAuth-only account, PIN forgotten: `RequireAuth` `needs-unlock` → "Forgot your PIN?" →
  `/reset-keys/` → Google/GitHub → **sign-in completes in the callback** (access token in memory)
  → `/reset-keys/` sets new PIN → lands signed in, old sessions revoked. (Regression guard for
  review Problem 1: the flow must NOT hit "You've been signed out.")
- Wrong account at the provider → 401 → `identity-mismatch` → back to `confirm-identity`. Note the
  honest caveat: the worker's prior wrapped record *was* overwritten by `bridge.init` before the
  401 (review Problem 4) — verify the messaging/retry, not "old key material intact."
- Abandoning at the provider (hit back) leaves the worker untouched — `bridge.init` never ran (the
  one orphan case that genuinely improves).
- Another device online → 409 → `other-devices-online` message, no rotation.
- Full nested `/pair` → `/reset-keys/` → provider → callback → `/reset-keys/` → resumes at
  `/pair/#eph`, not Home (pending-pair consumed by `rotateKeyEpochOAuth`).
- **Confused-deputy guard:** start a Google step-up, abandon it, then do a normal sign-in in the
  same tab — the normal sign-in must complete, NOT divert into `/reset-keys/` (flag consumed +
  provider-matched + TTL).
- **Returning-user 409:** OAuth account with keys bound on device A, sign in fresh on device B →
  after PIN, land on the "already has keys" screen offering Pair (primary) / Reset (secondary),
  not a generic "Sign-in failed."
- **F1 grep:** no `getRefreshToken` added to `CryptoBridgeClient`; no OAuth proof or refresh token
  written to `sessionStorage`/`localStorage` (grep `pending-stepup.ts` — only the `{provider,ts}`
  flag persists).

---

## 3. Gate email+password auth off in production

> **Depends on item 2 shipping first** (see §0 sequencing) — do not merge item 3 until the OAuth
> step-up reset path is verified, or OAuth-only accounts lose their only reset route.

### Current behavior

There is an existing dev-only-gating pattern to extend:

- **Web flag** (`lib/config.ts:35`): `DEV_AUTH_ENABLED = process.env.NEXT_PUBLIC_FALCON_DEV_AUTH === "1"`.
- **Web gate** (`signin/page.tsx:106-115`): the "Continue without OAuth (dev only)" button
  renders only when `DEV_AUTH_ENABLED`.
- **Server flag + boot guard** (`config.ts:47` and `config.ts:170-173`):

  ```ts
  FALCON_DEV_AUTH: z.coerce.boolean().default(false),
  // ...
  .refine((parsed) => !(parsed.NODE_ENV === "production" && parsed.FALCON_DEV_AUTH), {
    message: "FALCON_DEV_AUTH must not be enabled when NODE_ENV=production",
    path: ["FALCON_DEV_AUTH"],
  })
  ```

But email+password is **not** behind any flag. The "Continue with email + password" link always
renders (`signin/page.tsx:93-100`), and the server's `POST /v1/auth/password/register` /
`POST /v1/auth/password/login` routes accept requests unconditionally.

### Problem

Product decision: email+password is dev/local-testing only. Today it is a first-class
production login path (unflagged UI, unflagged routes). "Unlink the button" alone is not enough
— the routes must reject in production too, or a determined client still registers a password
account against prod.

### Proposed fix

Reuse the existing `FALCON_DEV_AUTH` flag rather than inventing a second one — email+password
and the dev-OAuth-bypass share the same "local testing only" lifetime, and `config.ts`'s
`.refine()` boot guard already makes `FALCON_DEV_AUTH=1` structurally impossible in production.

#### 3a. Web — hide the email+password link behind `DEV_AUTH_ENABLED`

`signin/page.tsx:88-116`, wrap the email+password block:

```tsx
{DEV_AUTH_ENABLED && (
  <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-4">
    <p className="text-sm leading-6 text-muted-foreground">
      Prefer email + password? That flow also sets up (or unlocks) this browser's
      encrypted key material with a PIN. (Local testing only.)
    </p>
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={() => router.push("/password/")}
    >
      Continue with email + password
    </Button>
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={() => router.push("/auth/callback/dev/")}
    >
      Continue without OAuth (dev only)
    </Button>
  </div>
)}
```

The `!GOOGLE_OAUTH_CLIENT_ID && !GITHUB_OAUTH_CLIENT_ID && !DEV_AUTH_ENABLED` "no provider
configured" note (`signin/page.tsx:101-105`) moves up to the OAuth section so a production
deployment with no OAuth ids still shows a sensible message rather than a blank card.

#### 3b. Server — reject the password routes when `FALCON_DEV_AUTH` is off

The password routes live in `packages/server/src/app/routes/password.ts` —
`buildPasswordRoutes(db, email)` (`password.ts:54`), a sibling of `buildOAuthRoutes`, with the
register/login/reset handlers registered at `password.ts:56,113,178,214`. Gate the `register`
and `login` handlers on `env.FALCON_DEV_AUTH`, returning a fail-closed 404 (route effectively
does not exist in production) — matching the "dev provider returns null when off" stance in
`auth/oauth.ts:168-171`. The file already imports from `drizzle-orm`/`zod` but not `config` —
add the import, then guard each handler:

```ts
import { env } from "../../config.js";

// ...as the first line of the register and login handlers:
if (!env.FALCON_DEV_AUTH) {
  return reply.code(404).send({ error: "Not found" });
}
```

(The password-reset handlers at `password.ts:178,214` are part of the same dev-only surface —
gate them too, so a production deployment exposes no email+password endpoints at all.)

A 404 (rather than 403) avoids advertising that a gated endpoint exists — same reasoning as the
no-enumeration stance the password routes already take. No new boot-time guard is needed: the
existing `.refine()` at `config.ts:170-173` already prevents `FALCON_DEV_AUTH=1` under
`NODE_ENV=production`, so these routes are unreachable in prod transitively.

**Add `404` to the Zod response schemas (review Problem 6, minor).** All four handlers declare
only success/`400`/`401` response schemas (`password.ts:62,119,184,220`) — e.g. register is
`response: { 200: SessionResponseSchema, 400: ErrorSchema }`. Fastify serializes an undeclared
`404` through its default path so it *works*, but for a typed-response contract that matches
reality, add `404: ErrorSchema` (the `ErrorSchema` already defined at `password.ts:42`) to each
gated route's `response` map:

```ts
response: { 200: SessionResponseSchema, 400: ErrorSchema, 404: ErrorSchema },
```

#### 3c. Migration precondition — existing production password accounts

The gate is fail-closed: once `FALCON_DEV_AUTH=0`, `password/login` returns 404, so **any account
that registered via email+password against a production deployment is locked out entirely** —
login, and (since item 2's step-up only accepts OAuth or password) reset too, with no linking
story. Before item 3 ships, resolve this one of two ways, explicitly:

- **Preferred / assert the precondition:** confirm **no production password accounts exist yet**
  (the current prod build offers email+password as a first-class path — the plan's own premise —
  so this must be *checked*, e.g. a `SELECT count(*) FROM auth_identities WHERE kind='password'`
  against prod returning 0, not assumed). If it holds, gating is safe as written. Record the check
  in the item-3 PR.
- **Otherwise / add a migration path:** provide an account-linking step (sign in with the existing
  password once, link a Google/GitHub identity to the same `accounts` row, *then* enable the gate)
  so those users retain a reachable login + OAuth step-up before password is disabled.

> If a *separate* flag is preferred (so a self-hoster could keep dev-OAuth off but password on),
> add `FALCON_PASSWORD_AUTH: z.coerce.boolean().default(false)` to `config.ts` with an identical
> `.refine()` production guard, mirror it as `NEXT_PUBLIC_FALCON_PASSWORD_AUTH` in
> `lib/config.ts`, and gate on that instead. The plan's default is to **reuse `FALCON_DEV_AUTH`**
> for minimal surface; call this out at review.
>
> **Consistency guard (review "Anything missing #4"):** if this separate-flag path is chosen, the
> **web gate in 3a must key off the mirrored `NEXT_PUBLIC_FALCON_PASSWORD_AUTH`, not
> `DEV_AUTH_ENABLED`** — otherwise the UI and the server disagree (button hidden but routes live,
> or vice-versa). The two halves (server route gate + web link gate) must ship on the *same* flag;
> don't let them diverge.

### New env vars

None (reuses `FALCON_DEV_AUTH` / `NEXT_PUBLIC_FALCON_DEV_AUTH`). Optional
`FALCON_PASSWORD_AUTH` documented above if the team wants independent control.

### What to verify

- Prod-shaped build (`NEXT_PUBLIC_FALCON_DEV_AUTH` unset): `/signin/` shows only Google/GitHub;
  no email+password link, no dev bypass.
- `POST /v1/auth/password/register` against a `FALCON_DEV_AUTH=0` server returns 404.
- Local dev (`FALCON_DEV_AUTH=1` both sides): email+password still works end-to-end (the CLAUDE.md
  runbook path).
- **Regression gate for §0:** confirm item 2's `/reset-keys/` is reachable and functional
  *before* this lands.

---

# High

## 4. Reset-keys screen: pairing primary, rotate secondary + confirm

### Current behavior

Today's rotate entry (`password/page.tsx:204-214`, the `needs-rotate` step) offers a single
button that goes straight into rotation:

```tsx
{status.step.kind === "needs-rotate" && (
  <div className="space-y-4">
    <p className="text-sm text-muted-foreground">
      This browser has no key material for your account yet. Generate a new set (this
      signs every OTHER device out, unless one of them approves a pairing instead).
    </p>
    <Button type="button" className="w-full" onClick={startRotate}>
      Generate new keys
    </Button>
  </div>
)}
```

One button, no confirmation, and rotation (the destructive path that revokes every other
session — `routes/keys.ts:228-240`) is the *only* offered action even though pairing is the
non-destructive, data-preserving recovery.

### Problem

The safer recovery (pair from a device that already has the keys — preserves all encrypted
sessions) is not even surfaced here, and the destructive one is a single unguarded click.

### Proposed fix

The new `/reset-keys/` route (item 2) is where this hierarchy lives. Its `confirm-identity`
phase leads with pairing and demotes rotation:

```tsx
{phase.kind === "confirm-identity" && (
  <div className="flex w-full max-w-sm flex-col gap-6">
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Recover this browser</h1>
      <p className="text-sm text-muted-foreground">
        The safest option keeps all your encrypted sessions. Resetting keys signs every
        other device out and archives data encrypted under the old keys.
      </p>
    </div>

    <Button type="button" size="lg" onClick={() => router.push("/pair/")}>
      Pair from another device
    </Button>

    <Separator />

    {!confirmingReset ? (
      <Button
        type="button"
        variant="outline"
        className="text-destructive"
        onClick={() => setConfirmingReset(true)}
      >
        Reset keys instead
      </Button>
    ) : (
      <div className="space-y-3 rounded-lg border border-destructive/40 p-4">
        <p className="text-sm text-destructive">
          This permanently archives everything encrypted under your current keys and logs
          out every other device. Confirm it's you to continue.
        </p>
        <div className="flex flex-col gap-2">
          <Button type="button" variant="destructive" disabled={!GOOGLE_OAUTH_CLIENT_ID}
            onClick={() => beginStepUp("google")}>
            Confirm with Google
          </Button>
          <Button type="button" variant="destructive" disabled={!GITHUB_OAUTH_CLIENT_ID}
            onClick={() => beginStepUp("github")}>
            Confirm with GitHub
          </Button>
        </div>
      </div>
    )}
  </div>
)}
```

`confirmingReset` is local `useState(false)`. Pairing is `size="lg"` primary and first; reset is
outlined/destructive and only reveals the provider step-up buttons after an explicit confirm
click. (`Separator`, `beginGoogleSignIn`/`beginGithubSignIn` client-id gating, and the
`beginStepUp` helper are all from item 2.)

### What to verify

- Pairing is visually primary and above the fold; reset requires two clicks (reveal → confirm).
- With no OAuth provider configured, reset buttons are disabled (can't rotate without a step-up
  proof), and pairing is still offered.

---

## 5. Devices settings: confirm before revoking a session

### Current behavior

`DevicesSection`'s `handleRevoke` (`features/settings/components/DevicesSection.tsx:73-94`) runs
immediately on click:

```tsx
async function handleRevoke(session: DeviceSession) {
  const token = getToken();
  if (!token) return;
  setPendingId(session.id);
  setError(null);
  try {
    await revokeSession(token, session.id);
    if (session.isCurrent) {
      await logout();
      router.replace(SIGNIN_PATH);
      return;
    }
    setSessions((prev) => prev?.filter((s) => s.id !== session.id) ?? prev);
  } catch (err) {
    setError(err instanceof Error ? err.message : "Failed to log out that device");
  } finally {
    setPendingId(null);
  }
}
```

The per-row button (`DevicesSection.tsx:163-175`) calls `onClick={() => handleRevoke(session)}`
with no confirmation. Revoking the current device also immediately logs *this* browser out.

### Problem

A single misclick logs out a device (or the current browser, which is a full sign-out). This is
destructive and irreversible from this screen (the CLI daemon would need `falcon auth login`
again). It needs a confirmation step — especially for the "This device" row.

### Proposed fix

Introduce a confirmation dialog. The repo uses shadcn/ui (`components/ui/*`); if an
`AlertDialog` primitive already exists under `components/ui/`, use it; otherwise a lightweight
inline confirm state avoids adding a dependency. Inline-confirm variant (no new component):

```tsx
const [confirmId, setConfirmId] = useState<string | null>(null);
```

Split the click into request-confirm vs. execute:

```tsx
function requestRevoke(session: DeviceSession): void {
  setError(null);
  setConfirmId(session.id);
}

async function confirmRevoke(session: DeviceSession): Promise<void> {
  setConfirmId(null);
  await handleRevoke(session); // unchanged body from above
}
```

Row rendering (`DevicesSection.tsx:163-175`) becomes a two-state control:

```tsx
{confirmId === session.id ? (
  <div className="flex items-center gap-2">
    <span className="text-xs text-muted-foreground">
      {session.isCurrent ? "Log out this browser?" : "Log out this device?"}
    </span>
    <Button type="button" variant="destructive" size="sm" disabled={pendingId !== null}
      onClick={() => confirmRevoke(session)}>
      {pendingId === session.id ? "Working…" : "Confirm"}
    </Button>
    <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmId(null)}>
      Cancel
    </Button>
  </div>
) : (
  <Button type="button" variant="outline" size="sm" disabled={pendingId !== null}
    onClick={() => requestRevoke(session)}>
    {session.isCurrent ? "Log out this device" : "Log out"}
  </Button>
)}
```

If an `AlertDialog` primitive is present, prefer it (better a11y/focus-trap): trigger opens the
dialog, its action button calls `confirmRevoke(session)`. Either way the confirm copy must call
out the current-device case ("This logs you out of this browser").

### What to verify

- Clicking "Log out" on any row shows a confirm affordance; the revoke only fires on Confirm.
- Cancel restores the row with no request sent.
- Confirming the "This device" row still runs `logout()` + redirect (existing behavior).
- "Log out all other devices" (`handleRevokeOthers`, `DevicesSection.tsx:96-109`) — decide
  whether it also needs a confirm; recommend yes for consistency (bulk destructive), same
  inline pattern.

---

## 6. Capture & store email from Google/GitHub sign-in

### Current behavior

`OAuthIdentity` (`auth/oauth.ts:18-22`) carries only `provider` + `subject`; neither verifier
populates email:

```ts
export interface OAuthIdentity {
  provider: OAuthProvider;
  subject: string;
}
```

`verifyGoogleIdToken` (`auth/oauth.ts:51-69`) returns `{ provider: "google", subject: payload.sub }`
— it decodes the ID token but ignores its `email`/`email_verified` claims.
`verifyGithubAccessToken` (`auth/oauth.ts:80-103`) hits `/user` and returns `{ provider: "github",
subject: String(body.id) }` — GitHub's `/user` `email` is `null` unless the user made it public,
and the token was requested with only `scope=read:user` (`lib/oauth.ts:69`). The register route
inserts `auth_identities` rows **without** email (`routes/oauth.ts:145-149`):

```ts
await tx.insert(authIdentities).values({
  accountId: account.id,
  kind: identity.provider,
  identifier: identity.subject,
});
```

The `auth_identities.email` / `emailVerified` columns exist and are unused for OAuth
(`schema.ts:60-61`).

### Problem

We want the email for display + analytics. Google gives it directly in the ID token; GitHub
needs a scope bump and a second API call.

### Proposed fix

#### 6a. Carry email on `OAuthIdentity`

```ts
export interface OAuthIdentity {
  provider: OAuthProvider;
  subject: string;
  email: string | null;
  emailVerified: boolean;
}
```

#### 6b. Google — decode the claims (already in the verified token)

`auth/oauth.ts:57-63`:

```ts
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: GOOGLE_ISSUERS,
      audience: env.GOOGLE_OAUTH_CLIENT_ID,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    const email = typeof payload.email === "string" ? payload.email : null;
    const emailVerified = payload.email_verified === true;
    return { provider: "google", subject: payload.sub, email, emailVerified };
```

No extra network call — these are standard OIDC claims in the same signed token already
verified.

#### 6c. GitHub — add `user:email` scope + query `/user/emails`

Scope bump (`lib/oauth.ts:69`):

```ts
url.searchParams.set("scope", "read:user user:email");
```

Then in `verifyGithubAccessToken` (`auth/oauth.ts:80-103`), after the `/user` call, fetch the
primary verified address. GitHub's `/user/emails` returns
`[{ email, primary, verified }, ...]`. Add an injectable `fetchEmails` mirroring the existing
injectable `fetchUser` (so `oauth.test.ts` can stub it):

```ts
export async function verifyGithubAccessToken(
  accessToken: string,
  fetchUser: (token: string) => Promise<Response> = defaultFetchUser,
  fetchEmails: (token: string) => Promise<Response> = defaultFetchEmails,
): Promise<OAuthIdentity | null> {
  try {
    const response = await fetchUser(accessToken);
    if (!response.ok) return null;
    const body = (await response.json()) as { id?: number | string; email?: string | null };
    if (body.id === undefined || body.id === null) return null;

    let email = typeof body.email === "string" ? body.email : null;
    let emailVerified = false;
    const emailsRes = await fetchEmails(accessToken);
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      const primary = emails.find((e) => e.primary) ?? emails.find((e) => e.verified);
      if (primary) {
        email = primary.email;
        emailVerified = primary.verified;
      }
    }
    return { provider: "github", subject: String(body.id), email, emailVerified };
  } catch {
    return null;
  }
}
```

with the two default fetchers factored out (matching the current inline default at
`auth/oauth.ts:82-89`):

```ts
const defaultFetchUser = (token: string): Promise<Response> =>
  fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "falcon-server",
      Accept: "application/vnd.github+json",
    },
  });

const defaultFetchEmails = (token: string): Promise<Response> =>
  fetch("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "falcon-server",
      Accept: "application/vnd.github+json",
    },
  });
```

The `/user/emails` call failing (missing scope on an old grant, network error) degrades to
`email: null, emailVerified: false` rather than failing the whole login — email is best-effort
metadata, not an auth gate.

#### 6d. `verifyDevProof` — satisfy the widened interface

`auth/oauth.ts:168-171` must return the new fields:

```ts
function verifyDevProof(proof: string): OAuthIdentity | null {
  if (!env.FALCON_DEV_AUTH) return null;
  return { provider: "dev", subject: proof || "dev", email: null, emailVerified: false };
}
```

#### 6e. Persist on register (both create and update paths)

`routes/oauth.ts:133-151`. On first sign-in, include email in the insert; on a returning
identity, backfill email if the row lacks it (so existing rows get populated on next login):

```ts
const existing = await db.query.authIdentities.findFirst({
  where: and(
    eq(authIdentities.kind, identity.provider),
    eq(authIdentities.identifier, identity.subject),
  ),
});

const accountId = existing
  ? existing.accountId
  : await db.transaction(async (tx) => {
      const [account] = await tx.insert(accounts).values({}).returning({ id: accounts.id });
      if (!account) throw new Error("oauth register: account insert returned no row");
      await tx.insert(authIdentities).values({
        accountId: account.id,
        kind: identity.provider,
        identifier: identity.subject,
        email: identity.email,
        emailVerified: identity.emailVerified,
      });
      return account.id;
    });

if (existing && !existing.email && identity.email) {
  await db
    .update(authIdentities)
    .set({ email: identity.email, emailVerified: identity.emailVerified })
    .where(eq(authIdentities.id, existing.id));
}
```

> No schema migration needed — the columns already exist (`schema.ts:60-61`). This is the
> Audit-note correction from §0: email lands on `auth_identities`, not `accounts`.

#### 6f. Read path — this item is write-only unless one is added (review Problem 7)

The stated motivation is "display + later analytics," but 6a–6e only **write** the email; nothing
reads it back. Verified: no route under `packages/server/src/app/routes/` returns the identity
email, and no web surface renders one (`nav-user.tsx` / settings show nothing email-shaped for
OAuth accounts). As written, item 6 is **write-only storage** — the "display" goal is not
delivered. Choose explicitly:

- **Minimal, to actually meet the goal:** add the email to a `GET /v1/auth/me`-style response
  (whatever the account-summary endpoint is) and render it in the sidebar account footer /
  settings. Small, but it's the difference between "captured" and "displayed."
- **Or scope it down honestly:** declare item 6 intentionally write-only for now — the columns get
  populated so a *later* display/analytics item has real data to read, and this item's only job is
  to stop dropping the email on the floor. State the reason in one line rather than implying a
  display that doesn't ship.

#### 6g. Tension with `auth_identities`' documented linking semantics (review Problem 7)

`schema.ts:46-48` documents `emailVerified` as the gate for **account-linking** (§5.4: "an OAuth
login only links to an existing password account when both sides are verified"). No linking is
implemented today, and capturing email here is safe **only because** `routes/oauth.ts` resolves
accounts strictly by `(kind, subject)` — two providers reporting the same email just make two
*unlinked* accounts, no takeover surface, so "email is best-effort metadata, not an auth gate"
holds. Flag the tension for the future: **the moment anyone implements §5.4 linking on top of
these captured emails, `emailVerified` becomes security-load-bearing**, and 6e's backfill (stores
a changed provider email only when the column is empty, never updates a stale one, never
re-upgrades `emailVerified`) is not written to that standard. A linking implementation must revisit
the backfill rules, not build on them as-is.

### What to verify

- Google sign-in stores `email` + `emailVerified=true` on the `auth_identities` row.
- GitHub sign-in (with the new scope; user may need to re-consent) stores the primary verified
  email; a private-email GitHub account still signs in, with `email` from `/user/emails`.
- Returning identity created before this change gets its email backfilled on next login.
- `oauth.test.ts`: extend fake verifiers/fetchers to assert email plumbing; the injected
  `fetchEmails` stub keeps tests offline.
- No regression to the fail-closed behavior when a provider is unconfigured (`return null`).

---

## 7. Session-expiry redirect carries a reason

### Current behavior

`RequireAuth` redirects silently on a failed refresh (`require-auth.tsx:75-77`):

```tsx
      if (refreshed) {
        setSessionReady(true);
      } else {
        router.replace(SIGNIN_PATH);
      }
```

`SIGNIN_PATH` is `"/signin/"` (`require-auth.tsx:14`); `/signin/` renders no expiry context.

### Problem

A user whose session expired while on a page is dropped onto a bare sign-in screen with no
explanation — indistinguishable from a normal cold visit. Confusing.

### Proposed fix

Carry a reason via query string (static export: no server, but the client route can read
`window.location.search` / `useSearchParams`). Define the reason contract next to `SIGNIN_PATH`:

```tsx
export const SIGNIN_PATH = "/signin/";
export const SIGNIN_EXPIRED_PATH = "/signin/?reason=expired";
```

`require-auth.tsx:76`:

```tsx
        router.replace(SIGNIN_EXPIRED_PATH);
```

`signin/page.tsx` reads it (client component already, `"use client"` at top) and renders a
banner above the card:

```tsx
import { useSearchParams } from "next/navigation";
// ...
const reason = useSearchParams().get("reason");
// ...
{reason === "expired" && (
  <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
    Your session expired — sign in again to continue.
  </div>
)}
```

> Static-export note: `useSearchParams()` in an exported route must be inside a `<Suspense>`
> boundary or the page must be a client component reading `window.location` in an effect —
> confirm which pattern the other `(public)` routes use (the OAuth callbacks read
> `window.location.hash`/`.search` directly, `google/page.tsx:13`), and match it. Reading
> `window.location.search` in a `useEffect` avoids the Suspense requirement and matches the
> callbacks' approach.

Apply the same `SIGNIN_EXPIRED_PATH` at the other silent-redirect sites if desired
(`DevicesSection` uses `SIGNIN_PATH` after a *deliberate* logout — leave that one as plain
sign-in, not "expired").

### What to verify

- Let an access token expire with a dead/absent refresh token while on a protected page → land
  on `/signin/?reason=expired` showing the banner.
- A normal cold visit to `/signin/` shows no banner.
- Deliberate "Log out this device" still lands on plain `/signin/` (no false "expired").

---

## 8. Machine status: "Offline" vs "Needs re-authentication"

### Current behavior

Machine online/offline is a single boolean. The CLI daemon detects a dead refresh token but only
logs it — `tokenProvider.isDead` (`auth/tokenProvider.ts:39-41,127-129`) flips true on a 401
refresh, and `machineClient.ts:472-474` force-refreshes on an auth `connect_error`, but nothing
propagates "this machine's credential is dead" to the server or web. The web collapses
everything to a boolean: `MachineRow` carries only `lastSeenAt` (`wire/src/rows.ts:36-43`), the
`machine-presence` ephemeral carries only `online` (`wire/src/updates.ts:85-89`), and
`deriveMachineOnline` (`use-machine-presence.ts:55-62`) returns a `boolean`. The Home screen maps
`online: false` to a single `offline` status → label `"Offline"`
(`session-list/status.ts:135`, `live-source.ts:371`).

### Problem

A daemon that is *running but can't authenticate* (refresh token revoked, e.g. after a rotate or
"log out other devices") looks identical to a machine that is simply powered off. The user has
no signal that the fix is `falcon auth login`, not "wake the machine."

### Problem shape / design (this one is design-heavy — flagged, not fully specced)

This needs a signal threaded CLI → server → wire → web. Real work at each layer:

1. **CLI → server.** The daemon knows it's dead (`tokenProvider.isDead`), but by then its socket
   can't authenticate to *tell* the server over the authed channel. Options:
   - When `forceRefresh()` returns null on an auth `connect_error` (`machineClient.ts:465-474`),
     if `tokenProvider.isDead`, stop the reconnect storm and surface a distinct local state.
     The server can't be told over the dead socket — so the *server* must infer it. Simpler:
     the server already knows it revoked the session (it holds `device_sessions.revokedAt`). A
     machine whose `cli-daemon` device session is revoked but whose `lastSeenAt` is recent
     (was online moments ago) is exactly "needs re-auth."
2. **Server → wire.** Add a third presence state. Rather than overload the boolean, widen the
   `machine-presence` ephemeral and `MachineRow`. Minimal wire change (additive, per the
   additive-only wire policy stated in `packages/wire/src/reserved.ts:22` and the `rpc.ts`
   comments — design §5.3; `packages/wire/src/` has **no** `schema.ts`, review Problem 10):

   ```ts
   // wire/src/updates.ts machine-presence — add an optional reason, keep `online` boolean
   z.object({
     t: z.literal("machine-presence"),
     machineId: z.string(),
     online: z.boolean(),
     needsReauth: z.boolean().optional(),
   }),
   ```

   and optionally `MachineRow.needsReauth: z.boolean().optional()` (`wire/src/rows.ts:36-43`) for
   the bootstrap/no-live-event path, derived server-side from "most recent `cli-daemon`
   device_session for this machine is revoked."
3. **Web.** `deriveMachineOnline` becomes `deriveMachineStatus` returning a union:

   ```ts
   export type MachineStatus = "online" | "offline" | "needs-reauth";

   export function deriveMachineStatus(
     machine: MachineRow,
     presence: Map<string, MachinePresence>, // { online, needsReauth }
     now: number,
   ): MachineStatus {
     const live = presence.get(machine.id);
     if (live?.needsReauth) return "needs-reauth";
     if (live) return live.online ? "online" : "offline";
     if (machine.needsReauth) return "needs-reauth";
     return isMachineOnlineHeuristic(machine, now) ? "online" : "offline";
   }
   ```

   Add a status meta entry beside `offline` (`session-list/status.ts:135`):

   ```ts
   "needs-reauth": { label: "Needs re-authentication", dotClassName: "bg-amber-500", pulse: false },
   ```

   and thread `MachineStatus` through `SessionListMachine.online` → a `status` field
   (`live-source.ts:364-372`) and the badge renderer.

> This item touches `@falcon/wire` (schema + a migration if `MachineRow.needsReauth` is
> persisted), the server presence emitter, the CLI daemon, and several web files. It is the
> largest of the punch list and should be its own PR. The **minimum viable** version is
> server-inferred (`revokedAt` + recent `lastSeenAt`) with **no CLI change at all** — the CLI
> already can't talk over a dead socket, so inferring from the revocation the server itself
> performed is both simpler and more reliable than trying to have the daemon self-report.

### What to verify

- Revoke a daemon's session via Settings → Devices while the machine is otherwise up → Home
  shows "Needs re-authentication" (amber), not "Offline" (grey).
- Actually power off a machine → still "Offline".
- `falcon auth login` on the affected machine clears the status back to online.
- Wire round-trip: old web clients ignore the new optional field (additive-only holds).

---

# Low

## 9. Remove leaked `issue-4-plan.md` doc strings from `/password/`

### Current behavior

Two `CardDescription`s render internal doc references as user-facing copy
(`password/page.tsx:177` and `:238`):

```tsx
<CardDescription>issue-4-plan.md §6.1/§6.4 PIN key custody.</CardDescription>
```
```tsx
<CardDescription>Email + password (issue-4-plan.md §5.2).</CardDescription>
```

### Problem

`issue-4-plan.md §6.1/§6.4` is an internal planning reference shown verbatim to users. Sloppy
and confusing.

### Proposed fix

Replace with plain copy (and fold in item 10's "this browser only" framing):

```tsx
<CardDescription>Set up or unlock this browser's encrypted key material.</CardDescription>
```
```tsx
<CardDescription>Email + password sign-in for local testing.</CardDescription>
```

### What to verify

No "issue-4-plan.md" (or any `§`) string renders anywhere in `/password/`. `grep -rn "issue-4-plan"
packages/web/src` returns only code comments, never JSX text.

---

## 10. Reword PIN copy to "this browser only"

### Current behavior

- `PinSetupForm` (`pin-setup-form.tsx:43-47`): "Protects your encrypted key material on this
  device. You'll need it again after a reload — Falcon never stores it, so there's no way to
  recover a lost PIN except rotating your keys from another signed-in device."
- `PinUnlockForm` (`pin-unlock-form.tsx:37-39`): "Unlocks this browser's encrypted key material
  for this session."
- `/password/` `needs-rotate` copy (`password/page.tsx:206-209`) and titles (`:173-176`).

### Problem

"on this device" is close, but users read the PIN as an account password. The mental model to
reinforce: the PIN wraps *this browser's* key material only — losing it loses this browser's
access, not the account, and other devices are unaffected.

### Proposed fix

`pin-setup-form.tsx:43-47`:

```tsx
        <p className="text-sm leading-6 text-muted-foreground">
          This PIN protects your keys on <strong>this browser only</strong> — not your whole
          account. You'll re-enter it after a reload. Falcon never stores it, so if you forget it
          you recover this browser by pairing from another device (or resetting keys), without
          affecting your account or your other devices.
        </p>
```

`pin-unlock-form.tsx:37-39`:

```tsx
        <p className="text-sm leading-6 text-muted-foreground">
          Enter the PIN for <strong>this browser</strong> to unlock its encrypted keys for this
          session.
        </p>
```

`password/page.tsx:206-209` (`needs-rotate`) — reword to make the blast radius explicit ("signs
out your other devices") which it already hints at; keep item 4's hierarchy in mind if this copy
moves to `/reset-keys/`.

### What to verify

Copy reads "this browser only" consistently across setup, unlock, and rotate. No claim that the
PIN protects "the account."

---

## 11. Remove resolved known-issues.md #4 (and #14 once item 1 lands)

### Current behavior

`docs/known-issues.md:100-139` (issue #4, "Auth token lifecycle needs a re-architecture") still
describes the pre-issue-4 world as open: "No refresh-token mechanism at all," "the daemon never
refreshes its token, ever," "No server-side session/device-session concept exists at all," status
"open, not started." The index row at `known-issues.md:14` marks it `Open`.

Separately, `known-issues.md` issue **#14** (index row line 24, section body from `:588`) —
"`/pair` approval page can never actually complete — real users always get bounced to sign-in" —
is **the same bug as plan item 1**, independently discovered (same root cause, same primary fix;
its "What a real fix needs" even names the `approve()` `silentRefresh` retry item 1 now adopts).

### Problem

Issue #4's re-architecture is **built**. Verified against current source:

- Refresh tokens exist and rotate: `packages/cli/src/auth/tokenProvider.ts` (mints from a
  persistent refresh token via `POST /v1/auth/refresh`, caches, persists rotations via
  `onRotate`, flips `isDead` on 401).
- The daemon re-authenticates: `machineClient.ts:465-474` force-refreshes on an auth
  `connect_error`; `:388-415` proactively renews the live socket's token via `renew-token`
  before expiry.
- Device sessions + revocation exist: `device_sessions` table (`schema.ts`, issue-4-plan §3.2),
  `GET /v1/auth/sessions` + revoke routes wired into Settings → Devices
  (`DevicesSection.tsx`).
- Access-token TTL is 15m with silent refresh (`require-auth.tsx:22`, `session.ts:102-113`).
- **WebSocket periodic re-validation beyond handshake — also landed** (verified this pass, review
  resolved-question #3): `server/src/app/socket.ts:164-194` arms a hard-disconnect timer to the
  token's own `exp` (`:173-175`) and a `renew-token` handler that re-verifies the token *and*
  re-checks `device_sessions.revokedAt` before re-arming (`:187-194`). So this is done, not a
  follow-up.

### Proposed fix

**Disposition correction (review Problem 9).** The original plan proposed *replacing* issue #4's
body with a permanent "DONE (superseded)" entry. That contradicts `known-issues.md`'s own stated
convention (`:2-4` intro and `:28-29`): *"When an issue is resolved and verified, remove its row
from this table and its section below — don't mark it 'Fixed' and leave it here, per this file's
own no-growing-archive convention."* So the fix is to **delete**, not rewrite:

1. **Issue #4:** remove its index row (`known-issues.md:14`) and its whole section body
   (`:100-139`). Do **not** leave a "DONE"/"Superseded" stub. The "what shipped / what remains"
   detail belongs in `docs/issue-4-plan.md` (the doc that shipped the work) or this plan's own
   record — not as a permanent tombstone in `known-issues.md`. The only genuinely-still-open
   follow-up is machine status "offline" vs "needs re-authentication", which is already tracked as
   **item 8 of this plan**; note it there, not in a resurrected issue #4.
2. **Issue #14:** once **item 1 lands and is verified**, remove issue #14's index row
   (`known-issues.md:24`) and section (`:588+`) too — item 1 *is* its fix. (Do this as part of
   item 1's PR, or immediately after; sequence it so the row isn't removed before the fix ships.)

Because git history preserves both sections (per the file's own intro, `:4-6`), nothing is lost by
deleting rather than tombstoning.

### What to verify

- After item 11: `known-issues.md` has no issue #4 row or section, and no "DONE/Fixed" stub in its
  place (matches the file's no-growing-archive convention).
- After item 1 + item 11: no issue #14 row or section either; the pairing bug is documented as
  fixed only in the relevant PR/plan, not as a lingering "Fixed" entry.
- The index table and the section anchors stay internally consistent (no dangling `#issue-4` /
  `#issue-14` links elsewhere).

---

## 12. Password sign-in drops pending-pair context

### Current behavior

`completePasswordSignIn` (`lib/complete-password-sign-in.ts:123-130`) hardcodes `nextUrl: "/"`
and never consults the pending-pair stash:

```ts
export async function completePasswordSignIn(
  email: string,
  password: string,
): Promise<PasswordSignInResult> {
  const { token, refreshToken } = await passwordLogin({ email, password });
  setToken(token);
  return { nextUrl: "/", refreshToken };
}
```

Compare `completeOAuthSignIn` (`lib/complete-oauth-sign-in.ts:86-91`), which resumes the pairing
link:

```ts
  const pendingEphPub = consumePendingPair();
  const nextUrl = pendingEphPub ? `/pair/#${pendingEphPub}` : "/";
```

### Problem

The `/pair` → `/signin/` → `/password/` path (item 1's fallback for a genuinely signed-out
browser) never returns to the pairing link when the user signs in with email+password — it dumps
them on Home, pairing abandoned. Lower priority now that password is dev-only in production
(item 3), but it's still wrong for local testing.

### Proposed fix

Mirror the OAuth path. Import `consumePendingPair` and resolve `nextUrl` from it:

```ts
import { consumePendingPair } from "./pending-pair.js";
// ...
export async function completePasswordSignIn(
  email: string,
  password: string,
): Promise<PasswordSignInResult> {
  const { token, refreshToken } = await passwordLogin({ email, password });
  setToken(token);
  const pendingEphPub = consumePendingPair();
  const nextUrl = pendingEphPub ? `/pair/#${pendingEphPub}` : "/";
  return { nextUrl, refreshToken };
}
```

`completePasswordSignUp` (`:68-113`) also hardcodes `nextUrl: "/"` at `:112` — apply the same fix
there for a sign-up-then-pair flow (consistency; low risk).

> Caller check: `password/page.tsx`'s `afterLogin` (`:99-114`) and `handleUnlockSubmit`
> (`:116-130`) currently `router.replace("/")` in a couple of spots regardless of the returned
> `nextUrl` (e.g. `:123`). To actually honor the resumed pairing link, those `replace("/")` calls
> must use the carried `nextUrl` instead. Verify each post-login `replace` site in
> `password/page.tsx` threads `nextUrl` through, or the fix above is inert.

> **Addendum (review "Anything missing #3") — the third sibling with this bug.** The existing
> `rotateKeyEpoch` (`complete-password-sign-in.ts:142-186`) *also* hardcodes `nextUrl: "/"` and
> never consults the pending-pair stash — so `/pair` → forgot-PIN → rotate-via-password drops the
> pairing link exactly like `completePasswordSignIn` does. Item 12 as scoped only touches the
> sign-in/sign-up functions, but while you're in this file apply the same one-liner to
> `rotateKeyEpoch` (`const pendingEphPub = consumePendingPair(); return { kind: "ok", nextUrl:
> pendingEphPub ? \`/pair/#${pendingEphPub}\` : "/" }`). Item 2's new `rotateKeyEpochOAuth` already
> does this (§2b); this closes the gap for the password rotate path too.

### What to verify

- `/pair#eph` (signed out) → `/signin/` → email+password sign-in → lands back on
  `/pair/#eph` at the approve screen, not Home.
- Normal email+password sign-in with no pending pair still lands on Home.
- Same for the sign-up path.

---

## Appendix — file/line index (verified this pass)

| Item | Primary files |
|------|---------------|
| 1 | `web/src/app/(public)/pair/page.tsx:10,64-74,89-101`; `web/src/features/auth/require-auth.tsx:22,66-78`; `docs/known-issues.md` issue #14 (same bug) |
| 2 | `server/src/app/routes/keys.ts:63-108,191-205,228-240`; `web/src/lib/api.ts:137-155`; `web/src/lib/complete-password-sign-in.ts:142-186`; `web/src/lib/complete-oauth-sign-in.ts:54-84`; `web/src/components/auth/oauth-callback-page.tsx:52-111`; `web/src/crypto/client.ts:32-74` (F1 — no `getRefreshToken`); `web/src/lib/session.ts:25-33,102-113`; `web/src/lib/use-crypto-bridge.ts:108-110`; `web/src/lib/use-unlocked-crypto-bridge.ts:11-18`; `web/src/lib/oauth.ts:50-54` (nonce); `web/src/lib/pending-pair.ts`; new `web/src/lib/pending-stepup.ts`, new `web/src/app/(public)/reset-keys/page.tsx` |
| 3 | `web/src/lib/config.ts:35`; `web/src/app/(public)/signin/page.tsx:88-116`; `server/src/config.ts:47,170-173`; `server/src/app/routes/password.ts:42,56,62,113,119,178,184,214,220` (gate handlers + add `404: ErrorSchema`) |
| 4 | new `web/src/app/(public)/reset-keys/page.tsx`; today's `web/src/app/(public)/password/page.tsx:204-214` |
| 5 | `web/src/features/settings/components/DevicesSection.tsx:73-94,163-175` |
| 6 | `server/src/auth/oauth.ts:18-22,51-103,168-171`; `web/src/lib/oauth.ts:69`; `server/src/app/routes/oauth.ts:133-151`; `server/src/db/schema.ts:60-61` |
| 7 | `web/src/features/auth/require-auth.tsx:14,75-77`; `web/src/app/(public)/signin/page.tsx` |
| 8 | `wire/src/rows.ts:36-43`; `wire/src/updates.ts:85-89`; `web/src/features/session-list/use-machine-presence.ts:55-62`; `web/src/features/session-list/status.ts:135`; `web/src/features/session-list/live-source.ts:364-372`; `cli/src/auth/tokenProvider.ts:39-41`; `cli/src/daemon/machineClient.ts:457-475` |
| 9 | `web/src/app/(public)/password/page.tsx:177,238` |
| 10 | `web/src/components/auth/pin-setup-form.tsx:43-47`; `web/src/components/auth/pin-unlock-form.tsx:37-39`; `web/src/app/(public)/password/page.tsx:206-209` |
| 11 | `docs/known-issues.md:2-6,14,28-29,100-139` (issue #4 — delete); `docs/known-issues.md:24,588+` (issue #14 — delete once item 1 lands); `server/src/app/socket.ts:164-194` (re-validation already landed) |
| 12 | `web/src/lib/complete-password-sign-in.ts:112,123-130,142-186` (incl. `rotateKeyEpoch` — same drop); `web/src/app/(public)/password/page.tsx:99-130`; `web/src/lib/complete-oauth-sign-in.ts:86-91` |

---

## Master TODO checklist (execution units)

Read by `.claude/workflows/falcon-bugfix-workflow.js` (repurposed for this doc — see that
file's own header comment). Unit ids use an `AH*` prefix (Auth Hardening) so they never
collide with `plan-v2.md`'s `U*`, `docs/bug-fix-plan.md`'s `BF*`, or `docs/plan-flows-3-4-5.md`'s
`FL*` units, even if all four run against the same branch.

**Unit kinds** (same semantics as the other tracks): `inline` — small, disjoint-file fixes
batched into one pass; `bundle` — co-located/tightly-coupled tasks, one worktree, one pipeline;
`solo` — big or security-sensitive work that earns the full pipeline alone; `human` — needs a
live stack/browser, excluded from automation.

A unit is done only when every sub-item is checked AND its merge to `v2-pty-injection` is
ancestry-proven.

**Hard sequencing (do not violate):** AH3 is gated on AH2 — the OAuth-only step-up path must be
merged and verified before password auth is gated off, or an OAuth-only account with a forgotten
PIN has zero reset path (see `## 0. Product decision & why`, cross-cutting sequencing). AH11 is
gated on AH1 (it closes `known-issues.md` issue #14, which AH1 fixes).

- [x] **AH1 `[inline]` "pair-silent-refresh"** (item 1 — `web/src/app/(public)/pair/page.tsx`)
  - [x] Import `silentRefresh` from `@/lib/session`; call it before the `isSignedIn()` gate,
        mirroring `require-auth.tsx`'s `ensureSession`
  - [x] Split the bounce condition: `!identity` still bounces immediately; `!isSignedIn()` tries
        `silentRefresh()` first and only bounces if that also fails
  - [x] Add the just-in-case retry inside `approve()` when `getToken()` comes back null (closes
        `known-issues.md` #14's second recommendation, since `/pair` sits outside
        `RequireAuth`'s 60s re-check interval)
  - [x] Test: signed-in-but-token-expired visitor to `/pair#eph` lands on the confirm screen, not
        `/signin/`

- [x] **AH2 `[solo]` "oauth-stepup-reset-keys"** (items 2+4 — new `/reset-keys/` route; ships as
      one unit since item 4 describes item 2's own final UI)
  - [x] New `web/src/app/(public)/reset-keys/page.tsx`: reachable from `RequireAuth`'s
        `no-identity` dead-end, the `needs-unlock` "Forgot your PIN?" link, and (new) the
        `set-pin` OAuth callback branch on a 409 (see below)
  - [x] "Confirm it's you" step: Google/GitHub buttons reusing `beginGoogleSignIn`/
        `beginGithubSignIn` unchanged; stash a step-up flag (provider + short TTL) via a new
        `pending-stepup.ts`, mirroring `pending-pair.ts`'s shape
  - [x] Callback branch (`oauth-callback-page.tsx` + both provider pages): if the step-up flag is
        set, `consume` (not peek) it, validate the returned provider matches, **actually complete
        sign-in** (`register()` + `setToken()`) so a fresh refresh token exists, then carry
        `{provider, oauthProof, refreshToken}` to `/reset-keys/` via **module-level in-memory
        state** (never `sessionStorage` — it's an SPA `router.replace` hop)
  - [x] `/reset-keys/` PIN step: use `useCryptoBridge()` (not `useUnlockedCryptoBridge()`); guard
        must include both `no-identity` and `needs-unlock`; new `rotateKeyEpochOAuth(bridge,
        refreshToken, provider, oauthProof, newPin)` takes the refresh token as a parameter (no
        `bridge.getRefreshToken()` — does not exist, must not be added, breaks the F1 invariant)
  - [x] `rotateKeyEpochOAuth` consumes pending-pair (`consumePendingPair()`) for its `nextUrl`,
        same as `completeOAuthSignIn` already does
  - [x] Fold in the returning-OAuth-user 409 fix: `completeOAuthSignIn`'s `set-pin` branch
        detects a `keys/bind` 409 and offers "Pair from another device" (primary) or
        `/reset-keys/`, instead of a generic "Sign-in failed" after a now-orphaned PIN
  - [x] Button hierarchy: "Pair from another device" primary, "Reset keys" demoted/outlined with
        its own confirm step (item 4)
  - [x] Tests: step-up completes and calls `keys/bind` with `stepUpProof.kind === "oauth"`;
        `needs-unlock` entrant reaches the PIN step; stale/mismatched-provider stash is rejected,
        not silently diverted; a normal sign-in started after an abandoned step-up is NOT hijacked
  - [ ] `[human]` live: real Google + real GitHub step-up round trip against a local dev stack

- [x] **AH3 `[solo]` "gate-password-prod"** (item 3 — depends on AH2 merged+verified)
  - [x] Extend the `DEV_AUTH_ENABLED`/`FALCON_DEV_AUTH` pattern to email+password: hide the
        `/signin/` link behind the same flag; reject all four `password.ts` handlers
        server-side when the flag is off; boot-time error if enabled under `NODE_ENV=production`
  - [x] Add `404: ErrorSchema` to the gated routes' Zod response schemas
  - [x] Confirm (or add a migration note for) the precondition: no production account currently
        depends on email+password as its only identity
  - [x] Tests: gated routes return 404 when the flag is off; boot fails loudly if misconfigured
        in production

- [x] **AH5 `[inline]` "devices-revoke-confirm"** (item 5 —
      `web/src/features/settings/components/DevicesSection.tsx`)
  - [x] Add an inline confirm step to `handleRevoke` before calling `revokeSession`
  - [x] Test: revoke requires a second confirmation click; cancel leaves the session intact

- [x] **AH6 `[bundle]` "capture-oauth-email"** (item 6 — independent of AH1-AH5)
  - [x] `verifyGoogleIdToken`: read `email`/`email_verified` claims into `OAuthIdentity`
  - [x] `verifyGithubAccessToken`: add `user:email` scope in `web/src/lib/oauth.ts`'s
        `beginGithubSignIn`, call `/user/emails`, use the primary+verified address
  - [x] `routes/oauth.ts`'s register handler: persist `email`/`emailVerified` onto the
        `auth_identities` insert (columns already exist, no migration)
  - [x] Add the missing read path (e.g. a field on the existing session/account-info response)
        so the captured email is actually surfaced somewhere, per item 6's own "display" goal
  - [x] Tests: injectable-fetcher unit tests for both providers (unverified email is stored but
        flagged, never treated as authoritative)

- [x] **AH7 `[inline]` "session-expiry-reason"** (item 7 —
      `web/src/features/auth/require-auth.tsx`, `web/src/app/(public)/signin/page.tsx`)
  - [x] Carry a reason through the redirect (query param read via `window.location.search` in an
        effect, matching the existing callback-page convention — no `useSearchParams`)
  - [x] Sign-in page renders "Your session expired — sign in again" banner when present
  - [x] Test: a failed `silentRefresh()` redirect shows the banner; a plain unauthenticated visit
        does not

- [x] **AH8 `[bundle]` "machine-status-reauth"** (item 8 — independent of AH1-AH7)
  - [x] Server: minimum-viable query — most recent `cli-daemon` `device_sessions` row for a
        machine is revoked ⇒ machine needs re-auth (no schema change; `clientKind`/`machineId`
        already exist)
  - [x] Thread the signal through machine presence (`use-machine-presence.ts`) as a distinct
        status, separate from "Offline"
  - [x] Web: render "Needs re-authentication" chip distinctly from "Offline"
  - [x] Tests: a revoked daemon session surfaces the new status; a merely-asleep machine still
        shows "Offline"

- [x] **AH9 `[inline]` "remove-leaked-doc-strings"** (item 9 —
      `web/src/app/(public)/password/page.tsx:177,238`)
  - [x] Replace both `CardDescription` strings with real user-facing copy
  - [x] Test/verify: grep confirms no `issue-4-plan.md` string remains in any `.tsx`

- [ ] **AH10 `[inline]` "pin-copy-this-browser-only"** (item 10 — `pin-setup-form.tsx`,
      `pin-unlock-form.tsx`, `password/page.tsx`)
  - [ ] Reword copy to say "protects this browser only," not the whole account

- [ ] **AH11 `[inline]` "known-issues-cleanup"** (item 11 — depends on AH1 merged+verified)
  - [ ] Delete `known-issues.md` issue #4's row + section (its own convention: remove once
        resolved and verified, don't leave a permanent "Fixed" entry) — refresh-token mechanism
        it describes as missing already shipped (`tokenProvider.ts`, `machineClient.ts`)
  - [ ] Delete issue #14's row + section once AH1 is verified-merged (same bug, independently
        discovered)
  - [ ] Note the still-open item — periodic WS re-validation — is actually already landed
        (`server/src/app/socket.ts:164-194`); nothing left to carry forward from #4

- [ ] **AH12 `[inline]` "password-signin-pending-pair"** (item 12 —
      `web/src/lib/complete-password-sign-in.ts`)
  - [ ] `completePasswordSignIn` and `completePasswordSignUp` resume a pending pair
        (`consumePendingPair()`) instead of hardcoding `nextUrl: "/"`, mirroring
        `completeOAuthSignIn`
  - [ ] `rotateKeyEpoch`'s own hardcoded `nextUrl: "/"` gets the same one-line fix
  - [ ] Test: `/pair#eph` → forced sign-in via email+password → lands back on `/pair/#eph`, not
        Home
