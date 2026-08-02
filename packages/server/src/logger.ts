import type { LoggerOptions } from "pino";
import { env } from "./config.js";

// Pretty-printed outside production; prod emits structured JSON for log aggregators.
export function buildLoggerOptions(): LoggerOptions {
  const isProduction = env.NODE_ENV === "production";

  return {
    level: env.LOG_LEVEL,
    redact: {
      // `*.token`/`*.accessToken` are redacted at any nesting depth so a future log
      // call site doesn't need to know this list to avoid leaking credentials.
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
