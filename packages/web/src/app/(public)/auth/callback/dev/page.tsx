"use client";

import { OAuthCallbackPage } from "@/components/auth/oauth-callback-page";

// `FALCON_DEV_AUTH` local-testing bypass (auth/oauth.ts) — unlike the
// google/github callbacks, there's no external provider redirect to resolve
// a proof from; the server's "dev" verifier ignores the proof's content, so
// this resolves instantly with a fixed literal. Reuses `OAuthCallbackPage`
// (identity generation, `POST /v1/auth/register`, recovery-code reveal,
// pending-pair redirect) unchanged — the only thing dev auth skips is steps
// 1-2 of a real OAuth flow (redirect out, redirect back with a proof).
export default function DevCallbackPage() {
  return (
    <OAuthCallbackPage provider="dev" resolveProof={async () => ({ ok: true, value: "dev" })} />
  );
}
