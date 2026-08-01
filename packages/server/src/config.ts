import { homedir } from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

// Load exactly once per process, not once per import: tests re-import this module many
// times via `vi.resetModules()` (each one deliberately `delete`ing a specific env var
// first, to exercise the "unset in production" path) — without this guard, dotenv would
// re-read the real root `.env.local` on every one of those re-imports and silently
// resurrect the var the test just deleted, since dotenv only skips keys already present
// in `process.env`, not keys that were removed after an earlier load.
if (!process.env.KVY_DOTENV_LOADED) {
  loadEnv({ path: path.join(import.meta.dirname, "../../../.env.local") });
  process.env.KVY_DOTENV_LOADED = "1";
}

// The default is only safe for local dev/test; every real deployment MUST override it,
// since anyone holding this value can mint tokens for any account.
const DEV_ONLY_MASTER_SECRET = "dev-only-insecure-master-secret-change-me!!";

const DEFAULT_BLOB_LOCAL_DIR = path.join(homedir(), ".kvy", "server", "blobs");

// All server configuration comes from the environment (design §6.5: "config
// via env only" — required for the docker-compose self-host shape). Parsed
// and validated once at process start so a bad env fails fast, not mid-request.
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3005),
    HOST: z.string().min(1).default("0.0.0.0"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z.string().min(1).default("postgres://kvy:kvy@localhost:5432/kvy"),
    // Direct (non-pooled) connection used ONLY by the boot-time migration runner — see
    // db/migrate.ts. A transaction pooler (Neon's `-pooler` host, PgBouncer, Vercel's pooled
    // URL) is the wrong transport for the session-scoped advisory lock and long DDL
    // transaction `runMigrations()` needs. Unset is fine when DATABASE_URL already points at
    // a direct endpoint (local Postgres, self-host docker-compose).
    DATABASE_URL_UNPOOLED: z.string().min(1).optional(),
    // HMAC signing key for auth JWTs (design §5.2: HS256 at MVP — see src/auth/tokens.ts).
    KVY_MASTER_SECRET: z
      .string()
      .min(32, "KVY_MASTER_SECRET must be at least 32 characters")
      .default(DEV_ONLY_MASTER_SECRET),
    // OAuth client ids for `POST /v1/auth/register` (design §5.2, kvy-plan.md §1.2:
    // "OAuth binding … stored on account for recovery only"). Optional — Google/GitHub
    // sign-in simply refuses proofs (401, fail closed) until configured; see
    // src/auth/oauth.ts for why an unset client id must never be treated as "skip the
    // audience check" rather than "reject everything".
    GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    // GitHub OAuth app credentials for `POST /v1/auth/oauth/github/exchange` — the web
    // app (a static export, no server-held secret of its own) redirects the browser
    // through GitHub's authorization-code flow and hands the resulting `code` to this
    // server to exchange for an access token, since GitHub's token endpoint requires
    // the app's client secret and has no browser-CORS path (src/auth/oauth.ts). Optional
    // — GitHub sign-in simply refuses exchanges (401) until both are configured.
    GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
    // Web Push (VAPID) — kvy-system-design.md §6.4/§3 "Push | Web Push (VAPID)
    // via `web-push`". Optional: unset simply means the `webpush` channel logs and
    // skips sending (src/app/push/channels/webpush.ts) rather than failing closed —
    // there's no security boundary to protect here, just a missing capability, and a
    // dev/self-host box may not have keys generated yet. Generate a pair with
    // `pnpm --filter @kvy/server exec web-push generate-vapid-keys`.
    VAPID_PUBLIC_KEY: z.string().min(1).optional(),
    VAPID_PRIVATE_KEY: z.string().min(1).optional(),
    // The `mailto:`/`https:` contact URL Web Push's VAPID spec requires push
    // services be able to reach if they need to reach the sender.
    VAPID_SUBJECT: z.string().min(1).default("mailto:support@kvy.dev"),
    // Fallback notification channels (kvy-system-design.md §6.4, plan.md §10
    // "Kvy add — fallback channels"). All optional: same "missing config =
    // skipped capability" stance as VAPID above — a self-host box that hasn't
    // set up a Telegram bot yet just gets a documented no-op, not a crash.
    // Bot token for the Telegram Bot API (`sendMessage`, and the webhook this
    // server registers to receive `/start` pairing messages).
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    // The bot's public @username (no `@`), used to build the `/start`
    // deep-link (`https://t.me/<username>?start=<code>`) `POST
    // /v1/push/telegram/link` returns.
    TELEGRAM_BOT_USERNAME: z.string().min(1).optional(),
    // Matched against Telegram's `X-Telegram-Bot-Api-Secret-Token` header on
    // `POST /v1/push/telegram/webhook` (set via `setWebhook`'s `secret_token`
    // param). Unset simply skips the check — there's no content to protect on
    // that route beyond the pairing codes themselves, which are already
    // short-lived, single-use, and unguessable.
    TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
    // ntfy (ntfy.sh or a self-hosted instance) publish endpoint. Always has a
    // default — unlike Telegram, ntfy needs no bot registration, just a topic
    // name the user picks in Settings.
    NTFY_BASE_URL: z.string().url().default("https://ntfy.sh"),
    // Public origin the web app is served from, e.g. `https://app.kvy.dev`.
    // Used only to build a deep link inside the Telegram/ntfy message text —
    // webpush doesn't need this because its payload is decoded and rendered
    // client-side (`public/sw.js`) already knows its own origin. Optional:
    // unset just omits the link, matching this file's "missing config, not a
    // crash" stance throughout.
    PUBLIC_WEB_ORIGIN: z.string().url().optional(),
    // Public origin THIS server (the API, not the web app) is reachable at —
    // only needed by the local-disk blob driver to build absolute upload/
    // download URLs pointing back at its own `/v1/blobs/local/:id` sink
    // (design §6.5 "self-host … blobs fall back to local disk when
    // unset"). Optional: unset falls back to reflecting the incoming
    // request's own protocol/host (fine for a direct connection or a
    // transparent reverse proxy); set this explicitly when a proxy rewrites
    // the host header in a way that would produce a wrong origin otherwise.
    PUBLIC_API_ORIGIN: z.string().url().optional(),
    // S3-compatible blob storage (kvy-system-design.md §3 "Blobs |
    // S3-compatible (MinIO in dev/self-host, R2/S3 in prod)", §6.5). Presence
    // of `S3_BUCKET` selects the S3 driver; its absence selects the
    // local-disk driver — "blobs fall back to local disk when unset" is a
    // capability tier, not an error state, same stance as VAPID/Telegram
    // above. `S3_ENDPOINT`/`S3_FORCE_PATH_STYLE` only matter for
    // MinIO/R2-style S3-compatible endpoints; unset on real AWS S3.
    S3_BUCKET: z.string().min(1).optional(),
    S3_REGION: z.string().min(1).default("auto"),
    S3_ENDPOINT: z.string().url().optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
    // Where the local-disk driver writes encrypted blob bytes when no S3
    // bucket is configured. Defaults under `~/.kvy/`, matching every
    // other Kvy-owned local-state path (CLI's `~/.kvy/settings.json`
    // etc.) — self-host docker-compose overrides this to a mounted volume
    // (e.g. `/data/blobs`).
    BLOB_LOCAL_DIR: z.string().min(1).default(DEFAULT_BLOB_LOCAL_DIR),
    // HMAC key signing the local driver's short-lived upload/download URL
    // tokens (`blobStorage/localToken.ts`) — the local-disk equivalent of an
    // S3 presigned URL's SigV4 signature. Falls back to
    // `KVY_MASTER_SECRET` (already required, already secret) rather than
    // demanding yet another env var for the common case; set this
    // separately only if you want blob-URL forgery and auth-token forgery
    // to require compromising two different secrets instead of one.
    BLOB_LOCAL_TOKEN_SECRET: z.string().min(1).optional(),
    // docs/auth-ux-overhaul-plan.md AX-7.1: max concurrent (non-archived) sessions per
    // account. 0 disables the check entirely, which is the default — a self-host has no
    // reason to cap itself, and a hosted deployment sets this explicitly.
    MAX_ACTIVE_SESSIONS_PER_ACCOUNT: z.coerce.number().int().min(0).default(0),
    // How long a presigned/local blob upload or download URL stays valid.
    BLOB_URL_EXPIRY_SECONDS: z.coerce.number().int().positive().default(300),
    // Hard cap on a single blob's encrypted byte size, enforced by
    // `POST /v1/blobs/request-upload` before any storage driver is even
    // asked for a target — refuses oversized requests up front rather than
    // discovering the problem mid-upload. 64 MiB comfortably covers large
    // diffs/transcripts/attachments (design §4.4's 64KB figure is the RPC
    // *control-plane* cap this subsystem exists to route around, not a
    // blob-size cap).
    BLOB_MAX_SIZE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(64 * 1024 * 1024),
    // Explicit CORS allowlist (kvy-system-design.md §12, plan.md §16 "4.4
    // Hardening": "wildcard-CORS removal" — one of the reported Happy vuln
    // classes). Comma-separated list of exact browser origins (scheme +
    // host + port, no path) allowed to open the `/v1/stream` WebSocket —
    // e.g. `https://app.kvy.dev,https://staging.kvy.dev`. Defaults to
    // the Next.js dev server's own origin so local dev keeps working
    // out of the box; every real deployment should set this explicitly to
    // its actual web origin(s), same "safe default, must-override in prod"
    // stance as `KVY_MASTER_SECRET` above (see `app/security/cors.ts`).
    CORS_ALLOWED_ORIGINS: z
      .string()
      .min(1)
      .default("http://localhost:3000")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      ),
  })
  // Belt-and-suspenders against shipping the dev-only secret to production: a silent
  // fallback there would let anyone who has read this source mint tokens for any
  // account, so refuse to boot instead (fail fast, per the comment above).
  .refine(
    (parsed) =>
      !(parsed.NODE_ENV === "production" && parsed.KVY_MASTER_SECRET === DEV_ONLY_MASTER_SECRET),
    {
      message: "KVY_MASTER_SECRET must be set to a real secret when NODE_ENV=production",
      path: ["KVY_MASTER_SECRET"],
    },
  )
  // A bucket name with no credentials is a half-configured S3 driver, not a
  // "fall back to local disk" signal — that fallback is only for the fully
  // unset case (see `S3_BUCKET`'s own comment). Failing fast here beats
  // booting into a driver that will 500 on the first real upload.
  .refine(
    (parsed) => !parsed.S3_BUCKET || (parsed.S3_ACCESS_KEY_ID && parsed.S3_SECRET_ACCESS_KEY),
    {
      message: "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when S3_BUCKET is set",
      path: ["S3_BUCKET"],
    },
  );

export type Env = z.infer<typeof EnvSchema>;

// Docker Compose's `${VAR}` interpolation sets an env var to an empty string rather than
// omitting it when the underlying value is unset (self-host `.env`, Coolify, etc.). For the
// optional, "missing config = skipped capability" fields documented above, treat that the
// same as "not provided" so they fall back to their default/undefined instead of failing
// min-length/url validation on an empty string. Core infra fields (HOST, DATABASE_URL, secrets,
// ...) deliberately keep hard-failing on an explicit empty string — see config.test.ts.
const OPTIONAL_ENV_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_USERNAME",
  "TELEGRAM_WEBHOOK_SECRET",
  "NTFY_BASE_URL",
  "PUBLIC_WEB_ORIGIN",
  "PUBLIC_API_ORIGIN",
  "S3_BUCKET",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "BLOB_LOCAL_TOKEN_SECRET",
  "DATABASE_URL_UNPOOLED",
] as const;

const rawEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => !(value === "" && (OPTIONAL_ENV_KEYS as readonly string[]).includes(key)),
  ),
);

export const env: Env = EnvSchema.parse(rawEnv);
