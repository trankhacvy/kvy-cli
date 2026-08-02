/**
 * Email+password sign-up/sign-in. Register/login mint a session first; key binding
 * is a separate step afterward via `keys/challenge` + `keys/bind` once authenticated.
 *
 * The refresh token from `passwordRegister`/`passwordLogin` is never stored in localStorage
 * - signup persists it via `bridge.init`; sign-in returns it to the caller to persist via
 * `bridge.setRefreshToken` once the post-login unlock step completes.
 *
 * The "rotate epoch" flow (`rotateKeyEpoch`) handles a known account whose local key
 * material is absent or inaccessible - generates a fresh masterSecret and force-rotates
 * the account's bound key material, fenced by a step-up proof and the 409 interlock.
 */
import { getRandomBytes, ready } from "@kvy/crypto/web";
import type { CryptoBridgeClient, KeyProtection } from "@/crypto";
import { ApiError, keysBind, keysChallenge, passwordLogin, passwordRegister } from "./api.js";
import { consumePendingPair } from "./pending-pair.js";
import { setToken } from "./session.js";

export interface PasswordSignInOutcome {
  nextUrl: string;
}

/** `completePasswordSignUp`'s outcome. Distinct from `PasswordSignInOutcome` because register
 * has a second non-error terminal state: the server's no-enumeration branch for an already-registered
 * email returns `{success:true}` with blank `token`/`refreshToken` — no session to set up,
 * so the caller routes back to sign-in instead. This `kind` keeps that distinct from both
 * "created a new identity" and a thrown `ApiError`. */
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
 * `POST /v1/auth/password/register` - generates a `masterSecret`, wraps it and the
 * refresh token via `bridge.init`, and binds key material via `keys/challenge`+`keys/bind`.
 * Re-registering the same email is handled server-side (returns blank tokens - see outcome).
 */
export async function completePasswordSignUp(
  bridge: CryptoBridgeClient,
  email: string,
  password: string,
  protection: KeyProtection,
): Promise<PasswordSignUpOutcome> {
  const { token, refreshToken } = await passwordRegister({ email, password });
  if (!token || !refreshToken) {
    // No-enumeration: the server returns {success:true} with blank fields when the email is
    // already registered, rather than a 409 that would distinguish "new" from "existing".
    // No session to set up - the caller routes back to sign-in.
    return { kind: "existing-account" };
  }
  setToken(token);

  // Reaching this line means `passwordRegister` returned a real session, which the server
  // only does for a genuinely NEW account (the already-registered case is the blanked-token
  // branch above). A brand-new account therefore cannot legitimately have key material on
  // this browser — so ALWAYS provision fresh. The old `getIdentity()` reuse branch treated
  // "some record exists" as "this account's record", which meant signing up on a browser
  // that had ANY prior account's keys skipped `init` entirely and tried to bind the other
  // account's public key (the server's own cross-account guard, routes/keys.ts:207, then
  // 409s — so the user got an unexplained dead end instead of an account).
  const accountId = decodeAccountId(token);
  await ready;
  const masterSecret = getRandomBytes(32);
  await bridge.init(masterSecret, refreshToken, accountId, protection);
  const identity = await bridge.getIdentity(accountId);
  if (!identity) {
    throw new Error("crypto bridge failed to provision an identity");
  }

  // Bind this device's key material now that we have an authenticated session.
  // The worker signs accountId‖contentPubKey‖nonce.
  const { nonce } = await keysChallenge(token);
  const proof = await bridge.bindKeysProof(accountId, nonce);
  await keysBind(token, {
    signPubKey: proof.signPubKey,
    contentPubKey: proof.contentPubKey,
    nonce,
    signature: proof.signature,
  });

  const pendingEphPub = consumePendingPair();
  return { kind: "ok", nextUrl: pendingEphPub ? `/pair/#${pendingEphPub}` : "/dashboard/" };
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
  const nextUrl = pendingEphPub ? `/pair/#${pendingEphPub}` : "/dashboard/";
  return { nextUrl, refreshToken };
}

/**
 * Generates a fresh masterSecret and force-rotates the account's bound key material -
 * fenced by `keys/bind`'s explicit-rotation checks (step-up password re-proof, 409 if
 * another device is still healthy). Rotating key material doesn't rotate the session;
 * the caller's current access+refresh tokens carry over unchanged.
 */
export async function rotateKeyEpoch(
  bridge: CryptoBridgeClient,
  accessToken: string,
  refreshToken: string,
  stepUpPassword: string,
  protection: KeyProtection,
): Promise<RotateKeyEpochOutcome> {
  await ready;
  const accountId = decodeAccountId(accessToken);
  const masterSecret = getRandomBytes(32);
  await bridge.init(masterSecret, refreshToken, accountId, protection);

  // Deliberately unscoped: this reads back the identity `init` just provisioned above, for
  // THIS account, in the same call — not a "does this browser already know someone" check,
  // so there is no foreign-record risk to guard against here.
  const identity = await bridge.getIdentity();
  if (!identity) {
    return { kind: "error", message: "Crypto bridge failed to provision new key material." };
  }

  try {
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
    return { kind: "ok", nextUrl: pendingEphPub ? `/pair/#${pendingEphPub}` : "/dashboard/" };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { kind: "wrong-password", message: "That password is incorrect." };
    }
    if (err instanceof ApiError && err.status === 409) {
      return {
        kind: "other-devices-online",
        message:
          "Another device is still signed in. Pair this browser from that device instead of rotating keys blind.",
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
 * OAuth-step-up twin of `rotateKeyEpoch` — for accounts that can't re-enter a password.
 * Fenced by the same `keys/bind` explicit-rotation checks with an `oauth` stepUpProof.
 *
 * Takes the refresh token as a parameter — there is no `bridge.getRefreshToken()` and must
 * never be one (the raw refresh token must never cross out of the crypto worker to the main
 * thread). The caller carries it from the OAuth callback's in-memory return channel.
 *
 * `bridge.init` MUST run before `bridge.bindKeysProof`. A proof the server rejects (401/409)
 * has already overwritten this browser's previous wrapped record - only "abandoned before
 * calling this function" avoids that, same tradeoff the password path accepts.
 */
export async function rotateKeyEpochOAuth(
  bridge: CryptoBridgeClient,
  accessToken: string,
  refreshToken: string,
  protection: KeyProtection,
  step: { provider: "google" | "github"; oauthProof: string },
): Promise<RotateKeyEpochOAuthOutcome> {
  await ready;
  const accountId = decodeAccountId(accessToken);
  const masterSecret = getRandomBytes(32);
  await bridge.init(masterSecret, refreshToken, accountId, protection);

  // `keysChallenge`/`bindKeysProof` are inside this same try (matching `rotateKeyEpoch`'s
  // scope above) — `keysChallenge` is a network call and can throw an `ApiError` (e.g. a 401
  // from an already-expired access token) just like `keysBind` does; leaving it unguarded
  // would silently strand the caller on the "rotating" phase forever with no error surfaced
  // ("no silent failures").
  try {
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
    return { kind: "ok", nextUrl: pendingEphPub ? `/pair/#${pendingEphPub}` : "/dashboard/" };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { kind: "identity-mismatch", message: "That account doesn't match this one." };
    }
    if (err instanceof ApiError && err.status === 409) {
      return {
        kind: "other-devices-online",
        message:
          "Another device is still signed in. Pair this browser from that device instead of rotating keys blind.",
      };
    }
    const message = err instanceof ApiError ? err.message : "Could not rotate keys. Please retry.";
    return { kind: "error", message };
  }
}
