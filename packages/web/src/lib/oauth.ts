/**
 * Client-only OAuth redirect flows. Pure browser navigations - no popup, no
 * third-party SDK script.
 *
 * - Google: authorization-code flow with PKCE. Google's "Web application" client
 *   type requires the client secret in the code→token exchange regardless of
 *   PKCE, so the `code` (+ `codeVerifier`) goes through the server's
 *   `/v1/auth/oauth/google/exchange` proxy, mirroring GitHub below.
 * - GitHub: authorization-code flow. GitHub's token endpoint requires a client
 *   secret and has no CORS allowance, so the `code` goes through the server's
 *   `/v1/auth/oauth/github/exchange` proxy.
 *
 * `state` (both flows) and the PKCE `codeVerifier` (Google only) guard against
 * CSRF/replay; both are one-time values round-tripped through `sessionStorage`.
 */
import { GITHUB_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_ID } from "./config.js";

const STATE_KEY = "kvy:oauth:state";
const GOOGLE_VERIFIER_KEY = "kvy:oauth:google:verifier";

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function callbackUrl(provider: "google" | "github"): string {
  return `${window.location.origin}/auth/callback/${provider}/`;
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Redirects the browser to Google's authorization-code + PKCE consent screen. */
export async function beginGoogleSignIn(): Promise<void> {
  if (!GOOGLE_OAUTH_CLIENT_ID) {
    throw new Error("Google sign-in is not configured");
  }
  const codeVerifier = randomToken() + randomToken();
  // Hashed before anything is written to sessionStorage — if `crypto.subtle` is
  // unavailable (e.g. a non-secure origin), this throws with no stashed state to
  // clean up, and the caller's rejection handler is the only thing that fires.
  const codeChallenge = await sha256Base64Url(codeVerifier);

  const state = randomToken();
  window.sessionStorage.setItem(STATE_KEY, state);
  window.sessionStorage.setItem(GOOGLE_VERIFIER_KEY, codeVerifier);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl("google"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
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

/** Consumes (and clears) the one-time PKCE verifier stashed before redirecting. */
function consumeGoogleVerifier(): string | null {
  const verifier = window.sessionStorage.getItem(GOOGLE_VERIFIER_KEY);
  window.sessionStorage.removeItem(GOOGLE_VERIFIER_KEY);
  return verifier;
}

/** Parses Google's authorization-code redirect back (`?code=...&state=...`). */
export function consumeGoogleCallback(
  search: string,
): OAuthCallbackResult<{ code: string; codeVerifier: string; redirectUri: string }> {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  const expectedState = consumeExpectedState();
  const codeVerifier = consumeGoogleVerifier();

  if (params.get("error")) {
    return { ok: false, error: `Google sign-in was cancelled or failed (${params.get("error")}).` };
  }
  const state = params.get("state");
  if (!expectedState || !state || state !== expectedState || !codeVerifier) {
    return { ok: false, error: "Sign-in request expired or was tampered with. Please try again." };
  }
  const code = params.get("code");
  if (!code) {
    return { ok: false, error: "Google did not return an authorization code." };
  }
  return { ok: true, value: { code, codeVerifier, redirectUri: callbackUrl("google") } };
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
