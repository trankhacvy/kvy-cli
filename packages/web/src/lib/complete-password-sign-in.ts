/**
 * issue-4-plan.md §5.2/§6.3: email+password sign-up/sign-in, the password-identity
 * sibling of `complete-oauth-sign-in.ts`. Unlike OAuth (where the server never sees a
 * password and the flow is "prove an external identity, then bind local keys"),
 * register/login here mint a session first — key binding is a separate step
 * afterward, using `keys/challenge` + `keys/bind` (§6.2) once the account is
 * authenticated.
 *
 * issue-4-plan.md §6.1: the generated `masterSecret` is PIN-wrapped at rest
 * (`bridge.init(masterSecret, pin, refreshToken)`) — signup collects a PIN alongside
 * email/password. Security review finding F1: the refresh token from
 * `passwordRegister`/`passwordLogin` is PIN-wrapped the same way (never `localStorage`)
 * — signup persists it via `init` directly; sign-in returns it to the caller
 * (`password/page.tsx`) to persist via `bridge.setRefreshToken` once the post-login
 * unlock step confirms the worker is unlocked (sign-in itself doesn't take a `bridge`
 * — whether this device's crypto worker is even unlocked yet is a separate concern,
 * see `lib/use-unlocked-crypto-bridge.ts`).
 *
 * §6.2/§6.4's "lost PIN -> rotate epoch" flow lives in `rotateKeyEpoch` below: a known
 * account, on a browser that either has no local identity or whose PIN nobody
 * remembers, generates a brand-new masterSecret + PIN and rotates the account's bound
 * key material — fenced by a real step-up proof (password re-entry) and the
 * "other devices online" 409 interlock (`keys/bind`'s own check).
 */
import { getRandomBytes, ready } from "@falcon/crypto/web";
import type { CryptoBridgeClient } from "@/crypto";
import { ApiError, keysBind, keysChallenge, passwordLogin, passwordRegister } from "./api.js";
import { consumePendingPair } from "./pending-pair.js";
import { setToken } from "./session.js";
import { markCryptoBridgeUnlocked } from "./use-crypto-bridge.js";

export interface PasswordSignInOutcome {
  nextUrl: string;
}

/** `completePasswordSignUp`'s outcome — distinct from `PasswordSignInOutcome` above because
 * register (unlike login) has a second, non-error terminal state: `password.ts`'s §5.2
 * no-enumeration branch for an already-registered email returns the exact same
 * `{success:true}` shape as a real sign-up, but with `token`/`refreshToken` both `""` — there
 * is no session and no account id to bind key material to, so there is nothing left for THIS
 * browser to do but hand the caller back to the sign-in flow. That is a distinct outcome from
 * both "created a new identity" and "network/validation error" (`ApiError`), so it gets its
 * own `kind` rather than being coerced into either.
 */
export type PasswordSignUpOutcome = { kind: "ok"; nextUrl: string } | { kind: "existing-account" };

/** Sign-in's own outcome additionally carries the refresh token — this device's crypto
 * worker isn't necessarily unlocked yet at this point, so it can't be persisted
 * (PIN-wrapped) until the caller's own post-login unlock step completes. */
export interface PasswordSignInResult {
  nextUrl: string;
  refreshToken: string;
}

export type RotateKeyEpochOutcome =
  | { kind: "ok"; nextUrl: string }
  | { kind: "wrong-password"; message: string }
  | { kind: "other-devices-online"; message: string }
  | { kind: "error"; message: string };

function decodeAccountId(accessToken: string): string {
  const parts = accessToken.split(".");
  const payloadPart = parts[1];
  if (parts.length !== 3 || !payloadPart) throw new Error("malformed access token");
  const json = atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/"));
  const payload = JSON.parse(json) as { sub?: unknown };
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("access token missing sub claim");
  }
  return payload.sub;
}

/**
 * `POST /v1/auth/password/register` → generate a `masterSecret`, PIN-wrap it AND the
 * fresh refresh token (`bridge.init`), and bind its key material via
 * `keys/challenge`+`keys/bind` (first bind, epoch 1). Idempotent-ish: re-registering
 * the same email is handled server-side (§5.2 no-enumeration) — this function only
 * ever runs for a genuinely fresh sign-up attempt from the caller's perspective.
 */
export async function completePasswordSignUp(
  bridge: CryptoBridgeClient,
  email: string,
  password: string,
  pin: string,
): Promise<PasswordSignUpOutcome> {
  const { token, refreshToken } = await passwordRegister({ email, password });
  if (!token || !refreshToken) {
    // §5.2 no-enumeration: the server returns this exact `{success:true}` shape (with both
    // fields blanked) when `identifier` is already registered, instead of a 409 that would let
    // a caller distinguish "new" from "existing" from the response alone. There's no session
    // here to `setToken` and no account id to bind key material to — the caller's job is just
    // to route this browser back to sign-in, not to treat it as a failure.
    return { kind: "existing-account" };
  }
  setToken(token);

  let identity = await bridge.getIdentity();
  const isNewIdentity = !identity;
  if (!identity) {
    await ready;
    const masterSecret = getRandomBytes(32);
    await bridge.init(masterSecret, pin, refreshToken);
    markCryptoBridgeUnlocked();
    identity = await bridge.getIdentity();
  }
  if (!identity) {
    throw new Error("crypto bridge failed to provision an identity");
  }
  if (!isNewIdentity) {
    // Reusing an already-provisioned identity (this browser signed up before) — `init`
    // above didn't run, so the fresh refresh token still needs persisting. Requires the
    // worker to already be unlocked, same assumption the reuse branch already made to
    // reach `bindKeysProof` below at all.
    await bridge.setRefreshToken(refreshToken);
  }

  // §6.2: bind this device's key material now that we have an authenticated session.
  // We need the account id to sign the correct payload, but the register response
  // doesn't carry it directly — `keys/bind`'s own nonce round trip doesn't need it
  // client-side either; the WORKER signs accountId‖contentPubKey‖nonce, and the
  // account id is exactly the `sub` claim of the access token we just received.
  const accountId = decodeAccountId(token);
  const { nonce } = await keysChallenge(token);
  const proof = await bridge.bindKeysProof(accountId, nonce);
  await keysBind(token, {
    signPubKey: proof.signPubKey,
    contentPubKey: proof.contentPubKey,
    nonce,
    signature: proof.signature,
  });

  const pendingEphPub = consumePendingPair();
  return { kind: "ok", nextUrl: pendingEphPub ? `/pair/#${pendingEphPub}` : "/" };
}

/**
 * `POST /v1/auth/password/login` — this browser is expected to already hold the
 * matching `masterSecret` in IndexedDB (from a prior sign-up on the SAME browser, or a
 * prior pairing/rotate) — login only re-establishes the session, it never generates or
 * binds new key material. Returns the refresh token rather than persisting it — the
 * caller must do that (via `bridge.setRefreshToken`) once its own post-login unlock
 * step confirms the worker is unlocked.
 */
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

/**
 * issue-4-plan.md §6.2/§6.4 "lost PIN -> rotate epoch": generates a brand-new
 * masterSecret + PIN on THIS browser, and force-rotates the account's bound key
 * material to match — fenced by `keys/bind`'s own explicit-rotation checks (a real
 * step-up password re-proof, and a 409 if another device session is still healthy,
 * since a blind rotation would race that session's next encrypted write under the
 * now-dead epoch). The caller must already hold a valid access token (post-login) and
 * its current refresh token (carried over unchanged — rotating key material doesn't
 * rotate the session, only the master secret).
 */
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
    const pendingEphPub = consumePendingPair();
    return { kind: "ok", nextUrl: pendingEphPub ? `/pair/#${pendingEphPub}` : "/" };
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

export type RotateKeyEpochOAuthOutcome =
  | { kind: "ok"; nextUrl: string }
  | { kind: "identity-mismatch"; message: string }
  | { kind: "other-devices-online"; message: string }
  | { kind: "error"; message: string };

/**
 * The OAuth-step-up twin of `rotateKeyEpoch` above — reachable once email+password auth is
 * dev-only (docs/auth-ux-hardening-plan.md item 3), an OAuth-only account still needs a way to
 * rotate a forgotten-PIN browser's key material. Fenced by the same `keys/bind` explicit-
 * rotation checks, just with an `oauth` `stepUpProof` instead of a re-entered password.
 *
 * Takes the refresh token as a PARAMETER, exactly like `rotateKeyEpoch` does — there is no
 * `bridge.getRefreshToken()` and there must never be one (security review finding F1: the raw
 * refresh token never crosses out of the crypto worker to the main thread). The caller
 * (`/reset-keys/`) carries it in from the OAuth callback's in-memory return channel
 * (`lib/pending-stepup.ts`'s `takeStepUpReturn()`), which is exactly how it got a fresh refresh
 * token to hand over in the first place — this function never fetches or refreshes one itself.
 *
 * `bridge.init` MUST run before `bridge.bindKeysProof` — the worker rejects the signing call
 * when it isn't initialized (`crypto/client.ts`). This means a proof the server later rejects
 * (401 wrong-account / 409 other-devices-online) has already overwritten this browser's
 * previous wrapped record, same as `rotateKeyEpoch`'s password path already accepts; only the
 * "abandoned before submitting" case (never reaching this function at all) genuinely avoids
 * orphaning key material.
 */
export async function rotateKeyEpochOAuth(
  bridge: CryptoBridgeClient,
  accessToken: string,
  refreshToken: string,
  newPin: string,
  step: { provider: "google" | "github"; oauthProof: string },
): Promise<RotateKeyEpochOAuthOutcome> {
  await ready;
  const masterSecret = getRandomBytes(32);
  await bridge.init(masterSecret, newPin, refreshToken);
  markCryptoBridgeUnlocked();

  // `decodeAccountId`/`keysChallenge`/`bindKeysProof` are inside this same try (matching
  // `rotateKeyEpoch`'s scope above) — `keysChallenge` is a network call and can throw an
  // `ApiError` (e.g. a 401 from an already-expired access token) just like `keysBind` does;
  // leaving it unguarded would silently strand the caller on the "rotating" phase forever
  // with no error surfaced ("no silent failures").
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
