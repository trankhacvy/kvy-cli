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
 */
import {
  deriveKeyTree,
  encodeBase64,
  encodeRecoveryCode,
  getRandomBytes,
  ready,
} from "@falcon/crypto/web";
import type { CryptoBridgeClient } from "@/crypto";
import { register } from "./api.js";
import { consumePendingPair } from "./pending-pair.js";
import { setToken } from "./session.js";

export type OAuthSignInOutcome =
  | { kind: "existing-identity"; nextUrl: string }
  | { kind: "new-identity"; recoveryCode: string; nextUrl: string };

export async function completeOAuthSignIn(
  bridge: CryptoBridgeClient,
  provider: "google" | "github",
  oauthProof: string,
): Promise<OAuthSignInOutcome> {
  const existing = await bridge.getIdentity();

  let signPubKey: string;
  let contentPubKey: string;
  let recoveryCode: string | null = null;

  if (existing) {
    signPubKey = existing.signPubKey;
    contentPubKey = existing.contentPubKey;
  } else {
    await ready;
    const masterSecret = getRandomBytes(32);
    const tree = deriveKeyTree(masterSecret);
    signPubKey = encodeBase64(tree.signing.publicKey);
    contentPubKey = encodeBase64(tree.content.publicKey);
    recoveryCode = encodeRecoveryCode(masterSecret);
    await bridge.init(masterSecret);
  }

  const { token } = await register({
    oauthProvider: provider,
    oauthProof,
    signPubKey,
    contentPubKey,
  });
  setToken(token);

  const pendingEphPub = consumePendingPair();
  const nextUrl = pendingEphPub ? `/pair/#${pendingEphPub}` : "/";

  return recoveryCode
    ? { kind: "new-identity", recoveryCode, nextUrl }
    : { kind: "existing-identity", nextUrl };
}
