import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Kept in its own file (rather than a second `describe` in telegramLink.test.ts)
// so it gets its own vitest module registry: `../server.js` transitively
// imports `app/socket/rpcHandler.ts`, which registers a prom-client `Counter`
// at module-eval time — a second `vi.resetModules()` + re-import within the
// same file re-runs that top-level registration and throws ("a metric with
// this name has already been registered"). One `vi.resetModules()` per file
// (matching `config.test.ts`'s own pattern) sidesteps that entirely.
describe("POST /v1/push/telegram/link (Telegram not configured)", () => {
  const originalEnv = { ...process.env };
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof import("./testHelpers.js").createTestDb>>["db"];
  let app: FastifyInstance;
  let authHeader: string;

  beforeAll(async () => {
    process.env = { ...originalEnv };
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_USERNAME;

    const testHelpers = await import("./testHelpers.js");
    const created = await testHelpers.createTestDb();
    db = created.db;
    pglite = created.pglite;

    const { buildServer } = await import("../server.js");
    app = await buildServer({ logger: false }, { db });

    const account = await testHelpers.createTestAccount(db);
    authHeader = account.authHeader;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
    process.env = originalEnv;
  });

  it("400s with a clear error instead of minting an unusable code", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/push/telegram/link",
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: expect.any(String) });
  });
});
