import { describe, expect, it, vi } from "vitest";
import {
  type PushApiPort,
  type PushEnvironment,
  type PushManagerLike,
  type PushSubscriptionLike,
  subscribeToPush,
  toSubscribeBody,
  unsubscribeFromPush,
} from "../subscribe.js";

function fakeSubscription(overrides: Partial<PushSubscriptionLike> = {}): PushSubscriptionLike {
  return {
    endpoint: "https://push.example/device-1",
    toJSON: () => ({
      endpoint: "https://push.example/device-1",
      keys: { p256dh: "p256dh-val", auth: "auth-val" },
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function fakeEnvironment(opts: {
  supported?: boolean;
  existing?: PushSubscriptionLike | null;
  subscribeResult?: PushSubscriptionLike;
}): { env: PushEnvironment; pushManager: PushManagerLike } {
  const pushManager: PushManagerLike = {
    getSubscription: vi.fn().mockResolvedValue(opts.existing ?? null),
    subscribe: vi.fn().mockResolvedValue(opts.subscribeResult ?? fakeSubscription()),
  };
  return {
    env: {
      isSupported: () => opts.supported ?? true,
      getPushManager: vi.fn().mockResolvedValue(pushManager),
    },
    pushManager,
  };
}

function fakeApi(): PushApiPort & { subscribeCalls: unknown[]; unsubscribeCalls: unknown[] } {
  const subscribeCalls: unknown[] = [];
  const unsubscribeCalls: unknown[] = [];
  return {
    subscribeCalls,
    unsubscribeCalls,
    async subscribe(token, body) {
      subscribeCalls.push({ token, body });
      return { id: "sub_1" };
    },
    async unsubscribe(token, endpoint) {
      unsubscribeCalls.push({ token, endpoint });
      return { ok: true as const };
    },
  };
}

describe("toSubscribeBody", () => {
  it("shapes a PushSubscription into the server's webpush subscribe body", () => {
    expect(toSubscribeBody(fakeSubscription())).toEqual({
      channel: "webpush",
      endpoint: "https://push.example/device-1",
      keys: { p256dh: "p256dh-val", auth: "auth-val" },
    });
  });

  it("throws if the browser subscription is missing its keys", () => {
    expect(() => toSubscribeBody(fakeSubscription({ toJSON: () => ({ endpoint: "e" }) }))).toThrow(
      /p256dh\/auth/,
    );
  });
});

describe("subscribeToPush", () => {
  it("returns 'unsupported' without touching the API when Web Push isn't available", async () => {
    const { env } = fakeEnvironment({ supported: false });
    const api = fakeApi();

    const result = await subscribeToPush(env, api, "tok", "vapid-key");

    expect(result).toBe("unsupported");
    expect(api.subscribeCalls).toHaveLength(0);
  });

  it("reuses an existing browser subscription instead of creating a new one", async () => {
    const existing = fakeSubscription();
    const { env, pushManager } = fakeEnvironment({ existing });
    const api = fakeApi();

    const result = await subscribeToPush(env, api, "tok", "vapid-key");

    expect(result).toBe("subscribed");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.subscribeCalls).toEqual([
      {
        token: "tok",
        body: {
          channel: "webpush",
          endpoint: "https://push.example/device-1",
          keys: { p256dh: "p256dh-val", auth: "auth-val" },
        },
      },
    ]);
  });

  it("subscribes fresh (with the VAPID key) when there's no existing subscription", async () => {
    const { env, pushManager } = fakeEnvironment({ existing: null });
    const api = fakeApi();

    // A real base64url-encoded VAPID public key (any valid base64url string
    // will do — `urlBase64ToUint8Array` just needs something decodable).
    await subscribeToPush(env, api, "tok", "aGVsbG8td29ybGQ");

    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    const call = (pushManager.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.userVisibleOnly).toBe(true);
    expect(call.applicationServerKey).toBeInstanceOf(Uint8Array);
  });
});

describe("unsubscribeFromPush", () => {
  it("returns 'unsupported' without touching the API when Web Push isn't available", async () => {
    const { env } = fakeEnvironment({ supported: false });
    const api = fakeApi();

    expect(await unsubscribeFromPush(env, api, "tok")).toBe("unsupported");
    expect(api.unsubscribeCalls).toHaveLength(0);
  });

  it("returns 'not-subscribed' when there's no existing browser subscription", async () => {
    const { env } = fakeEnvironment({ existing: null });
    const api = fakeApi();

    expect(await unsubscribeFromPush(env, api, "tok")).toBe("not-subscribed");
    expect(api.unsubscribeCalls).toHaveLength(0);
  });

  it("unsubscribes both browser-side and server-side when a subscription exists", async () => {
    const existing = fakeSubscription();
    const { env } = fakeEnvironment({ existing });
    const api = fakeApi();

    const result = await unsubscribeFromPush(env, api, "tok");

    expect(result).toBe("unsubscribed");
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(api.unsubscribeCalls).toEqual([
      { token: "tok", endpoint: "https://push.example/device-1" },
    ]);
  });
});
