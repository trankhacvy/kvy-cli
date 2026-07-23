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
import { setToken } from "./session.js";
import { markCryptoBridgeUnlocked } from "./use-crypto-bridge.js";

export interface PasswordSignInOutcome {
  nextUrl: string;
}

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
): Promise<PasswordSignInOutcome> {
  const { token, refreshToken } = await passwordRegister({ email, password });
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

  return { nextUrl: "/" };
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
  return { nextUrl: "/", refreshToken };
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
