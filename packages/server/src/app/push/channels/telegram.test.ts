import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushSubscriptionRow } from "../types.js";

function fakeSubscription(overrides: Partial<PushSubscriptionRow> = {}): PushSubscriptionRow {
  return {
    id: "sub_1",
    accountId: "acct_1",
    channel: "telegram",
    endpoint: "12345", // Telegram chat id
    keys: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("telegramChannel", () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("skips sending (logs, doesn't throw) when TELEGRAM_BOT_TOKEN isn't configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { telegramChannel } = await import("./telegram.js");

    await expect(
      telegramChannel.send(fakeSubscription(), { sessionId: "sess_1", kind: "done" }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("posts a kind-keyed, content-free message to the Bot API sendMessage endpoint", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    delete process.env.PUBLIC_WEB_ORIGIN;
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const { telegramChannel } = await import("./telegram.js");

    await telegramChannel.send(fakeSubscription(), { sessionId: "sess_1", kind: "perm" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-token/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ chat_id: "12345", text: "Kvy needs your permission" }),
      }),
    );
  });

  it("appends a deep link when PUBLIC_WEB_ORIGIN is configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.PUBLIC_WEB_ORIGIN = "https://app.kvy.dev";
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const { telegramChannel } = await import("./telegram.js");

    await telegramChannel.send(fakeSubscription(), { sessionId: "sess_1", kind: "done" });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.text).toBe("Kvy finished a task\nhttps://app.kvy.dev/dashboard/session/sess_1/");
  });

  it("maps a 400/403 (gone chat) onto statusCode 410 for dispatch.ts's pruning rule", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    fetchMock.mockResolvedValue(new Response("chat not found", { status: 400 }));
    const { telegramChannel } = await import("./telegram.js");

    await expect(
      telegramChannel.send(fakeSubscription(), { sessionId: "sess_1", kind: "done" }),
    ).rejects.toMatchObject({ statusCode: 410 });
  });

  it("throws (without a statusCode) on any other failure", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));
    const { telegramChannel } = await import("./telegram.js");

    const err: unknown = await telegramChannel
      .send(fakeSubscription(), { sessionId: "sess_1", kind: "done" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { statusCode?: number }).statusCode).toBeUndefined();
  });
});
