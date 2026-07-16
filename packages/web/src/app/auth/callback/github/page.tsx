"use client";

import { OAuthCallbackPage } from "@/components/auth/oauth-callback-page";
import { ApiError, exchangeGithubCode } from "@/lib/api";
import { consumeGithubCallback } from "@/lib/oauth";

// GitHub's authorization-code redirect target (`?code=...&state=...`). The
// code is exchanged for an access token via the Falcon server's
// `/v1/auth/oauth/github/exchange` proxy — GitHub's token endpoint needs the
// app's client secret and has no browser-CORS path (see
// packages/server/src/auth/oauth.ts).
export default function GithubCallbackPage() {
  return (
    <OAuthCallbackPage
      provider="github"
      resolveProof={async () => {
        const result = consumeGithubCallback(window.location.search);
        if (!result.ok) return { ok: false, error: result.error };
        try {
          const { accessToken } = await exchangeGithubCode(result.value);
          return { ok: true, value: accessToken };
        } catch (err) {
          const message = err instanceof ApiError ? err.message : "GitHub sign-in failed.";
          return { ok: false, error: message };
        }
      }}
    />
  );
}
