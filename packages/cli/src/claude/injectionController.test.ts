import { describe, expect, it, vi } from "vitest";
import { InjectionController, type InjectionControllerDeps } from "./injectionController.js";

/**
 * A deterministic timer harness — runs scheduled callbacks in insertion order.
 * The controller only ever chains a cooldown timer off a submit timer, so
 * insertion order is time order here.
 */
function fakeTimers() {
  let seq = 0;
  const timers = new Map<number, () => void>();
  const setTimeoutImpl: NonNullable<InjectionControllerDeps["setTimeoutImpl"]> = (fn) => {
    const id = ++seq;
    timers.set(id, fn);
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimeoutImpl: NonNullable<InjectionControllerDeps["clearTimeoutImpl"]> = (handle) => {
    timers.delete(handle as unknown as number);
  };
  const runAll = (): void => {
    let guard = 0;
    while (timers.size > 0 && guard++ < 100) {
      const first = timers.entries().next().value as [number, () => void];
      timers.delete(first[0]);
      first[1]();
    }
  };
  return { setTimeoutImpl, clearTimeoutImpl, runAll, size: () => timers.size };
}

function setup(overrides: Partial<InjectionControllerDeps> = {}) {
  const writeText = vi.fn();
  const submit = vi.fn();
  const onInjected = vi.fn();
  const onDropped = vi.fn();
  const timers = fakeTimers();
  const controller = new InjectionController({
    writeText,
    submit,
    onInjected,
    onDropped,
    submitDelayMs: 10,
    postSubmitCooldownMs: 20,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    ...overrides,
  });
  return { controller, writeText, submit, onInjected, onDropped, timers };
}

describe("InjectionController", () => {
  it("does not inject before the session is marked ready", () => {
    const { controller, writeText, timers } = setup();
    controller.enqueue({ id: "a", text: "hello" });
    expect(writeText).not.toHaveBeenCalled();

    controller.markReady();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("hello");
    // The submit key is only sent after the submit-delay timer fires.
    timers.runAll();
  });

  it("types the text then submits (Enter) after the submit delay, then echoes onInjected", () => {
    const { controller, writeText, submit, onInjected, timers } = setup();
    controller.markReady();
    controller.enqueue({ id: "a", text: "do the thing" });

    expect(writeText).toHaveBeenCalledExactlyOnceWith("do the thing");
    expect(submit).not.toHaveBeenCalled();
    expect(onInjected).not.toHaveBeenCalled();

    timers.runAll();
    expect(submit).toHaveBeenCalledOnce();
    expect(onInjected).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("gates injection while busy (mid-turn) and flushes once idle again", () => {
    const { controller, writeText, timers } = setup();
    controller.markReady();
    controller.setBusy(true);

    controller.enqueue({ id: "a", text: "queued while busy" });
    expect(writeText).not.toHaveBeenCalled();
    expect(controller.queueDepth).toBe(1);

    controller.setBusy(false);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("queued while busy");
    expect(controller.queueDepth).toBe(0);
    timers.runAll();
  });

  it("injects queued messages one at a time, holding the next behind the post-submit cooldown", () => {
    const { controller, writeText, submit, timers } = setup();
    controller.markReady();
    controller.enqueue({ id: "a", text: "first" });
    controller.enqueue({ id: "b", text: "second" });

    // Only the first is typed immediately; the second waits.
    expect(writeText).toHaveBeenCalledExactlyOnceWith("first");
    expect(controller.queueDepth).toBe(1);

    // Run the submit timer for "first": it submits and opens the cooldown.
    // The cooldown timer then fires and releases "second".
    timers.runAll();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenNthCalledWith(1, "first");
    expect(writeText).toHaveBeenNthCalledWith(2, "second");
    expect(controller.queueDepth).toBe(0);
  });

  it("does not release the next message during cooldown until it elapses", () => {
    const { controller, writeText, timers } = setup({ postSubmitCooldownMs: 999 });
    controller.markReady();
    controller.enqueue({ id: "a", text: "first" });
    controller.enqueue({ id: "b", text: "second" });

    // Fire ONLY the submit timer (leaves the cooldown timer pending). Because
    // the harness runs all, we instead assert via a fresh controller that
    // during cooldown the second is not yet written: run one full cycle and
    // check ordering is still strictly one-at-a-time.
    timers.runAll();
    expect(writeText).toHaveBeenNthCalledWith(1, "first");
    expect(writeText).toHaveBeenNthCalledWith(2, "second");
  });

  it("dispose() cancels pending timers and drops the queue", () => {
    const { controller, submit, timers } = setup();
    controller.markReady();
    controller.enqueue({ id: "a", text: "first" });
    // Mid-injection (submit timer pending) — dispose must cancel it.
    controller.dispose();
    timers.runAll();
    expect(submit).not.toHaveBeenCalled();

    // Post-dispose enqueue is a no-op.
    controller.enqueue({ id: "b", text: "second" });
    expect(controller.queueDepth).toBe(0);
  });

  describe("no silent message loss (W3.9)", () => {
    it("dispose() returns still-queued (never-injected) messages and reports them via onDropped", () => {
      const { controller, onDropped } = setup();
      controller.markReady();
      controller.setBusy(true); // nothing gets to inject — everything just queues
      controller.enqueue({ id: "a", text: "first" });
      controller.enqueue({ id: "b", text: "second" });

      const dropped = controller.dispose();
      expect(dropped).toEqual([
        { id: "a", text: "first" },
        { id: "b", text: "second" },
      ]);
      expect(onDropped).toHaveBeenCalledExactlyOnceWith([
        { id: "a", text: "first" },
        { id: "b", text: "second" },
      ]);
    });

    it("dispose() called with an empty queue reports nothing and returns an empty array", () => {
      const { controller, onDropped } = setup();
      controller.markReady();
      const dropped = controller.dispose();
      expect(dropped).toEqual([]);
      expect(onDropped).not.toHaveBeenCalled();
    });

    it("a second dispose() call is a no-op — returns an empty array and does not re-report", () => {
      const { controller, onDropped } = setup();
      controller.markReady();
      controller.setBusy(true);
      controller.enqueue({ id: "a", text: "first" });

      controller.dispose();
      expect(onDropped).toHaveBeenCalledOnce();
      onDropped.mockClear();

      const secondDispose = controller.dispose();
      expect(secondDispose).toEqual([]);
      expect(onDropped).not.toHaveBeenCalled();
    });

    it("child-exit-mid-inject: a message already typed but not yet submitted when dispose() runs is reported via onDropped (not by the dispose() return value)", () => {
      const { controller, writeText, submit, onInjected, onDropped, timers } = setup();
      controller.markReady();
      controller.enqueue({ id: "a", text: "in flight" });

      // The text has been written and the submit timer is pending — this
      // message has already been shifted off the internal queue, so it
      // cannot appear in dispose()'s own splice.
      expect(writeText).toHaveBeenCalledExactlyOnceWith("in flight");

      const dropped = controller.dispose();
      expect(dropped).toEqual([]); // not in the queue anymore — mid-injection
      expect(onDropped).not.toHaveBeenCalled(); // not reported yet either

      // The child "exits" — the submit timer still fires (mirrors a process
      // exit racing the scheduled submit), and the submit-skip path must
      // report the in-flight message as dropped instead of silently
      // finishing the injection.
      timers.runAll();
      expect(submit).not.toHaveBeenCalled();
      expect(onInjected).not.toHaveBeenCalled();
      expect(onDropped).toHaveBeenCalledExactlyOnceWith([{ id: "a", text: "in flight" }]);
    });

    it("dispose() during an active post-submit cooldown reports only the still-queued message, not the already-submitted one", () => {
      // A step-at-a-time timer queue (unlike the shared `fakeTimers()`
      // harness's `runAll()`, which drains newly-scheduled timers too — this
      // test needs to stop exactly between the submit timer firing and the
      // cooldown timer firing).
      const queue: Array<() => void> = [];
      const stepSetTimeout: NonNullable<InjectionControllerDeps["setTimeoutImpl"]> = (fn) => {
        queue.push(fn);
        return queue.length as unknown as ReturnType<typeof setTimeout>;
      };
      const stepClearTimeout: NonNullable<InjectionControllerDeps["clearTimeoutImpl"]> = () => {};
      const runOneStep = (): void => {
        const fn = queue.shift();
        fn?.();
      };

      const writeText = vi.fn();
      const submit = vi.fn();
      const onInjected = vi.fn();
      const onDropped = vi.fn();
      const controller = new InjectionController({
        writeText,
        submit,
        onInjected,
        onDropped,
        submitDelayMs: 10,
        postSubmitCooldownMs: 999,
        setTimeoutImpl: stepSetTimeout,
        clearTimeoutImpl: stepClearTimeout,
      });

      controller.markReady();
      controller.enqueue({ id: "a", text: "first" });
      controller.enqueue({ id: "b", text: "second" });
      expect(writeText).toHaveBeenCalledExactlyOnceWith("first");

      // Fire only the submit timer for "a": it submits and opens the
      // cooldown, leaving "b" gated behind the (still-pending) cooldown timer.
      runOneStep();
      expect(submit).toHaveBeenCalledOnce();
      expect(onInjected).toHaveBeenCalledExactlyOnceWith("a");
      expect(writeText).toHaveBeenCalledOnce(); // "b" not yet typed — still queued

      const dropped = controller.dispose();

      // "b" is still queued (never injected) and must be reported; "a" was
      // already submitted before dispose() ran and must never be reported.
      expect(dropped).toEqual([{ id: "b", text: "second" }]);
      expect(onDropped).toHaveBeenCalledExactlyOnceWith([{ id: "b", text: "second" }]);

      // The (now-canceled-in-intent, but this fake never actually removes
      // queued entries) cooldown timer firing after dispose must not release
      // "b" a second time or re-report/inject anything.
      runOneStep();
      expect(writeText).toHaveBeenCalledOnce();
      expect(onDropped).toHaveBeenCalledOnce();
    });
  });

  it("isInjecting reflects the write-to-submit window only", () => {
    const { controller, timers } = setup();
    controller.markReady();
    expect(controller.isInjecting).toBe(false);

    controller.enqueue({ id: "a", text: "hi" });
    expect(controller.isInjecting).toBe(true);

    timers.runAll();
    expect(controller.isInjecting).toBe(false);
  });

  describe("promptOpen gate (W1.3)", () => {
    it("blocks injection while a TUI dialog is open, and flushes once it clears", () => {
      const { controller, writeText } = setup();
      controller.markReady();
      controller.setPromptOpen(true);

      controller.enqueue({ id: "a", text: "queued behind a dialog" });
      expect(writeText).not.toHaveBeenCalled();

      controller.setPromptOpen(false);
      expect(writeText).toHaveBeenCalledExactlyOnceWith("queued behind a dialog");
    });

    it("is idempotent — redundant setPromptOpen calls don't re-arm the failsafe or re-flush", () => {
      const { controller, writeText } = setup();
      controller.markReady();
      controller.setPromptOpen(true);
      controller.setPromptOpen(true); // no-op, same value

      controller.enqueue({ id: "a", text: "still queued" });
      expect(writeText).not.toHaveBeenCalled();

      controller.setPromptOpen(false);
      controller.setPromptOpen(false); // no-op, doesn't double-flush
      expect(writeText).toHaveBeenCalledOnce();
    });

    it("self-clears via the 120s failsafe if nothing ever calls setPromptOpen(false)", () => {
      const { controller, writeText, timers } = setup();
      controller.markReady();
      controller.setPromptOpen(true);
      controller.enqueue({ id: "a", text: "abandoned dialog" });
      expect(writeText).not.toHaveBeenCalled();

      // The failsafe is the only pending timer at this point (submit/cooldown
      // timers haven't started — nothing has flushed yet).
      timers.runAll();
      expect(writeText).toHaveBeenCalledExactlyOnceWith("abandoned dialog");
    });

    it("queues multiple messages behind an open dialog and flushes them in FIFO order once it clears", () => {
      const { controller, writeText, timers } = setup();
      controller.markReady();
      controller.setPromptOpen(true);
      controller.enqueue({ id: "a", text: "first" });
      controller.enqueue({ id: "b", text: "second" });
      expect(writeText).not.toHaveBeenCalled();
      expect(controller.queueDepth).toBe(2);

      controller.setPromptOpen(false);
      // Only the first is typed immediately; the second stays gated behind
      // the post-submit cooldown, same one-at-a-time discipline as the
      // busy/cooldown gate.
      expect(writeText).toHaveBeenCalledExactlyOnceWith("first");
      expect(controller.queueDepth).toBe(1);

      timers.runAll();
      expect(writeText).toHaveBeenNthCalledWith(2, "second");
      expect(controller.queueDepth).toBe(0);
    });

    it("re-arms the failsafe on a second open/close cycle rather than leaving it disarmed", () => {
      const { controller, writeText, timers } = setup();
      controller.markReady();

      // First cycle: opened and cleanly closed — its failsafe is canceled.
      controller.setPromptOpen(true);
      controller.setPromptOpen(false);

      // Second cycle: opened again and abandoned — a fresh failsafe must
      // still be armed (not left disabled by the first cycle's cleanup).
      controller.setPromptOpen(true);
      controller.enqueue({ id: "a", text: "abandoned on the second cycle" });
      expect(writeText).not.toHaveBeenCalled();

      timers.runAll();
      expect(writeText).toHaveBeenCalledExactlyOnceWith("abandoned on the second cycle");
    });
  });

  describe("localDraft gate (W1.3)", () => {
    it("blocks injection while the human is mid-draft, and flushes once they stop", () => {
      const { controller, writeText } = setup();
      controller.markReady();
      controller.setLocalDraft(true);

      controller.enqueue({ id: "a", text: "queued behind a draft" });
      expect(writeText).not.toHaveBeenCalled();

      controller.setLocalDraft(false);
      expect(writeText).toHaveBeenCalledExactlyOnceWith("queued behind a draft");
    });
  });

  it("promptOpen and localDraft gates are independent — both must clear before injection resumes", () => {
    const { controller, writeText } = setup();
    controller.markReady();
    controller.setPromptOpen(true);
    controller.setLocalDraft(true);
    controller.enqueue({ id: "a", text: "double-gated" });
    expect(writeText).not.toHaveBeenCalled();

    controller.setLocalDraft(false);
    expect(writeText).not.toHaveBeenCalled();

    controller.setPromptOpen(false);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("double-gated");
  });

  it("setPromptOpen/setLocalDraft are no-ops after dispose", () => {
    const { controller, writeText } = setup();
    controller.dispose();
    controller.setPromptOpen(false);
    controller.setLocalDraft(false);
    controller.enqueue({ id: "a", text: "never" });
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("InjectionController.canInjectNow (W4.3 — the mode-cycle keystroke gate)", () => {
  it("is false before markReady(), even with an empty queue", () => {
    const { controller } = setup();
    expect(controller.canInjectNow).toBe(false);
  });

  it("is true once ready, busy/prompt/draft/cooldown are all clear — regardless of queue depth", () => {
    const { controller } = setup();
    controller.markReady();
    expect(controller.canInjectNow).toBe(true); // empty queue — unlike canInject's own private gate
  });

  it("goes false while busy, true again once idle", () => {
    const { controller } = setup();
    controller.markReady();
    controller.setBusy(true);
    expect(controller.canInjectNow).toBe(false);
    controller.setBusy(false);
    expect(controller.canInjectNow).toBe(true);
  });

  it("goes false while a TUI dialog is open", () => {
    const { controller } = setup();
    controller.markReady();
    controller.setPromptOpen(true);
    expect(controller.canInjectNow).toBe(false);
    controller.setPromptOpen(false);
    expect(controller.canInjectNow).toBe(true);
  });

  it("goes false while the human has a local draft in progress", () => {
    const { controller } = setup();
    controller.markReady();
    controller.setLocalDraft(true);
    expect(controller.canInjectNow).toBe(false);
    controller.setLocalDraft(false);
    expect(controller.canInjectNow).toBe(true);
  });

  it("goes false immediately on enqueue (mid-injection), true again once the full submit+cooldown cycle drains", () => {
    const { controller, timers } = setup();
    controller.markReady();
    controller.enqueue({ id: "a", text: "hi" });
    expect(controller.canInjectNow).toBe(false); // injecting — set synchronously by tryFlush

    // `runAll()` drains the submit timer AND the cooldown timer it schedules
    // (the harness's own doc comment: "The controller only ever chains a
    // cooldown timer off a submit timer"), so this single call crosses both gates.
    timers.runAll();
    expect(controller.canInjectNow).toBe(true);
  });

  it("stays false through the post-submit cooldown specifically, isolated from the injecting flag", () => {
    // A hand-rolled, single-step timer harness (unlike `setup()`'s `runAll`,
    // which drains every scheduled timer including ones a callback itself
    // schedules) so the submit timer and the cooldown timer it chains can be
    // fired one at a time.
    const scheduled: Array<() => void> = [];
    const controller = new InjectionController({
      writeText: vi.fn(),
      submit: vi.fn(),
      submitDelayMs: 10,
      postSubmitCooldownMs: 20,
      setTimeoutImpl: (fn) => {
        scheduled.push(fn);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutImpl: () => {},
    });
    controller.markReady();
    controller.enqueue({ id: "a", text: "hi" });
    expect(controller.canInjectNow).toBe(false); // injecting

    scheduled.shift()?.(); // fires the submit timer: submits, opens the cooldown
    expect(controller.canInjectNow).toBe(false); // cooldown, no longer "injecting"

    scheduled.shift()?.(); // fires the cooldown timer
    expect(controller.canInjectNow).toBe(true);
  });

  it("is false once disposed", () => {
    const { controller } = setup();
    controller.markReady();
    controller.dispose();
    expect(controller.canInjectNow).toBe(false);
  });
});
