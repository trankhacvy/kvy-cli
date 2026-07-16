import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// This file mutates process.env before importing anything that transitively
// reads `config.ts` (server.ts, testHelpers.ts) — config.ts parses
// `process.env` once at module-eval time, so every such import below is
// dynamic (`await import(...)`), performed only after `vi.resetModules()` +
// the env mutation, exactly like `config.test.ts`'s own `importFreshConfig`
// helper. A static top-level import here would run before this file's own
// top-level code and pick up whatever `process.env` already was.
describe("Telegram bot /start pairing (Telegram configured)", () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.fn();

  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof import("./testHelpers.js").createTestDb>>["db"];
  let app: FastifyInstance;
  let authHeader: string;

  beforeAll(async () => {
    process.env = {
      ...originalEnv,
      TELEGRAM_BOT_TOKEN: "test-bot-token",
      TELEGRAM_BOT_USERNAME: "FalconNotifyBot",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    };
    vi.resetModules();
    vi.stubGlobal("fetch", fetchMock);

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
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
  });

  it("creates a pairing code and a matching t.me deep link", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/push/telegram/link",
      headers: { authorization: authHeader },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.code).toEqual(expect.any(String));
    expect(body.deepLink).toBe(`https://t.me/FalconNotifyBot?start=${body.code}`);
  });

  it("401s without a bearer token", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/push/telegram/link" });
    expect(response.statusCode).toBe(401);
  });

  it("webhook rejects a request bearing the wrong secret token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/push/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
      payload: { message: { text: "/start abc", chat: { id: 555 } } },
    });
    expect(response.statusCode).toBe(401);
  });

  it("completes pairing on /start <code>: registers a telegram subscription and consumes the code", async () => {
    const link = await app.inject({
      method: "POST",
      url: "/v1/push/telegram/link",
      headers: { authorization: authHeader },
    });
    const { code } = link.json();

    const webhook = await app.inject({
      method: "POST",
      url: "/v1/push/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      payload: { message: { text: `/start ${code}`, chat: { id: 987654 } } },
    });
    expect(webhook.statusCode).toBe(200);

    const sub = await db.query.pushSubscriptions.findFirst({
      where: (row, { eq }) => eq(row.endpoint, "987654"),
    });
    expect(sub?.channel).toBe("telegram");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-bot-token/sendMessage",
      expect.objectContaining({ method: "POST" }),
    );

    const linkRequest = await db.query.telegramLinkRequests.findFirst({
      where: (row, { eq }) => eq(row.code, code),
    });
    expect(linkRequest).toBeUndefined(); // single-use
  });

  it("200s and ignores an unknown/already-used code", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/push/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      payload: { message: { text: "/start not-a-real-code", chat: { id: 111 } } },
    });
    expect(response.statusCode).toBe(200);
  });

  it("200s and does nothing for updates that aren't /start messages", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/push/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      payload: { message: { text: "hello there", chat: { id: 111 } } },
    });
    expect(response.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
