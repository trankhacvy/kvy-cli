import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function importFreshLogger() {
  vi.resetModules();
  const mod = await import("./logger.js");
  return mod;
}

describe("buildLoggerOptions", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses the configured LOG_LEVEL", async () => {
    process.env.LOG_LEVEL = "debug";
    const { buildLoggerOptions } = await importFreshLogger();

    expect(buildLoggerOptions().level).toBe("debug");
  });

  it("redacts authorization and cookie headers", async () => {
    const { buildLoggerOptions } = await importFreshLogger();
    const options = buildLoggerOptions();

    expect(options.redact).toEqual({
      paths: ["req.headers.authorization", "req.headers.cookie"],
      censor: "[redacted]",
    });
  });

  it("omits the pino-pretty transport in production", async () => {
    process.env.NODE_ENV = "production";
    const { buildLoggerOptions } = await importFreshLogger();

    expect(buildLoggerOptions().transport).toBeUndefined();
  });

  it("enables the pino-pretty transport outside production", async () => {
    process.env.NODE_ENV = "development";
    const { buildLoggerOptions } = await importFreshLogger();
    const options = buildLoggerOptions();

    expect(options.transport).toMatchObject({
      target: "pino-pretty",
      options: { colorize: true },
    });
  });

  it("enables the pino-pretty transport in test env too", async () => {
    process.env.NODE_ENV = "test";
    const { buildLoggerOptions } = await importFreshLogger();

    expect(buildLoggerOptions().transport).toBeDefined();
  });
});
