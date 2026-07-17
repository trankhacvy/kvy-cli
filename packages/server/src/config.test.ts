import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// config.ts parses process.env once at import time, so each test that needs
// a different env combination must mutate process.env *before* a fresh
// dynamic import. vi.resetModules() clears vitest's module registry so the
// next import re-runs the top-level `EnvSchema.parse(process.env)` instead
// of returning the cached module from a previous test.
const ORIGINAL_ENV = { ...process.env };

async function importFreshConfig() {
  vi.resetModules();
  const mod = await import("./config.js");
  return mod;
}

describe("config env parsing", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("applies defaults when no env vars are set", async () => {
    delete process.env.NODE_ENV;
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.LOG_LEVEL;
    delete process.env.DATABASE_URL;
    delete process.env.FALCON_MASTER_SECRET;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_USERNAME;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.NTFY_BASE_URL;
    delete process.env.PUBLIC_WEB_ORIGIN;
    delete process.env.CORS_ALLOWED_ORIGINS;

    const { env } = await importFreshConfig();

    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3005);
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DATABASE_URL).toBe("postgres://falcon:falcon@localhost:5432/falcon");
    expect(env.FALCON_MASTER_SECRET).toBe("dev-only-insecure-master-secret-change-me!!");
    expect(env.VAPID_PUBLIC_KEY).toBeUndefined();
    expect(env.VAPID_PRIVATE_KEY).toBeUndefined();
    expect(env.VAPID_SUBJECT).toBe("mailto:support@falcon.dev");
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_BOT_USERNAME).toBeUndefined();
    expect(env.TELEGRAM_WEBHOOK_SECRET).toBeUndefined();
    expect(env.NTFY_BASE_URL).toBe("https://ntfy.sh");
    expect(env.PUBLIC_WEB_ORIGIN).toBeUndefined();
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["http://localhost:3000"]);
  });

  it("coerces PORT from a numeric string", async () => {
    process.env.PORT = "8080";

    const { env } = await importFreshConfig();

    expect(env.PORT).toBe(8080);
    expect(typeof env.PORT).toBe("number");
  });

  it("accepts a fully-specified valid env", async () => {
    process.env.NODE_ENV = "production";
    process.env.PORT = "4321";
    process.env.HOST = "127.0.0.1";
    process.env.LOG_LEVEL = "warn";
    process.env.DATABASE_URL = "postgres://user:pass@db.internal:5432/falcon_prod";
    process.env.FALCON_MASTER_SECRET = "a".repeat(32);
    process.env.VAPID_PUBLIC_KEY = "test-vapid-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-vapid-private-key";
    process.env.VAPID_SUBJECT = "mailto:ops@falcon.dev";
    process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
    process.env.TELEGRAM_BOT_USERNAME = "FalconNotifyBot";
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    process.env.NTFY_BASE_URL = "https://ntfy.internal";
    process.env.PUBLIC_WEB_ORIGIN = "https://app.falcon.dev";
    process.env.CORS_ALLOWED_ORIGINS = "https://app.falcon.dev, https://staging.falcon.dev";

    const { env } = await importFreshConfig();

    expect(env).toEqual({
      NODE_ENV: "production",
      PORT: 4321,
      HOST: "127.0.0.1",
      LOG_LEVEL: "warn",
      DATABASE_URL: "postgres://user:pass@db.internal:5432/falcon_prod",
      FALCON_MASTER_SECRET: "a".repeat(32),
      VAPID_PUBLIC_KEY: "test-vapid-public-key",
      VAPID_PRIVATE_KEY: "test-vapid-private-key",
      VAPID_SUBJECT: "mailto:ops@falcon.dev",
      TELEGRAM_BOT_TOKEN: "test-bot-token",
      TELEGRAM_BOT_USERNAME: "FalconNotifyBot",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
      NTFY_BASE_URL: "https://ntfy.internal",
      PUBLIC_WEB_ORIGIN: "https://app.falcon.dev",
      CORS_ALLOWED_ORIGINS: ["https://app.falcon.dev", "https://staging.falcon.dev"],
    });
  });

  it("trims whitespace and drops empty entries from CORS_ALLOWED_ORIGINS", async () => {
    process.env.CORS_ALLOWED_ORIGINS = " https://a.falcon.dev ,, https://b.falcon.dev ";

    const { env } = await importFreshConfig();

    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["https://a.falcon.dev", "https://b.falcon.dev"]);
  });

  it("throws when DATABASE_URL is an empty string", async () => {
    process.env.DATABASE_URL = "";

    await expect(importFreshConfig()).rejects.toThrow();
  });

  it("throws when FALCON_MASTER_SECRET is shorter than 32 characters", async () => {
    process.env.FALCON_MASTER_SECRET = "too-short";

    await expect(importFreshConfig()).rejects.toThrow();
  });

  it("throws when NODE_ENV is an invalid enum value", async () => {
    process.env.NODE_ENV = "staging";

    await expect(importFreshConfig()).rejects.toThrow();
  });

  it("throws when PORT is not a positive integer", async () => {
    process.env.PORT = "-1";

    await expect(importFreshConfig()).rejects.toThrow();
  });

  it("throws when PORT is not numeric at all", async () => {
    process.env.PORT = "not-a-port";

    await expect(importFreshConfig()).rejects.toThrow();
  });

  it("throws when LOG_LEVEL is not one of the allowed levels", async () => {
    process.env.LOG_LEVEL = "verbose";

    await expect(importFreshConfig()).rejects.toThrow();
  });

  it("throws when HOST is an empty string", async () => {
    process.env.HOST = "";

    await expect(importFreshConfig()).rejects.toThrow();
  });

  it("throws when NODE_ENV=production and FALCON_MASTER_SECRET is left at its dev-only default", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.FALCON_MASTER_SECRET;

    await expect(importFreshConfig()).rejects.toThrow(/FALCON_MASTER_SECRET/);
  });

  it("allows NODE_ENV=production when FALCON_MASTER_SECRET is overridden", async () => {
    process.env.NODE_ENV = "production";
    process.env.FALCON_MASTER_SECRET = "a".repeat(32);

    const { env } = await importFreshConfig();

    expect(env.NODE_ENV).toBe("production");
  });
});
