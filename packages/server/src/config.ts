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

// Parsed and validated once at process start so a bad env fails fast, not mid-request.
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3005),
    HOST: z.string().min(1).default("0.0.0.0"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z.string().min(1).default("postgres://kvy:kvy@localhost:5432/kvy"),
    // Direct (non-pooled) connection used ONLY by the migration runner. A transaction
    // pooler (Neon's `-pooler` host, PgBouncer, Vercel's pooled URL) is the wrong
    // transport for the session-scoped advisory lock and long DDL transaction
    // `runMigrations()` needs. Unset is fine when DATABASE_URL already points at a
    // direct endpoint.
    DATABASE_URL_UNPOOLED: z.string().min(1).optional(),
    KVY_MASTER_SECRET: z
      .string()
      .min(32, "KVY_MASTER_SECRET must be at least 32 characters")
      .default(DEV_ONLY_MASTER_SECRET),
    // Optional — Google sign-in refuses proofs (401, fail closed) until configured.
    // An unset client id must never skip the audience check; it must reject everything.
    GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    // GitHub OAuth app credentials. The web app (a static export) hands GitHub's
    // authorization `code` to this server to exchange, since GitHub's token endpoint
    // requires the client secret and has no browser-CORS path. Optional — refuses
    // exchanges (401) until both are configured.
    GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
    // Optional — unset means the webpush channel skips sending rather than crashing.
    // Generate keys: `pnpm --filter @kvy/server exec web-push generate-vapid-keys`.
    VAPID_PUBLIC_KEY: z.string().min(1).optional(),
    VAPID_PRIVATE_KEY: z.string().min(1).optional(),
    // `mailto:` or `https:` contact URL required by the VAPID spec.
    VAPID_SUBJECT: z.string().min(1).default("mailto:support@kvy-cli.tkvy.dev"),
    // All optional — missing config means a skipped capability, not a crash.
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    // Bot @username (no `@`), used to build the `/start` deep-link URL.
    TELEGRAM_BOT_USERNAME: z.string().min(1).optional(),
    // Matched against `X-Telegram-Bot-Api-Secret-Token` on the webhook route.
    // Unset skips the check; the pairing codes themselves are short-lived and single-use.
    TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
    NTFY_BASE_URL: z.string().url().default("https://ntfy.sh"),
    // Used only to build a deep link in Telegram/ntfy message text.
    // Unset omits the link.
    PUBLIC_WEB_ORIGIN: z.string().url().optional(),
    // Public origin this API server is reachable at — needed by the local-disk blob
    // driver to build self-referential upload/download URLs. Unset reflects the
    // incoming request's own scheme/host; set this explicitly when a reverse proxy
    // rewrites the host header.
    PUBLIC_API_ORIGIN: z.string().url().optional(),
    // Presence of `S3_BUCKET` selects the S3 driver; absence selects local-disk.
    // `S3_ENDPOINT`/`S3_FORCE_PATH_STYLE` only matter for MinIO/R2-style endpoints.
    S3_BUCKET: z.string().min(1).optional(),
    S3_REGION: z.string().min(1).default("auto"),
    S3_ENDPOINT: z.string().url().optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
    BLOB_LOCAL_DIR: z.string().min(1).default(DEFAULT_BLOB_LOCAL_DIR),
    // Falls back to `KVY_MASTER_SECRET` so the common case needs no extra var. Set this
    // separately only to require independent compromise for blob-URL forgery vs auth-token
    // forgery.
    BLOB_LOCAL_TOKEN_SECRET: z.string().min(1).optional(),
    // 0 disables the concurrent-session quota entirely (the default for self-hosted).
    MAX_ACTIVE_SESSIONS_PER_ACCOUNT: z.coerce.number().int().min(0).default(0),
    BLOB_URL_EXPIRY_SECONDS: z.coerce.number().int().positive().default(300),
    BLOB_MAX_SIZE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(64 * 1024 * 1024),
    // Comma-separated exact browser origins allowed to open the `/v1/stream` WebSocket.
    // Defaults to the Next.js dev origin; every real deployment must set this explicitly.
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
  // Refuse to boot with the dev-only secret in production — anyone who has read
  // this source could mint tokens for any account if it shipped.
  .refine(
    (parsed) =>
      !(parsed.NODE_ENV === "production" && parsed.KVY_MASTER_SECRET === DEV_ONLY_MASTER_SECRET),
    {
      message: "KVY_MASTER_SECRET must be set to a real secret when NODE_ENV=production",
      path: ["KVY_MASTER_SECRET"],
    },
  )
  // A bucket name with no credentials is a misconfiguration, not a local-disk
  // fallback signal — fail fast rather than booting into a driver that will 500 on upload.
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
