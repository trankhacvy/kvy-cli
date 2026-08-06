"use client";

import { OAuthCallbackPage } from "@/components/auth/oauth-callback-page";
import { ApiError, exchangeGoogleCode } from "@/lib/api";
import { consumeGoogleCallback } from "@/lib/oauth";

// Google's authorization-code + PKCE redirect target (`?code=...&state=...`). The
// code is exchanged for an ID token via the Kvy server's
// `/v1/auth/oauth/google/exchange` proxy — Google's "Web application" client type
// requires the client secret in that exchange regardless of PKCE (see
// packages/server/src/auth/oauth.ts).
export default function GoogleCallbackPage() {
  return (
    <OAuthCallbackPage
      provider="google"
      resolveProof={async () => {
        const result = consumeGoogleCallback(window.location.search);
        if (!result.ok) return { ok: false, error: result.error };
        try {
          const { idToken } = await exchangeGoogleCode(result.value);
          return { ok: true, value: idToken };
        } catch (err) {
          const message = err instanceof ApiError ? err.message : "Google sign-in failed.";
          return { ok: false, error: message };
        }
      }}
    />
  );
}
