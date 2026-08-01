/**
 * Build-time configuration. `@kvy/web` is a static export (next.config.ts:
 * `output: "export"`) served from an origin separate from the API (design
 * §5.3/§9) — every value here is a `NEXT_PUBLIC_*` env var so Next inlines it
 * into the static bundle at build time; there is no server to read env at
 * request time.
 *
 * OAuth client ids are safe to ship in a public bundle (that's what "client
 * id" means, as opposed to "client secret" — see kvy-system-design.md §5.2
 * and packages/server/src/auth/oauth.ts). An unset provider id simply hides
 * that provider's sign-in button rather than rendering a broken one.
 */

/** Base URL of the Kvy API server (Fastify), e.g. "https://api.kvy.dev". */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3005").replace(
  /\/+$/,
  "",
);

/** Public web origin for canonical URLs, Open Graph, and the sitemap. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://app.kvy.dev").replace(
  /\/+$/,
  "",
);

/** Brand chrome / splash color — keep in sync with `public/manifest.webmanifest`. */
export const THEME_COLOR = "#0b0f19";

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

/**
 * Settings → Support (docs/competitive-notes-omnara.md #23): an invite link to Kvy's
 * Discord community. Not a secret — safe to ship in a public bundle like the OAuth client
 * ids above. Self-hosters running their own community server override it via
 * `NEXT_PUBLIC_DISCORD_INVITE_URL`; the default points at Kvy's own.
 */
export const DISCORD_INVITE_URL: string =
  process.env.NEXT_PUBLIC_DISCORD_INVITE_URL || "https://discord.gg/kvy";

/**
 * Settings → Support (docs/competitive-notes-omnara.md #23): the direct support email
 * address, rendered as a `mailto:` link. Mirrors the server's own `VAPID_SUBJECT` default
 * (`packages/server/src/config.ts`) so the two stay the same address unless a self-hoster
 * overrides both.
 */
export const SUPPORT_EMAIL: string = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@kvy.dev";

/**
 * Mirrors the CLI's own `KVY_PTY_SETMODE` flag (`commands/start.ts`'s
 * `PTY_SET_MODE_ENV_VAR`) — the PTY path's real `setMode` (a version-coupled
 * Shift+Tab keystroke cycle, plan-v2.md W4.3) stays behind a flag on both
 * sides until it's been live-soaked. This is purely cosmetic here (it only
 * un-hides the composer footer's mode-selector mutating affordance for a
 * `controlMode === "local"` session — `ComposerControls`' `canMutateMode`); the CLI
 * independently fails safe (`{ok: false}`) if this is on but the session's
 * own process doesn't also have `KVY_PTY_SETMODE=1` set. Set
 * `NEXT_PUBLIC_KVY_PTY_SETMODE=1` only against a stack you know has the
 * matching CLI flag on too.
 */
export const PTY_SET_MODE_ENABLED: boolean = process.env.NEXT_PUBLIC_KVY_PTY_SETMODE === "1";

/**
 * Mirrors the CLI's own `KVY_PTY_SETMODEL` flag (`commands/start.ts`'s
 * `PTY_SET_MODEL_ENV_VAR`) — docs/known-issues.md issue #12's real web
 * model selector (a `/model <alias>` keystroke injection, version-coupled
 * TUI behavior like `setMode`) stays behind a flag on both sides until it's
 * been live-soaked. Purely cosmetic here (it only un-hides the composer
 * footer's model-selector mutating affordance for a `controlMode ===
 * "local"` session — `ComposerControls`' `canMutateModel`); the CLI
 * independently fails safe (`{ok: false}`) if this is on but the session's
 * own process doesn't also have `KVY_PTY_SETMODEL=1` set. Set
 * `NEXT_PUBLIC_KVY_PTY_SETMODEL=1` only against a stack you know has the
 * matching CLI flag on too.
 */
export const PTY_SET_MODEL_ENABLED: boolean = process.env.NEXT_PUBLIC_KVY_PTY_SETMODEL === "1";
