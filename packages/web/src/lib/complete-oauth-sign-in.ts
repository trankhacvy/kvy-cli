/**
 * Shared completion step for both OAuth callback pages. Finds-or-creates this login
 * identity, wraps (or reuses) this device's key material, and binds it via
 * `keys/challenge`+`keys/bind`.
 *
 * If this browser already holds a provisioned identity for this account, it is reused
 * rather than generating a second one; `/v1/auth/register`'s upsert-by-(provider,subject)
 * semantics make this a safe rebind. The existing-identity path returns the refresh token
 * to the caller to persist once its own post-login unlock step confirms the worker is ready.
 *
 * The refresh token from `register()` is never stored in localStorage - the new-identity
 * path persists it via `bridge.init(masterSecret, refreshToken)`; the existing-identity
 * path returns it to the caller to persist via `bridge.setRefreshToken`.
 */
import { getRandomBytes, ready } from "@kvy/crypto/web";
import type { CryptoBridgeClient, KeyProtection } from "@/crypto";
import { derivePrfMasterSecret } from "@/crypto";
import { keysBind, keysChallenge, register } from "./api.js";
import { describeThisBrowser } from "./describe-device.js";
import { consumePendingPair } from "./pending-pair.js";
import { setToken } from "./session.js";

export type OAuthSignInOutcome =
  | { kind: "existing-identity"; nextUrl: string; refreshToken: string }
  | { kind: "new-identity"; nextUrl: string };

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

export async function completeOAuthSignIn(
  bridge: CryptoBridgeClient,
  provider: "google" | "github",
  oauthProof: string,
  protection: KeyProtection,
): Promise<OAuthSignInOutcome> {
  const { token, refreshToken } = await register({
    oauthProvider: provider,
    oauthProof,
    label: describeThisBrowser(),
  });
  setToken(token);

  // Scoped to THIS account. Unscoped, "a record exists" meant "this account's record", so
  // signing in as B on a browser holding A's keys reused A's key tree, skipped the bind
  // entirely, and left every one of B's sessions failing `setSessionKey` in silence.
  // Unlike the password path this branch is NOT deletable — `/v1/auth/register` is
  // find-or-create (server/src/app/routes/oauth.ts:130-150), so a returning user reusing
  // their own key material is the normal case.
  const accountId = decodeAccountId(token);
  let identity = await bridge.getIdentity(accountId);
  const isNewIdentity = !identity;
  if (!identity) {
    await ready;
    let masterSecret: Uint8Array;
    if (protection.mode === "passkey") {
      if (!protection.credentialId) {
        throw new Error("Internal: passkey mode requires a credentialId");
      }
      const derived = await derivePrfMasterSecret(protection.credentialId, accountId);
      if (!derived) throw new Error("Passkey authentication failed. Please try again.");
      masterSecret = derived;
    } else {
      masterSecret = getRandomBytes(32);
    }
    await bridge.init(masterSecret, refreshToken, accountId, protection);
    identity = await bridge.getIdentity(accountId);
  }

  if (!identity) {
    // Unreachable in practice — `bridge.init` above always leaves the worker
    // with a keyTree set, so the re-check can only fail to find one if the
    // worker itself is broken. Guarded anyway per "no silent failures".
    throw new Error("crypto bridge failed to provision an identity");
  }

  if (isNewIdentity) {
    const { nonce } = await keysChallenge(token);
    const proof = await bridge.bindKeysProof(accountId, nonce);
    await keysBind(token, {
      signPubKey: proof.signPubKey,
      contentPubKey: proof.contentPubKey,
      nonce,
      signature: proof.signature,
    });
  }

  const pendingEphPub = consumePendingPair();
  const nextUrl = pendingEphPub ? `/pair/#${pendingEphPub}` : "/dashboard/";

  return isNewIdentity
    ? { kind: "new-identity", nextUrl }
    : { kind: "existing-identity", nextUrl, refreshToken };
}
