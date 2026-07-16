import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpawnAwaiter } from "./spawnAwaiter.js";

describe("createSpawnAwaiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves waitFor once a matching pid is reported", async () => {
    const awaiter = createSpawnAwaiter();
    const promise = awaiter.waitFor(1234);

    const matched = awaiter.resolve({ sessionId: "sess_1", pid: 1234 });

    expect(matched).toBe(true);
    await expect(promise).resolves.toEqual({ sessionId: "sess_1", pid: 1234 });
  });

  it("resolve() returns false when no waiter exists for that pid", () => {
    const awaiter = createSpawnAwaiter();
    expect(awaiter.resolve({ sessionId: "sess_1", pid: 999 })).toBe(false);
  });

  it("rejects waitFor after the configured timeout with no matching webhook", async () => {
    const awaiter = createSpawnAwaiter({ timeoutMs: 15_000 });
    const promise = awaiter.waitFor(1234);
    const assertion = expect(promise).rejects.toThrow(/did not report back.*15000ms/);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("a second resolve() for the same pid after it already timed out is a no-op (returns false)", async () => {
    const awaiter = createSpawnAwaiter({ timeoutMs: 1_000 });
    const promise = awaiter.waitFor(1234);
    const assertion = expect(promise).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    expect(awaiter.resolve({ sessionId: "sess_1", pid: 1234 })).toBe(false);
  });

  it("keeps independent waiters for different pids", async () => {
    const awaiter = createSpawnAwaiter();
    const a = awaiter.waitFor(1);
    const b = awaiter.waitFor(2);

    awaiter.resolve({ sessionId: "sess_b", pid: 2 });
    await expect(b).resolves.toEqual({ sessionId: "sess_b", pid: 2 });

    awaiter.resolve({ sessionId: "sess_a", pid: 1 });
    await expect(a).resolves.toEqual({ sessionId: "sess_a", pid: 1 });
  });

  it("defaults the timeout to 15s", async () => {
    const awaiter = createSpawnAwaiter();
    const promise = awaiter.waitFor(1234);
    const assertion = expect(promise).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(14_999);
    // Not yet — still pending just before the 15s mark.
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});
