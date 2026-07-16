import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushSubscriptionRow } from "../types.js";

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();

vi.mock("web-push", () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
  },
}));

function fakeSubscription(overrides: Partial<PushSubscriptionRow> = {}): PushSubscriptionRow {
  return {
    id: "sub_1",
    accountId: "acct_1",
    channel: "webpush",
    endpoint: "https://push.example/abc",
    keys: { p256dh: "p256dh-val", auth: "auth-val" },
    createdAt: new Date(),
    ...overrides,
  };
}

describe("webpushChannel", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    sendNotification.mockReset().mockResolvedValue(undefined);
    setVapidDetails.mockReset();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("configures VAPID once and sends the generic {sessionId, kind} payload", async () => {
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    const { webpushChannel } = await import("./webpush.js");

    await webpushChannel.send(fakeSubscription(), { sessionId: "sess_1", kind: "done" });
    await webpushChannel.send(fakeSubscription({ id: "sub_2" }), {
      sessionId: "sess_2",
      kind: "failed",
    });

    expect(setVapidDetails).toHaveBeenCalledTimes(1); // configured lazily, once per process
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenNthCalledWith(
      1,
      { endpoint: "https://push.example/abc", keys: { p256dh: "p256dh-val", auth: "auth-val" } },
      JSON.stringify({ sessionId: "sess_1", kind: "done" }),
    );
  });

  it("skips sending (logs, doesn't throw) when VAPID keys aren't configured", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    const { webpushChannel } = await import("./webpush.js");

    await expect(
      webpushChannel.send(fakeSubscription(), { sessionId: "sess_1", kind: "done" }),
    ).resolves.toBeUndefined();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("throws when the subscription is missing its p256dh/auth keys", async () => {
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    const { webpushChannel } = await import("./webpush.js");

    await expect(
      webpushChannel.send(fakeSubscription({ keys: null }), { sessionId: "sess_1", kind: "done" }),
    ).rejects.toThrow(/p256dh\/auth/);
  });

  it("propagates the underlying web-push error (dispatch.ts uses this for gone-subscription cleanup)", async () => {
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    const { webpushChannel } = await import("./webpush.js");

    await expect(
      webpushChannel.send(fakeSubscription(), { sessionId: "sess_1", kind: "done" }),
    ).rejects.toMatchObject({ statusCode: 410 });
  });
});
