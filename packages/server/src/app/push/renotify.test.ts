import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenotifyScheduler } from "./renotify.js";

describe("createRenotifyScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a retry at +5min and another at +10min for a perm dispatch", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    const scheduler = createRenotifyScheduler();

    scheduler.onDispatch({ sessionId: "sess_1", kind: "perm", retry });
    expect(retry).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(retry).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(retry).toHaveBeenCalledTimes(2);

    // No third follow-up — max 3 total (1 initial handled by the caller + 2 here).
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("schedules follow-ups for a question dispatch too", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    const scheduler = createRenotifyScheduler();

    scheduler.onDispatch({ sessionId: "sess_q", kind: "question", retry });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("does not schedule anything for terminal kinds (done/failed)", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    const scheduler = createRenotifyScheduler();

    scheduler.onDispatch({ sessionId: "sess_2", kind: "done", retry });
    scheduler.onDispatch({ sessionId: "sess_3", kind: "failed", retry });
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(retry).not.toHaveBeenCalled();
  });

  it("cancels a pending schedule when a later dispatch supersedes it", async () => {
    const firstRetry = vi.fn().mockResolvedValue(undefined);
    const secondRetry = vi.fn().mockResolvedValue(undefined);
    const scheduler = createRenotifyScheduler();

    scheduler.onDispatch({ sessionId: "sess_4", kind: "perm", retry: firstRetry });
    // A terminal event for the same session arrives before the +5min follow-up fires.
    scheduler.onDispatch({ sessionId: "sess_4", kind: "done", retry: secondRetry });

    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(firstRetry).not.toHaveBeenCalled();
    expect(secondRetry).not.toHaveBeenCalled();
  });

  it("restarts the schedule when a new perm-request supersedes a still-pending one", async () => {
    const firstRetry = vi.fn().mockResolvedValue(undefined);
    const secondRetry = vi.fn().mockResolvedValue(undefined);
    const scheduler = createRenotifyScheduler();

    scheduler.onDispatch({ sessionId: "sess_5", kind: "perm", retry: firstRetry });
    await vi.advanceTimersByTimeAsync(2 * 60_000); // partway through, no follow-up yet

    scheduler.onDispatch({ sessionId: "sess_5", kind: "perm", retry: secondRetry });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(firstRetry).not.toHaveBeenCalled(); // stale schedule was cancelled
    expect(secondRetry).toHaveBeenCalledTimes(1);
  });

  it("tracks independent schedules per session", async () => {
    const retryA = vi.fn().mockResolvedValue(undefined);
    const retryB = vi.fn().mockResolvedValue(undefined);
    const scheduler = createRenotifyScheduler();

    scheduler.onDispatch({ sessionId: "sess_a", kind: "perm", retry: retryA });
    scheduler.onDispatch({ sessionId: "sess_b", kind: "perm", retry: retryB });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(retryA).toHaveBeenCalledTimes(1);
    expect(retryB).toHaveBeenCalledTimes(1);
  });

  it("cancelAll clears every pending timer across sessions", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    const scheduler = createRenotifyScheduler();

    scheduler.onDispatch({ sessionId: "sess_6", kind: "perm", retry });
    scheduler.onDispatch({ sessionId: "sess_7", kind: "perm", retry });
    scheduler.cancelAll();

    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(retry).not.toHaveBeenCalled();
  });

  it("logs and swallows a retry rejection instead of throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const retry = vi.fn().mockRejectedValue(new Error("channel down"));
    const scheduler = createRenotifyScheduler();

    scheduler.onDispatch({ sessionId: "sess_8", kind: "perm", retry });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // let the rejected promise's .catch() microtask run
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());

    errorSpy.mockRestore();
  });
});
