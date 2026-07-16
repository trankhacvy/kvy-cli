import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushSubscriptionRow } from "../types.js";

function fakeSubscription(overrides: Partial<PushSubscriptionRow> = {}): PushSubscriptionRow {
  return {
    id: "sub_1",
    accountId: "acct_1",
    channel: "ntfy",
    endpoint: "my-ntfy-topic",
    keys: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("ntfyChannel", () => {
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

  it("publishes a kind-keyed, content-free message to the configured topic (default ntfy.sh)", async () => {
    delete process.env.NTFY_BASE_URL;
    delete process.env.PUBLIC_WEB_ORIGIN;
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const { ntfyChannel } = await import("./ntfy.js");

    await ntfyChannel.send(fakeSubscription(), { sessionId: "sess_1", kind: "question" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ntfy.sh/my-ntfy-topic",
      expect.objectContaining({
        method: "POST",
        headers: { Title: "Falcon" },
        body: "Falcon has a question for you",
      }),
    );
  });

  it("uses NTFY_BASE_URL when configured (self-hosted ntfy) and sets a Click deep link", async () => {
    process.env.NTFY_BASE_URL = "https://ntfy.internal/";
    process.env.PUBLIC_WEB_ORIGIN = "https://app.falcon.dev";
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const { ntfyChannel } = await import("./ntfy.js");

    await ntfyChannel.send(fakeSubscription(), { sessionId: "sess_1", kind: "failed" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ntfy.internal/my-ntfy-topic",
      expect.objectContaining({
        headers: { Title: "Falcon", Click: "https://app.falcon.dev/session/sess_1/" },
      }),
    );
  });

  it("throws when the publish request fails", async () => {
    fetchMock.mockResolvedValue(new Response("bad topic", { status: 400 }));
    const { ntfyChannel } = await import("./ntfy.js");

    await expect(
      ntfyChannel.send(fakeSubscription(), { sessionId: "sess_1", kind: "done" }),
    ).rejects.toThrow(/ntfy publish failed/);
  });
});
