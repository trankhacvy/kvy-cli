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
 * Mirrors the server's `FALCON_DEV_AUTH` flag (packages/server/src/config.ts) — purely
 * cosmetic here (it only toggles whether the sign-in page renders the dev-bypass
 * button), since the server independently fails closed if this is on but the server
 * itself doesn't have `FALCON_DEV_AUTH=1` set. Set `NEXT_PUBLIC_FALCON_DEV_AUTH=1`
 * for local testing against a server that also has dev auth enabled.
 */
export const DEV_AUTH_ENABLED: boolean = process.env.NEXT_PUBLIC_FALCON_DEV_AUTH === "1";

/**
 * Web Push VAPID public key (design §3/§6.4), base64url-encoded — the
 * `applicationServerKey` `PushManager.subscribe` needs. Safe to ship in a
 * public bundle (it's the *public* half of the server's VAPID key pair);
 * unset disables the notifications settings page's subscribe button.
 */
export const VAPID_PUBLIC_KEY: string | undefined =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || undefined;

/**
 * Settings → Support (docs/competitive-notes-omnara.md #23): an invite link to Falcon's
 * Discord community. Not a secret — safe to ship in a public bundle like the OAuth client
 * ids above. Self-hosters running their own community server override it via
 * `NEXT_PUBLIC_DISCORD_INVITE_URL`; the default points at Falcon's own.
 */
export const DISCORD_INVITE_URL: string =
  process.env.NEXT_PUBLIC_DISCORD_INVITE_URL || "https://discord.gg/falcon";

/**
 * Settings → Support (docs/competitive-notes-omnara.md #23): the direct support email
 * address, rendered as a `mailto:` link. Mirrors the server's own `VAPID_SUBJECT` default
 * (`packages/server/src/config.ts`) so the two stay the same address unless a self-hoster
 * overrides both.
 */
export const SUPPORT_EMAIL: string = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@falcon.dev";

/**
 * Mirrors the CLI's own `FALCON_PTY_SETMODE` flag (`commands/start.ts`'s
 * `PTY_SET_MODE_ENV_VAR`) — the PTY path's real `setMode` (a version-coupled
 * Shift+Tab keystroke cycle, plan-v2.md W4.3) stays behind a flag on both
 * sides until it's been live-soaked. This is purely cosmetic here (it only
 * un-hides the composer footer's mode-selector mutating affordance for a
 * `controlMode === "local"` session — `ComposerControls`' `canMutateMode`); the CLI
 * independently fails safe (`{ok: false}`) if this is on but the session's
 * own process doesn't also have `FALCON_PTY_SETMODE=1` set. Set
 * `NEXT_PUBLIC_FALCON_PTY_SETMODE=1` only against a stack you know has the
 * matching CLI flag on too.
 */
export const PTY_SET_MODE_ENABLED: boolean = process.env.NEXT_PUBLIC_FALCON_PTY_SETMODE === "1";
