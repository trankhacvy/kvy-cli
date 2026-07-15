import { z } from "zod";

// The default is only safe for local dev/test; every real deployment MUST override it,
// since anyone holding this value can mint tokens for any account.
const DEV_ONLY_MASTER_SECRET = "dev-only-insecure-master-secret-change-me!!";

// All server configuration comes from the environment (design §6.5: "config
// via env only" — required for the docker-compose self-host shape). Parsed
// and validated once at process start so a bad env fails fast, not mid-request.
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3005),
    HOST: z.string().min(1).default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    DATABASE_URL: z
      .string()
      .min(1)
      .default("postgres://falcon:falcon@localhost:5432/falcon"),
    // HMAC signing key for auth JWTs (design §5.2: HS256 at MVP — see src/auth/tokens.ts).
    FALCON_MASTER_SECRET: z
      .string()
      .min(32, "FALCON_MASTER_SECRET must be at least 32 characters")
      .default(DEV_ONLY_MASTER_SECRET),
    // OAuth client ids for `POST /v1/auth/register` (design §5.2, falcon-plan.md §1.2:
    // "OAuth binding … stored on account for recovery only"). Optional — Google/GitHub
    // sign-in simply refuses proofs (401, fail closed) until configured; see
    // src/auth/oauth.ts for why an unset client id must never be treated as "skip the
    // audience check" rather than "reject everything".
    GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  })
  // Belt-and-suspenders against shipping the dev-only secret to production: a silent
  // fallback there would let anyone who has read this source mint tokens for any
  // account, so refuse to boot instead (fail fast, per the comment above).
  .refine((parsed) => !(parsed.NODE_ENV === "production" && parsed.FALCON_MASTER_SECRET === DEV_ONLY_MASTER_SECRET), {
    message: "FALCON_MASTER_SECRET must be set to a real secret when NODE_ENV=production",
    path: ["FALCON_MASTER_SECRET"],
  });

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
