/**
 * Client-only OAuth redirect flows for the two providers `POST
 * /v1/auth/register` accepts (design §5.2 "Sign-up"). Both are pure browser
 * navigations — no popup, no third-party SDK script (kvy-system-design.md
 * §12: "strict CSP … no third-party scripts") — chosen specifically because
 * this is a static export with no server of its own to complete a flow on
 * its behalf:
 *
 *  - **Google**: OpenID Connect implicit flow (`response_type=id_token`).
 *    Google redirects back with a signed ID token in the URL *fragment*
 *    (never sent to any server) — that token is used as-is as `oauthProof`.
 *  - **GitHub**: standard authorization-code flow. GitHub's token endpoint
 *    requires the app's client secret and has no browser CORS allowance, so
 *    the resulting `code` is hosted through the Kvy server's
 *    `/v1/auth/oauth/github/exchange` proxy to obtain the access token used
 *    as `oauthProof` (see packages/server/src/auth/oauth.ts).
 *
 * `state` (both) and `nonce` (Google only, embedded in the ID token) guard
 * against CSRF/replay; both are one-time values round-tripped through
 * `sessionStorage`, cleared on first use.
 */
import { GITHUB_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_ID } from "./config.js";

const STATE_KEY = "kvy:oauth:state";

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function callbackUrl(provider: "google" | "github"): string {
  return `${window.location.origin}/auth/callback/${provider}/`;
}

/** Redirects the browser to Google's OIDC implicit-flow consent screen. */
export function beginGoogleSignIn(): void {
  if (!GOOGLE_OAUTH_CLIENT_ID) {
    throw new Error("Google sign-in is not configured");
  }
  const state = randomToken();
  window.sessionStorage.setItem(STATE_KEY, state);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl("google"));
  url.searchParams.set("response_type", "id_token");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("state", state);
  // Google echoes `nonce` back inside the signed ID token's payload — the
  // server's verifier doesn't check it (it only needs proof of a valid,
  // freshly-scoped token), but including it is a defense-in-depth replay
  // guard other implementations of this endpoint may add later.
  url.searchParams.set("nonce", randomToken());
  window.location.href = url.toString();
}

/** Redirects the browser to GitHub's authorization-code consent screen. */
export function beginGithubSignIn(): void {
  if (!GITHUB_OAUTH_CLIENT_ID) {
    throw new Error("GitHub sign-in is not configured");
  }
  const state = randomToken();
  window.sessionStorage.setItem(STATE_KEY, state);

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", GITHUB_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl("github"));
  // `user:email` (in addition to `read:user`) lets the server's `/user/emails` call
  // (auth/oauth.ts's `verifyGithubAccessToken`) see the primary verified address even
  // for accounts that keep their email private — `/user` alone only returns it when
  // the user made it public.
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);
  window.location.href = url.toString();
}

/** Consumes (and clears) the one-time state token stashed before redirecting. */
function consumeExpectedState(): string | null {
  const expected = window.sessionStorage.getItem(STATE_KEY);
  window.sessionStorage.removeItem(STATE_KEY);
  return expected;
}

export type OAuthCallbackResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Parses Google's implicit-flow redirect back (`#id_token=...&state=...`). */
export function consumeGoogleCallback(hash: string): OAuthCallbackResult<{ idToken: string }> {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const expectedState = consumeExpectedState();

  if (params.get("error")) {
    return { ok: false, error: `Google sign-in was cancelled or failed (${params.get("error")}).` };
  }
  const state = params.get("state");
  if (!expectedState || !state || state !== expectedState) {
    return { ok: false, error: "Sign-in request expired or was tampered with. Please try again." };
  }
  const idToken = params.get("id_token");
  if (!idToken) {
    return { ok: false, error: "Google did not return a sign-in token." };
  }
  return { ok: true, value: { idToken } };
}

/** Parses GitHub's authorization-code redirect back (`?code=...&state=...`). */
export function consumeGithubCallback(
  search: string,
): OAuthCallbackResult<{ code: string; redirectUri: string }> {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  const expectedState = consumeExpectedState();

  if (params.get("error")) {
    return { ok: false, error: `GitHub sign-in was cancelled or failed (${params.get("error")}).` };
  }
  const state = params.get("state");
  if (!expectedState || !state || state !== expectedState) {
    return { ok: false, error: "Sign-in request expired or was tampered with. Please try again." };
  }
  const code = params.get("code");
  if (!code) {
    return { ok: false, error: "GitHub did not return an authorization code." };
  }
  return { ok: true, value: { code, redirectUri: callbackUrl("github") } };
}
