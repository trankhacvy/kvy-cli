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

  it("200s, sends an expiry notice, and does not pair a code past its TTL", async () => {
    const { telegramLinkRequests } = await import("../../db/schema.js");
    const account = await (await import("./testHelpers.js")).createTestAccount(db);
    const [expired] = await db
      .insert(telegramLinkRequests)
      .values({
        code: "expired-code",
        accountId: account.account.id,
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning();
    expect(expired).toBeDefined();

    const response = await app.inject({
      method: "POST",
      url: "/v1/push/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      payload: { message: { text: "/start expired-code", chat: { id: 222 } } },
    });
    expect(response.statusCode).toBe(200);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-bot-token/sendMessage",
      expect.objectContaining({ method: "POST" }),
    );
    const [, options] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(options.body).text).toMatch(/expired/i);

    const sub = await db.query.pushSubscriptions.findFirst({
      where: (row, { eq }) => eq(row.endpoint, "222"),
    });
    expect(sub).toBeUndefined();

    // The expired row is left untouched (not deleted) by this codepath —
    // only a successful pairing consumes the code.
    const stillThere = await db.query.telegramLinkRequests.findFirst({
      where: (row, { eq }) => eq(row.code, "expired-code"),
    });
    expect(stillThere).toBeDefined();
  });

  it("re-pairing the same Telegram chat id reassigns ownership: last /start wins", async () => {
    const testHelpers = await import("./testHelpers.js");
    const firstAccount = await testHelpers.createTestAccount(db);
    const secondAccount = await testHelpers.createTestAccount(db);

    const firstLink = await app.inject({
      method: "POST",
      url: "/v1/push/telegram/link",
      headers: { authorization: firstAccount.authHeader },
    });
    const { code: firstCode } = firstLink.json();

    const firstWebhook = await app.inject({
      method: "POST",
      url: "/v1/push/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      payload: { message: { text: `/start ${firstCode}`, chat: { id: 424242 } } },
    });
    expect(firstWebhook.statusCode).toBe(200);

    const afterFirst = await db.query.pushSubscriptions.findMany({
      where: (row, { eq }) => eq(row.endpoint, "424242"),
    });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.accountId).toBe(firstAccount.account.id);

    const secondLink = await app.inject({
      method: "POST",
      url: "/v1/push/telegram/link",
      headers: { authorization: secondAccount.authHeader },
    });
    const { code: secondCode } = secondLink.json();

    const secondWebhook = await app.inject({
      method: "POST",
      url: "/v1/push/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      payload: { message: { text: `/start ${secondCode}`, chat: { id: 424242 } } },
    });
    expect(secondWebhook.statusCode).toBe(200);

    // Same chat id must resolve to exactly one subscription, now owned by
    // whichever account most recently completed pairing (delete-then-insert,
    // not a second row).
    const afterSecond = await db.query.pushSubscriptions.findMany({
      where: (row, { eq }) => eq(row.endpoint, "424242"),
    });
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]?.accountId).toBe(secondAccount.account.id);
  });
});
