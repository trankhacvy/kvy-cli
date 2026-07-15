import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { env } from "../config.js";

/**
 * OAuth binding for account recovery/contact (design §5.2, falcon-plan.md §1.2:
 * "OAuth binding … stored on account for recovery only. Defer email+password.") —
 * this is `accounts.oauthProvider`'s value space; the schema column itself has no
 * enum constraint, but every writer (only `buildRegisterRoute`, see routes/oauth.ts)
 * goes through this module, so this union is the effective source of truth.
 */
export type OAuthProvider = "google" | "github";

export interface OAuthIdentity {
  provider: OAuthProvider;
  /** The provider's stable user id — becomes `accounts.oauthSubject`. */
  subject: string;
}

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

let cachedGoogleJwks: JWTVerifyGetKey | undefined;

function remoteGoogleJwks(): JWTVerifyGetKey {
  // Lazily created (not at module load) so importing this file never makes a network
  // call, and cached across calls (`createRemoteJWKSet` keeps its own internal
  // key cache + rate limiting) rather than re-fetching Google's JWKS per request.
  cachedGoogleJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return cachedGoogleJwks;
}

/**
 * Verify a Google-issued OpenID Connect ID token — the `oauthProof` the browser
 * obtained from Google's sign-in flow — and return the identity to bind.
 *
 * Returns `null` on any failure: bad signature, wrong issuer, expired token, or a
 * server not configured with `GOOGLE_OAUTH_CLIENT_ID`. The unconfigured case is
 * deliberately fail-closed (reject every proof) rather than fail-open (verify
 * signature/issuer but skip the audience check) — skipping `audience` would accept
 * *any* Google-issued token, including one minted for an unrelated application,
 * as proof of this account's identity.
 *
 * `jwks` is injectable so tests can verify against a local test keypair instead of
 * Google's live JWKS endpoint (see oauth.test.ts).
 */
export async function verifyGoogleIdToken(
  idToken: string,
  jwks: JWTVerifyGetKey = remoteGoogleJwks(),
): Promise<OAuthIdentity | null> {
  if (!env.GOOGLE_OAUTH_CLIENT_ID) return null;

  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: GOOGLE_ISSUERS,
      audience: env.GOOGLE_OAUTH_CLIENT_ID,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    return { provider: "google", subject: payload.sub };
  } catch {
    // Collapses every failure mode (bad signature, expired, wrong issuer/audience,
    // malformed JWT) to null — mirrors tokens.ts's "unwrap never throws" rule.
    return null;
  }
}

/**
 * Verify a GitHub OAuth access token — the `oauthProof` from GitHub's sign-in flow
 * — by calling GitHub's `/user` endpoint. GitHub access tokens are opaque (no local
 * signature to check), so live confirmation via the API *is* the proof: a forged or
 * expired token gets a 401 straight from GitHub.
 *
 * `fetchUser` is injectable so tests can stub the HTTP call instead of hitting
 * GitHub's live API (see oauth.test.ts).
 */
export async function verifyGithubAccessToken(
  accessToken: string,
  fetchUser: (token: string) => Promise<Response> = (token) =>
    fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "falcon-server",
        Accept: "application/vnd.github+json",
      },
    }),
): Promise<OAuthIdentity | null> {
  try {
    const response = await fetchUser(accessToken);
    if (!response.ok) return null;

    const body = (await response.json()) as { id?: number | string };
    if (body.id === undefined || body.id === null) return null;
    return { provider: "github", subject: String(body.id) };
  } catch {
    // Network failure or non-JSON body — same "expected, routine, collapse to null"
    // treatment as the Google path above.
    return null;
  }
}

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
