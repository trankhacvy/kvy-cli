/**
 * Returning-device sign-in (design §5.2 "Sign-in"): this browser already
 * holds a provisioned identity (checked by the caller via `getIdentity()`
 * before calling this), so no OAuth interaction is needed at all — just
 * prove possession of the local key material via a freshly signed
 * challenge.
 */
import type { CryptoBridgeClient } from "@/crypto";
import { signIn } from "./api.js";
import { consumePendingPair } from "./pending-pair.js";
import { setToken } from "./session.js";

export async function completeChallengeSignIn(
  bridge: CryptoBridgeClient,
): Promise<{ nextUrl: string; accountStatus: "found" | "created" }> {
  const challenge = await bridge.signInChallenge();
  const { token, accountStatus } = await signIn({
    publicKey: challenge.signPubKey,
    contentPublicKey: challenge.contentPubKey,
    challenge: challenge.challenge,
    signature: challenge.signature,
  });
  setToken(token);

  const pendingEphPub = consumePendingPair();
  return {
    nextUrl: pendingEphPub ? `/pair/#${pendingEphPub}` : "/",
    accountStatus,
  };
}
