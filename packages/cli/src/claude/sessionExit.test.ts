import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ReportSessionFailedResult } from "../api/sessionStatus.js";
import { createSessionExitTracker } from "./sessionExit.js";

/** A minimal `NodeJS.Process`-shaped fake: just enough `on`/`off`/`exit` for the tracker. */
function fakeProcess() {
  const emitter = new EventEmitter();
  const exit = vi.fn();
  return {
    proc: {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        emitter.on(event, listener);
        return emitter as unknown as NodeJS.Process;
      },
      off: (event: string, listener: (...args: unknown[]) => void) => {
        emitter.off(event, listener);
        return emitter as unknown as NodeJS.Process;
      },
      exit,
    } as unknown as NodeJS.Process,
    emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    exit,
  };
}

function buildTracker(overrides: Partial<Parameters<typeof createSessionExitTracker>[0]> = {}) {
  const reportSessionFailed = vi.fn<
    (...args: unknown[]) => Promise<ReportSessionFailedResult>
  >().mockResolvedValue({ type: "ok" });
  const { proc, emit, exit } = fakeProcess();

  const tracker = createSessionExitTracker({
    reportDeps: { backendUrl: "http://backend.example", accessToken: "tok" },
    reportSessionFailed,
    process: proc,
    ...overrides,
  });

  return { tracker, reportSessionFailed, emit, exit };
}

describe("createSessionExitTracker", () => {
  it("clean exit (child exited 0): no report, classified clean-exit", async () => {
    const { tracker, reportSessionFailed } = buildTracker();
    const stop = tracker.start();

    const reason = await tracker.handleOutcome("sess_1", { ok: true });

    expect(reason).toEqual({ kind: "clean-exit" });
    expect(reportSessionFailed).not.toHaveBeenCalled();
    stop();
  });

  it("Ctrl-C (SIGINT) before child exit: session stays active, no report", async () => {
    const { tracker, reportSessionFailed, emit } = buildTracker();
    const stop = tracker.start();

    emit("SIGINT");
    expect(tracker.sawSignal()).toBe(true);

    const reason = await tracker.handleOutcome("sess_1", {
      ok: false,
      error: new Error("Process terminated with signal: SIGINT"),
    });

    expect(reason).toEqual({ kind: "signal-exit", signal: "SIGINT" });
    expect(reportSessionFailed).not.toHaveBeenCalled();
    stop();
  });

  it("SIGTERM (terminal close) before child exit: session stays active, no report", async () => {
    const { tracker, reportSessionFailed, emit } = buildTracker();
    const stop = tracker.start();

    emit("SIGTERM");
    const reason = await tracker.handleOutcome("sess_1", {
      ok: false,
      error: new Error("Process terminated with signal: SIGTERM"),
    });

    expect(reason).toEqual({ kind: "signal-exit", signal: "SIGTERM" });
    expect(reportSessionFailed).not.toHaveBeenCalled();
    stop();
  });

  it("infers a resumable signal-exit even without an observed process signal (ordering-independent)", async () => {
    const { tracker, reportSessionFailed } = buildTracker();
    const stop = tracker.start();

    const reason = await tracker.handleOutcome("sess_1", {
      ok: false,
      error: new Error("Process terminated with signal: SIGINT"),
    });

    expect(reason).toEqual({ kind: "signal-exit", signal: "SIGINT" });
    expect(reportSessionFailed).not.toHaveBeenCalled();
    stop();
  });

  it("crash (unexpected exit code, no signal observed): reports failed", async () => {
    const { tracker, reportSessionFailed } = buildTracker();
    const stop = tracker.start();

    const error = new Error("Process exited with code: 1");
    const reason = await tracker.handleOutcome("sess_1", { ok: false, error });

    expect(reason).toEqual({ kind: "crash", error });
    expect(reportSessionFailed).toHaveBeenCalledTimes(1);
    expect(reportSessionFailed).toHaveBeenCalledWith(
      { backendUrl: "http://backend.example", accessToken: "tok" },
      { sessionId: "sess_1", error },
    );
    stop();
  });

  it("crash with no known session id yet: does not call the reporter at all", async () => {
    const { tracker, reportSessionFailed } = buildTracker();
    const stop = tracker.start();

    const reason = await tracker.handleOutcome(null, {
      ok: false,
      error: new Error("spawn ENOENT"),
    });

    expect(reason.kind).toBe("crash");
    expect(reportSessionFailed).not.toHaveBeenCalled();
    stop();
  });

  it("swallows a reporter failure — handleOutcome still resolves with the crash reason", async () => {
    const reportSessionFailed = vi
      .fn<(...args: unknown[]) => Promise<ReportSessionFailedResult>>()
      .mockResolvedValue({ type: "network-error", error: "ECONNREFUSED" });
    const { tracker } = buildTracker({ reportSessionFailed });
    const stop = tracker.start();

    const error = new Error("Process exited with code: 1");
    const reason = await tracker.handleOutcome("sess_1", { ok: false, error });

    expect(reason).toEqual({ kind: "crash", error });
    stop();
  });

  it("uncaughtException: reports (when a session id is known) then calls exitOnUncaught(1)", async () => {
    const reportSessionFailed = vi
      .fn<(...args: unknown[]) => Promise<ReportSessionFailedResult>>()
      .mockResolvedValue({ type: "ok" });
    const exitOnUncaught = vi.fn();
    const { proc, emit } = fakeProcess();

    const tracker = createSessionExitTracker({
      reportDeps: { backendUrl: "http://backend.example", accessToken: "tok" },
      reportSessionFailed,
      process: proc,
      exitOnUncaught,
    });
    const stop = tracker.start();

    // Session id becomes known via a prior handleOutcome call in the real
    // flow; simulate that by tracking one clean exit first isn't quite
    // right here — instead, drive the currentSessionId the same way the
    // real caller would: handleOutcome is what records it, so call it once
    // with ok:true is wrong for this test. Directly exercise the
    // uncaughtException path after a crash-classified handleOutcome call
    // has already recorded the session id.
    await tracker.handleOutcome("sess_1", { ok: false, error: new Error("code 1") });
    reportSessionFailed.mockClear();

    emit("uncaughtException", new Error("bug in wrapper"));
    // uncaughtException handling is async (fires the report, then exits) —
    // flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(reportSessionFailed).toHaveBeenCalledWith(
      { backendUrl: "http://backend.example", accessToken: "tok" },
      { sessionId: "sess_1", error: expect.objectContaining({ message: "bug in wrapper" }) },
    );
    expect(exitOnUncaught).toHaveBeenCalledWith(1);
    stop();
  });

  it("start() returns a cleanup function that removes all listeners", async () => {
    const { tracker, reportSessionFailed, emit } = buildTracker();
    const stop = tracker.start();
    stop();

    // After cleanup, a signal firing on the underlying process object must
    // not affect a tracker that has already stopped listening.
    emit("SIGINT");
    expect(tracker.sawSignal()).toBe(false);

    const reason = await tracker.handleOutcome("sess_1", {
      ok: false,
      error: new Error("Process exited with code: 1"),
    });
    expect(reason.kind).toBe("crash");
    expect(reportSessionFailed).toHaveBeenCalledTimes(1);
  });
});
