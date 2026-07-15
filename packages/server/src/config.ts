import { z } from "zod";

// All server configuration comes from the environment (design §6.5: "config
// via env only" — required for the docker-compose self-host shape). Parsed
// and validated once at process start so a bad env fails fast, not mid-request.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3005),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // HMAC signing key for auth JWTs (design §5.2: HS256 at MVP — see src/auth/tokens.ts).
  // The default is only safe for local dev/test; every real deployment MUST override it,
  // since anyone holding this value can mint tokens for any account.
  FALCON_MASTER_SECRET: z
    .string()
    .min(32, "FALCON_MASTER_SECRET must be at least 32 characters")
    .default("dev-only-insecure-master-secret-change-me!!"),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
