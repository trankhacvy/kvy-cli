/**
 * issue-4-plan.md §5.2/§6.3: email+password sign-up/sign-in, the password-identity
 * sibling of `complete-oauth-sign-in.ts`. Unlike OAuth (where the server never sees a
 * password and the flow is "prove an external identity, then bind local keys"),
 * register/login here mint a session first — key binding is a separate step
 * afterward, using `keys/challenge` + `keys/bind` (§6.2) once the account is
 * authenticated.
 *
 * **Scope note** (docs/issue-4-plan.md Phase 4): this flow does NOT PIN-wrap the
 * generated `masterSecret` — no PIN UI exists in this pass (see the plan doc's
 * recorded Phase 3/5 deviations). `bridge.init` stores it exactly as the existing
 * OAuth flow always has (IndexedDB, worker-only). What's new here is the identity
 * layer (password login + real device sessions), not key custody.
 */
import { getRandomBytes, ready } from "@falcon/crypto/web";
import type { CryptoBridgeClient } from "@/crypto";
import { keysBind, keysChallenge, passwordLogin, passwordRegister } from "./api.js";
import { setSession } from "./session.js";

export interface PasswordSignInOutcome {
  nextUrl: string;
}

/**
 * `POST /v1/auth/password/register` → (if this browser has no identity yet) generate a
 * `masterSecret` and bind its key material via `keys/challenge`+`keys/bind` (first
 * bind, epoch 1). Idempotent-ish: re-registering the same email is handled server-side
 * (§5.2 no-enumeration) — this function only ever runs for a genuinely fresh sign-up
 * attempt from the caller's perspective.
 */
export async function completePasswordSignUp(
  bridge: CryptoBridgeClient,
  email: string,
  password: string,
): Promise<PasswordSignInOutcome> {
  const { token, refreshToken } = await passwordRegister({ email, password });
  setSession({ accessToken: token, refreshToken });

  let identity = await bridge.getIdentity();
  if (!identity) {
    await ready;
    const masterSecret = getRandomBytes(32);
    await bridge.init(masterSecret);
    identity = await bridge.getIdentity();
  }
  if (!identity) {
    throw new Error("crypto bridge failed to provision an identity");
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
 * future pairing flow) — login only re-establishes the session, it never generates or
 * binds new key material.
 */
export async function completePasswordSignIn(
  email: string,
  password: string,
): Promise<PasswordSignInOutcome> {
  const { token, refreshToken } = await passwordLogin({ email, password });
  setSession({ accessToken: token, refreshToken });
  return { nextUrl: "/" };
}

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
