/**
 * Shared completion step for both OAuth callback pages
 * (`src/app/auth/callback/google`, `.../github`) — design §5.2 "Sign-up":
 * find-or-create this login identity, PIN-wrap (or reuse) this device's key
 * material, and bind it via `keys/challenge`+`keys/bind` (§6.2) — the same two-step
 * shape `complete-password-sign-in.ts`'s `completePasswordSignUp` uses, since OAuth
 * and password are both first-class login identities now (§5.5), separate from key
 * custody.
 *
 * If this browser already holds a provisioned identity (`getIdentity()`
 * resolves non-null — e.g. the user is re-linking an OAuth account rather
 * than signing up fresh), that identity is reused as-is rather than
 * generating (and silently orphaning) a second one; `/v1/auth/register`'s
 * upsert-by-`(provider, subject)` semantics make this a safe rebind. Only the
 * genuinely-new-identity path needs a PIN — there is nothing to unlock when
 * reusing an existing one (the caller is expected to already be in an unlocked
 * state, or handle `needs-unlock` itself, mirroring `/password/`'s post-login step).
 *
 * Security review finding F1: the refresh token from `register()` is PIN-wrapped
 * (never `localStorage`) — the new-identity path persists it directly via
 * `bridge.init(masterSecret, pin, refreshToken)`; the existing-identity path returns it
 * to the caller (`oauth-callback-page.tsx`) to persist via `bridge.setRefreshToken`
 * once its own post-login unlock step confirms the worker is unlocked.
 */
import { getRandomBytes, ready } from "@kvy/crypto/web";
import type { CryptoBridgeClient, KeyProtection } from "@/crypto";
import { keysBind, keysChallenge, register } from "./api.js";
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
  const { token, refreshToken } = await register({ oauthProvider: provider, oauthProof });
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
    const masterSecret = getRandomBytes(32);
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
