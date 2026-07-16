/**
 * Build-time configuration. `@falcon/web` is a static export (next.config.ts:
 * `output: "export"`) served from an origin separate from the API (design
 * §5.3/§9) — every value here is a `NEXT_PUBLIC_*` env var so Next inlines it
 * into the static bundle at build time; there is no server to read env at
 * request time.
 *
 * OAuth client ids are safe to ship in a public bundle (that's what "client
 * id" means, as opposed to "client secret" — see falcon-system-design.md §5.2
 * and packages/server/src/auth/oauth.ts). An unset provider id simply hides
 * that provider's sign-in button rather than rendering a broken one.
 */

/** Base URL of the Falcon API server (Fastify), e.g. "https://api.falcon.dev". */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3005").replace(
  /\/+$/,
  "",
);

/** Google OAuth client id (OIDC implicit flow) — unset disables the Google button. */
export const GOOGLE_OAUTH_CLIENT_ID: string | undefined =
  process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID || undefined;

/** GitHub OAuth app client id (authorization-code flow) — unset disables the GitHub button. */
export const GITHUB_OAUTH_CLIENT_ID: string | undefined =
  process.env.NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID || undefined;

/**
 * Web Push VAPID public key (design §3/§6.4), base64url-encoded — the
 * `applicationServerKey` `PushManager.subscribe` needs. Safe to ship in a
 * public bundle (it's the *public* half of the server's VAPID key pair);
 * unset disables the notifications settings page's subscribe button.
 */
export const VAPID_PUBLIC_KEY: string | undefined =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || undefined;
