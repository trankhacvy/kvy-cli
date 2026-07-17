/**
 * Shared completion step for both OAuth callback pages
 * (`src/app/auth/callback/google`, `.../github`) — design §5.2 "Sign-up":
 * generate (or reuse) this device's identity, bind it via
 * `POST /v1/auth/register`, and store the resulting session token.
 *
 * If this browser already holds a provisioned identity (`getIdentity()`
 * resolves non-null — e.g. the user is re-linking an OAuth account rather
 * than signing up fresh), that identity is reused as-is rather than
 * generating (and silently orphaning) a second one; `/v1/auth/register`'s
 * upsert-by-`signPubKey` semantics make this a safe rebind. Only the
 * genuinely-new-identity path has a recovery code to show — there is
 * nothing new to back up when reusing an existing one.
 *
 * Deriving the key tree itself is left entirely to the worker (`bridge.init`
 * + `bridge.getIdentity` / `bridge.exportRecoveryCode`) rather than calling
 * `deriveKeyTree` here on the main thread — the crypto-bridge's whole premise
 * (protocol.ts, worker-handler.ts) is that secret key material never exists
 * outside worker memory; computing the tree here would briefly hold both
 * derived secret keys in the page's JS heap for no benefit, since the worker
 * already exposes exactly the two public-facing views this flow needs.
 */
import { getRandomBytes, ready } from "@falcon/crypto/web";
import type { CryptoBridgeClient } from "@/crypto";
import { register } from "./api.js";
import { consumePendingPair } from "./pending-pair.js";
import { setToken } from "./session.js";

export type OAuthSignInOutcome =
  | { kind: "existing-identity"; nextUrl: string }
  | { kind: "new-identity"; recoveryCode: string; nextUrl: string };

export async function completeOAuthSignIn(
  bridge: CryptoBridgeClient,
  provider: "google" | "github" | "dev",
  oauthProof: string,
): Promise<OAuthSignInOutcome> {
  let identity = await bridge.getIdentity();
  let recoveryCode: string | null = null;

  if (!identity) {
    await ready;
    const masterSecret = getRandomBytes(32);
    await bridge.init(masterSecret);
    recoveryCode = await bridge.exportRecoveryCode();
    identity = await bridge.getIdentity();
  }

  if (!identity) {
    // Unreachable in practice — `bridge.init` above always leaves the worker
    // with a keyTree set, so the re-check can only fail to find one if the
    // worker itself is broken. Guarded anyway per "no silent failures".
    throw new Error("crypto bridge failed to provision an identity");
  }

  const { token } = await register({
    oauthProvider: provider,
    oauthProof,
    signPubKey: identity.signPubKey,
    contentPubKey: identity.contentPubKey,
  });
  setToken(token);

  const pendingEphPub = consumePendingPair();
  const nextUrl = pendingEphPub ? `/pair/#${pendingEphPub}` : "/";

  return recoveryCode
    ? { kind: "new-identity", recoveryCode, nextUrl }
    : { kind: "existing-identity", nextUrl };
}
