/**
 * A wrapping key derived from a passkey's WebAuthn PRF extension
 * (docs/auth-ux-overhaul-plan.md §5.2).
 *
 * Unlike `device-key.ts`'s stored `CryptoKey`, this key material never exists at rest:
 * it is re-derived per page-load from the authenticator, gated by a user-verification
 * gesture (Touch ID / Windows Hello / Android biometric). That is what makes it a real
 * at-rest control — copying the browser profile yields ciphertext and nothing that can
 * decrypt it.
 *
 * It still does not defend against an XSS running *after* the gesture, in an unlocked
 * page. Nothing stored in a browser does.
 *
 * Every function returns null rather than throwing when PRF is unavailable: no platform
 * authenticator, an older browser, a credential created before PRF was requested, or a
 * user who dismissed the prompt.
 *
 * ⚠️ MAIN THREAD ONLY. WebAuthn lives on `Navigator`, not `WorkerNavigator` —
 * `navigator.credentials` does not exist inside a Web Worker. The crypto worker therefore
 * cannot derive this itself: the main thread derives the (non-extractable) `CryptoKey` and
 * passes the handle across `postMessage`, which structured clone supports. The raw key
 * bytes never exist on either side.
 */

const PRF_SALT = new TextEncoder().encode("kvy-key-wrap-v1") as BufferSource;
const RP_NAME = "Kvy";

export async function isPrfAvailable(): Promise<boolean> {
  if (typeof window === "undefined" || !window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/**
 * Create a passkey for this account with the PRF extension requested, and return its
 * credential id. Null when the platform declines, the user dismisses, or PRF is not
 * actually enabled on the resulting credential (in which case the caller must fall back
 * to `device-key.ts` rather than silently storing something it cannot unwrap later).
 */
export async function createPrfCredential(accountLabel: string): Promise<Uint8Array | null> {
  if (!(await isPrfAvailable())) return null;
  try {
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: RP_NAME, id: window.location.hostname },
        user: { id: userId, name: accountLabel, displayName: accountLabel },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "required",
          userVerification: "required",
        },
        extensions: { prf: {} },
      },
    })) as PublicKeyCredential | null;
    if (!credential) return null;
    if (credential.getClientExtensionResults().prf?.enabled !== true) return null;
    return new Uint8Array(credential.rawId);
  } catch {
    return null;
  }
}

export async function derivePrfWrapKey(credentialId: Uint8Array): Promise<CryptoKey | null> {
  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: credentialId as BufferSource, type: "public-key" }],
        userVerification: "required",
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    })) as PublicKeyCredential | null;

    const secret = assertion?.getClientExtensionResults().prf?.results?.first;
    if (!secret) return null;

    return await crypto.subtle.importKey(
      "raw",
      secret as BufferSource,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    return null;
  }
}
