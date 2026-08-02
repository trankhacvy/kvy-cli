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

/** Web Push VAPID public key, base64url-encoded. Unset disables the push subscribe button. */
export const VAPID_PUBLIC_KEY: string | undefined =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || undefined;

/** Settings → Support: invite link to Kvy's Discord community. Override via `NEXT_PUBLIC_DISCORD_INVITE_URL`. */
export const DISCORD_INVITE_URL: string =
  process.env.NEXT_PUBLIC_DISCORD_INVITE_URL || "https://discord.gg/kvy";

/** Settings → Support: direct support email rendered as a `mailto:` link. */
export const SUPPORT_EMAIL: string = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@kvy.dev";

/**
 * Mirrors the CLI's `KVY_PTY_SETMODE` flag. Un-hides the mode-selector affordance
 * in the composer footer. The CLI fails safe (`{ok: false}`) if this is on but
 * the session's process doesn't also have `KVY_PTY_SETMODE=1` set.
 */
export const PTY_SET_MODE_ENABLED: boolean = process.env.NEXT_PUBLIC_KVY_PTY_SETMODE === "1";

/**
 * Mirrors the CLI's `KVY_PTY_SETMODEL` flag. Un-hides the model-selector affordance
 * in the composer footer. The CLI fails safe (`{ok: false}`) if this is on but
 * the session's process doesn't also have `KVY_PTY_SETMODEL=1` set.
 */
export const PTY_SET_MODEL_ENABLED: boolean = process.env.NEXT_PUBLIC_KVY_PTY_SETMODEL === "1";
