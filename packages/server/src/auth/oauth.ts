import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { env } from "../config.js";

/**
 * OAuth binding for account recovery/contact (design §5.2, falcon-plan.md §1.2:
 * "OAuth binding … stored on account for recovery only. Defer email+password.") —
 * this is `accounts.oauthProvider`'s value space; the schema column itself has no
 * enum constraint, but every writer (only `buildRegisterRoute`, see routes/oauth.ts)
 * goes through this module, so this union is the effective source of truth.
 *
 * "dev" is not a real provider — it's the `FALCON_DEV_AUTH` local-testing bypass
 * (see `verifyDevProof` below), included in this union so it flows through the
 * same register route / account row shape as a real provider rather than needing
 * a parallel code path.
 */
export type OAuthProvider = "google" | "github" | "dev";

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
 * Exchanges a GitHub OAuth authorization `code` for an access token — the piece of
 * GitHub's flow that requires the app's client secret and therefore can't happen in
 * the (statically exported, secret-less) web app. Returns `null` on any failure:
 * unconfigured credentials (fail closed, same rationale as the Google audience check
 * above), a rejected code, or a malformed response — never throws.
 *
 * `fetchToken` is injectable so tests can stub the HTTP call instead of hitting
 * GitHub's live token endpoint (see oauth.test.ts), mirroring `verifyGithubAccessToken`.
 */
export async function exchangeGithubCode(
  code: string,
  redirectUri: string,
  fetchToken: (body: Record<string, string>) => Promise<Response> = (body) =>
    fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }),
): Promise<string | null> {
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) return null;

  try {
    const response = await fetchToken({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { access_token?: string };
    return typeof body.access_token === "string" && body.access_token.length > 0
      ? body.access_token
      : null;
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

/**
 * The `FALCON_DEV_AUTH` local-testing bypass: always succeeds, binding whatever
 * `proof` string the caller sent as the subject (the web app sends a fixed literal —
 * see `signin/page.tsx` — there being nothing real to prove). Fail-closed when the
 * flag is off: returns `null`, exactly like an unconfigured Google/GitHub provider
 * above, so a server that never opted in rejects every "dev" proof rather than
 * silently ignoring the provider name. `config.ts`'s `.refine()` additionally makes
 * enabling this in `NODE_ENV=production` a boot-time error, not just a runtime no-op.
 */
function verifyDevProof(proof: string): OAuthIdentity | null {
  if (!env.FALCON_DEV_AUTH) return null;
  return { provider: "dev", subject: proof || "dev" };
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
    if (provider === "github") return verifyGithubAccessToken(proof);
    return Promise.resolve(verifyDevProof(proof));
  },
};
