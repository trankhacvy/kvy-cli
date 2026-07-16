"use client";

import { OAuthCallbackPage } from "@/components/auth/oauth-callback-page";
import { consumeGoogleCallback } from "@/lib/oauth";

// Google's OIDC implicit-flow redirect target — the ID token arrives in the
// URL fragment (`#id_token=...&state=...`), which never leaves the browser.
export default function GoogleCallbackPage() {
  return (
    <OAuthCallbackPage
      provider="google"
      resolveProof={async () => {
        const result = consumeGoogleCallback(window.location.hash);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, value: result.value.idToken };
      }}
    />
  );
}
