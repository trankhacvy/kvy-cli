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
      paths: ["req.headers.authorization", "req.headers.cookie"],
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
