import { describe, expect, it, vi } from "vitest";
import type { PushSubscriptionRow } from "../types.js";
import { ntfyChannel } from "./ntfy.js";
import { telegramChannel } from "./telegram.js";

function fakeSubscription(channel: string): PushSubscriptionRow {
  return {
    id: "sub_1",
    accountId: "acct_1",
    channel,
    endpoint: "topic-or-chat-id",
    keys: null,
    createdAt: new Date(),
  };
}

// Falcon add (plan.md §10): fallback channels accept subscriptions today but their
// senders are documented no-ops until a later task — this just locks in "doesn't throw,
// doesn't silently pretend to succeed either" (it logs) for both stubs.
describe("fallback channel stubs", () => {
  it("telegramChannel.send resolves without throwing and logs the drop", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      telegramChannel.send(fakeSubscription("telegram"), { sessionId: "sess_1", kind: "done" }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("ntfyChannel.send resolves without throwing and logs the drop", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      ntfyChannel.send(fakeSubscription("ntfy"), { sessionId: "sess_1", kind: "perm" }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
