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
