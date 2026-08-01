import type { LoggerOptions } from "pino";
import { env } from "./config.js";

// Fastify's built-in logger IS pino — passing options here (rather than
// hand-rolling a separate pino instance) is the whole "wiring": every
// request/response log line, and every app.log.* call, goes through this
// config. Pretty-printed only outside production; prod emits structured
// JSON lines for log aggregators. Never logs request/response bodies —
// user content is E2E-encrypted ciphertext to this server (design §1.2)
// and stays out of logs regardless.
export function buildLoggerOptions(): LoggerOptions {
  const isProduction = env.NODE_ENV === "production";

  return {
    level: env.LOG_LEVEL,
    redact: {
      // Every bearer/session credential this server ever sees on a request, scrubbed
      // before it can reach a log line (kvy-system-design.md §12: "logs scrub
      // tokens", plan.md §16 "4.4 Hardening": "token-scrubbing in logs" — one of the
      // reported Happy vuln classes). Covers both header-level credentials (the
      // `Authorization: Bearer <jwt>` every authenticated route reads, the session
      // cookie Fastify doesn't use today but might via a future plugin, and the
      // Telegram webhook's `X-Telegram-Bot-Api-Secret-Token` — see
      // `routes/telegramLink.ts`, matched against `env.TELEGRAM_WEBHOOK_SECRET`) and
      // any structured log call that happens to pass a `token`/`accessToken` field
      // (e.g. a future debug log around `mintToken`/`verifyToken` or the OAuth code
      // exchange) — those two keys are redacted at any nesting depth via the `*`
      // wildcard so a call site doesn't have to know this list to stay safe.
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-telegram-bot-api-secret-token"]',
        "token",
        "accessToken",
        "*.token",
        "*.accessToken",
      ],
      censor: "[redacted]",
    },
    ...(isProduction
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "HH:MM:ss.l",
              ignore: "pid,hostname",
            },
          },
        }),
  };
}
