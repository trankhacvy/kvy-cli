import {
  github,
  google,
  verifyGoogleIdToken as verifyGoogleIdTokenBetterAuth,
} from "better-auth/social-providers";
import { env } from "../config.js";

/**
 * `(kind, identifier)` in `auth_identities` — this is that `kind` column's value space.
 * The schema column itself has no enum constraint, but every writer (only
 * `buildOAuthRoutes`, see routes/oauth.ts) goes through this module, so this union is
 * the effective source of truth.
 */
export type OAuthProvider = "google" | "github";

export interface OAuthIdentity {
  provider: OAuthProvider;
  /** The provider's stable user id — becomes `auth_identities.identifier`. */
  subject: string;
  /**
   * Best-effort email captured from the provider — for display + analytics
   * (routes/oauth.ts persists it onto `auth_identities.email`/`emailVerified`),
   * never an auth gate: a login is authorized by `(kind, subject)` alone, and a
   * missing/unverified email never blocks or alters that. See the docblocks on
   * `verifyGoogleIdToken`/`verifyGithubAccessToken` for how each provider fills this.
   */
  email: string | null;
  emailVerified: boolean;
  /** Avatar URL — Google's `picture` claim or GitHub's `avatar_url`. Display only. */
  image: string | null;
}

/**
 * Verify a Google-issued OpenID Connect ID token — the `oauthProof` the browser
 * obtained from Google's sign-in flow — and return the identity to bind. Delegates
 * signature/issuer/expiry verification to Better Auth's own `verifyGoogleIdToken`
 * (`better-auth/social-providers`), same library used by `exchangeGoogleCode` below.
 *
 * Returns `null` on any failure: bad signature, wrong issuer, expired token, or a
 * server not configured with `GOOGLE_OAUTH_CLIENT_ID`. The unconfigured case is
 * deliberately fail-closed (reject every proof) rather than fail-open (verify
 * signature/issuer but skip the audience check) — skipping `audience` would accept
 * *any* Google-issued token, including one minted for an unrelated application,
 * as proof of this account's identity.
 *
 * `email`/`email_verified` are standard OIDC claims already present in this same
 * signed token — no extra network call needed to capture them.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<OAuthIdentity | null> {
  if (!env.GOOGLE_OAUTH_CLIENT_ID) return null;

  try {
    const payload = await verifyGoogleIdTokenBetterAuth({
      token: idToken,
      audience: env.GOOGLE_OAUTH_CLIENT_ID,
    });
    if (!payload || typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    const email = typeof payload.email === "string" ? payload.email : null;
    const emailVerified = payload.email_verified === true;
    const image = typeof payload.picture === "string" ? payload.picture : null;
    return { provider: "google", subject: payload.sub, email, emailVerified, image };
  } catch {
    // Collapses every failure mode (bad signature, expired, wrong issuer/audience,
    // malformed JWT) to null — mirrors tokens.ts's "unwrap never throws" rule.
    return null;
  }
}

/**
 * Exchanges a Google OAuth authorization-code + PKCE verifier for an ID token — the
 * piece of Google's flow that requires the app's client secret (Google's "Web
 * application" client type requires it regardless of PKCE) and therefore can't
 * happen in the (statically exported, secret-less) web app. Returns `null` on any
 * failure: unconfigured credentials (fail closed), a rejected code, or a response
 * with no `id_token` — never throws.
 */
export async function exchangeGoogleCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<string | null> {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) return null;

  try {
    const provider = google({
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    });
    const tokens = await provider.validateAuthorizationCode({
      code,
      codeVerifier,
      redirectURI: redirectUri,
    });
    return tokens.idToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify a GitHub OAuth access token — the `oauthProof` from GitHub's sign-in flow
 * — via Better Auth's `github` social-provider primitive (`better-auth/social-providers`),
 * which calls GitHub's `/user` endpoint and, when the user's email is private,
 * falls back to `/user/emails` for the primary verified address (needs the
 * `user:email` scope — see `beginGithubSignIn` in web/src/lib/oauth.ts). GitHub
 * access tokens are opaque (no local signature to check), so live confirmation via
 * the API *is* the proof: a forged or expired token gets a 401 straight from GitHub.
 */
export async function verifyGithubAccessToken(accessToken: string): Promise<OAuthIdentity | null> {
  try {
    const provider = github({ clientId: env.GITHUB_OAUTH_CLIENT_ID ?? "" });
    const result = await provider.getUserInfo({ accessToken });
    // Better Auth's own getUserInfo doesn't guard against a missing `id` in the
    // profile response (it trusts GitHub's API shape) — this codebase's contract is
    // that `subject` is never the literal string "undefined", so check explicitly.
    if (!result || result.user.id === undefined || result.user.id === null) return null;
    return {
      provider: "github",
      subject: String(result.user.id),
      email: result.user.email ?? null,
      emailVerified: result.user.emailVerified,
      image: result.user.image ?? null,
    };
  } catch {
    // Network failure or non-JSON body — same "expected, routine, collapse to null"
    // treatment as the Google path above.
    return null;
  }
}

/**
 * Exchanges a GitHub OAuth authorization `code` for an access token — the piece of
 * GitHub's flow that requires the app's client secret and therefore can't happen in
 * the (statically exported, secret-less) web app. Returns `null` on any failure:
 * unconfigured credentials (fail closed, same rationale as the Google audience check
 * above), a rejected code, or a malformed response — never throws.
 */
export async function exchangeGithubCode(
  code: string,
  redirectUri: string,
): Promise<string | null> {
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) return null;

  try {
    const provider = github({
      clientId: env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
    });
    const tokens = await provider.validateAuthorizationCode({ code, redirectURI: redirectUri });
    return tokens?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Interface (rather than calling `exchangeGithubCode` directly from the route) exists
 * so `buildOAuthRoutes` can be tested with a fake exchanger that never touches the
 * network, the same way it's tested with a fake `OAuthVerifier`.
 */
export interface GithubCodeExchanger {
  exchange(code: string, redirectUri: string): Promise<string | null>;
}

/** Production exchanger: real GitHub token-endpoint call. */
export const defaultGithubCodeExchanger: GithubCodeExchanger = {
  exchange: exchangeGithubCode,
};

/** Mirrors `GithubCodeExchanger` for Google's PKCE code exchange. */
export interface GoogleCodeExchanger {
  exchange(code: string, codeVerifier: string, redirectUri: string): Promise<string | null>;
}

/** Production exchanger: real Google token-endpoint call. */
export const defaultGoogleCodeExchanger: GoogleCodeExchanger = {
  exchange: exchangeGoogleCode,
};

/**
 * Verifies an `oauthProof` for a given provider. The interface (rather than calling
 * `verifyGoogleIdToken`/`verifyGithubAccessToken` directly from the route) exists so
 * `buildRegisterRoute` can be tested with a fake verifier that never touches the
 * network, the same way `buildAuthRoutes` takes an injected `db`.
 */
export interface OAuthVerifier {
  verify(provider: OAuthProvider, proof: string): Promise<OAuthIdentity | null>;
}

/** Production verifier: real Google JWKS verification + real GitHub API call. */
export const defaultOAuthVerifier: OAuthVerifier = {
  verify(provider, proof) {
    if (provider === "google") return verifyGoogleIdToken(proof);
    return verifyGithubAccessToken(proof);
  },
};
