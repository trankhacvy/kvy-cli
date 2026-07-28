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

  // A4: the child's own best-effort self-report of why it failed
  // (`/session-start-failed`) rejects the waiter immediately with the real
  // error, not the generic 15s timeout message.
  describe("reject()", () => {
    it("rejects waitFor immediately with the reported error, well before the timeout", async () => {
      const awaiter = createSpawnAwaiter({ timeoutMs: 15_000 });
      const promise = awaiter.waitFor(1234);
      const assertion = expect(promise).rejects.toThrow(
        /reported a startup failure: quota exceeded/,
      );

      const matched = awaiter.reject(1234, "quota exceeded");
      expect(matched).toBe(true);
      await assertion;

      // No leftover timer firing later and trying to reject an already-settled promise.
      await vi.advanceTimersByTimeAsync(15_000);
    });

    it("returns false when no waiter exists for that pid", () => {
      const awaiter = createSpawnAwaiter();
      expect(awaiter.reject(999, "boom")).toBe(false);
    });

    it("a resolve() racing after reject() already settled the waiter is a no-op", async () => {
      const awaiter = createSpawnAwaiter();
      const promise = awaiter.waitFor(1234);
      awaiter.reject(1234, "boom");
      await expect(promise).rejects.toThrow(/boom/);

      expect(awaiter.resolve({ sessionId: "sess_1", pid: 1234 })).toBe(false);
    });
  });

  // A3: `watchExit` (from `processLauncher.ts`'s `LaunchedProcess`) lets
  // `waitFor` learn the spawned process died and reject fast — a known,
  // fast failure (crash, bad exec, quota rejection observed indirectly by
  // the process just exiting) must not have to wait out the full timeout to
  // surface.
  describe("watchExit-driven fast rejection", () => {
    it("rejects immediately (well before the timeout) when the watched process is observed to exit", async () => {
      const awaiter = createSpawnAwaiter({ timeoutMs: 15_000 });
      type ExitCallback = (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
      let fireExit: ExitCallback | undefined;
      const watchExit = vi.fn((onExit: ExitCallback) => {
        fireExit = onExit;
        return () => {};
      });

      const promise = awaiter.waitFor(1234, { watchExit: watchExit as never });
      const assertion = expect(promise).rejects.toThrow(
        /exited before it reported starting \(exit code 1\)/,
      );

      fireExit?.({ code: 1, signal: null });
      await assertion;

      // The timer must have been cleared — advancing past the original
      // timeout must not throw an unhandled rejection or double-settle.
      await vi.advanceTimersByTimeAsync(15_000);
    });

    it("does not fire the exit-driven rejection once the process already reported success", async () => {
      let unsubscribed = false;
      const watchExit = vi.fn(() => () => {
        unsubscribed = true;
      });

      const awaiter = createSpawnAwaiter();
      const promise = awaiter.waitFor(1234, { watchExit: watchExit as never });
      awaiter.resolve({ sessionId: "sess_1", pid: 1234 });

      await expect(promise).resolves.toEqual({ sessionId: "sess_1", pid: 1234 });
      // The exit watcher must be unsubscribed once settled — no leaked
      // subscription/poll interval hanging around after success.
      expect(unsubscribed).toBe(true);
    });

    it("still applies the ordinary timeout when the process never exits and never reports", async () => {
      const watchExit = vi.fn(() => () => {});
      const awaiter = createSpawnAwaiter({ timeoutMs: 15_000 });
      const promise = awaiter.waitFor(1234, { watchExit: watchExit as never });
      const assertion = expect(promise).rejects.toThrow(/did not report back.*15000ms/);

      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    });
  });
});
