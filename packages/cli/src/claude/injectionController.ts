// PTY-injection gating: when a message arrives from the web, Kvy types it
// into the SAME pseudo-terminal the interactive `claude` TUI is running on —
// exactly as if the human had typed it. The one hard constraint is *timing*:
// injecting mid-turn (while `claude` is streaming a reply or mid-render)
// corrupts the TUI or gets swallowed. So a web message is only typed in when
// the session is idle at its input prompt.
//
// A queued message is flushed only when the controller is `ready` (the TUI
// has painted its prompt after spawn), NOT busy, not mid-injection, not in
// the brief post-submit cooldown, and neither `promptOpen` nor `localDraft`
// is set. Flushing writes the text, waits `submitDelayMs` (250ms, letting the
// TUI ingest the text before Enter), then submits. The post-submit cooldown
// also covers messages that trigger no model fetch (e.g. slash commands) —
// without it they'd wait forever for a `busy` edge that never arrives.

import type { Logger } from "../logger.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** One web-originated message awaiting injection. `id` is the send envelope id used to complete the send claim on success. */
export interface PendingInjection {
  id: string;
  text: string;
}

export interface InjectionControllerDeps {
  /** Write the message text into the PTY master (as if pasted at the prompt). */
  writeText: (text: string) => void;
  /** Send the submit keystroke (Enter / carriage return) into the PTY master. */
  submit: () => void;
  /** Fired once a queued message has actually been submitted — the send-claim completion hook. */
  onInjected?: (id: string) => void;
  /**
   * Fired with messages that will NEVER be injected — either still-queued
   * entries dropped by `dispose()` (session ending with messages waiting), or
   * a message whose text was typed but whose submit was skipped because
   * `dispose()` ran mid-injection. The caller must fail the corresponding
   * send-claim rather than leave it indeterminate.
   */
  onDropped?: (messages: PendingInjection[]) => void;
  /** Delay between writing the text and sending the submit key. Default 250ms — long enough for the TUI to ingest the pasted text before Enter is sent. */
  submitDelayMs?: number;
  /** Quiet window after a submit before the next message may be injected. Default 1200ms. */
  postSubmitCooldownMs?: number;
  /** Injectable for tests; defaults to the global `setTimeout`. */
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Injectable for tests; defaults to the global `clearTimeout`. */
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
  logger?: Logger;
}

const DEFAULT_SUBMIT_DELAY_MS = 250;
const DEFAULT_POST_SUBMIT_COOLDOWN_MS = 1200;
/**
 * A `setPromptOpen(true)` that never sees a matching `setPromptOpen(false)`
 * (a dialog that vanished without an observed clearing signal) must not starve
 * the injection queue forever. This self-clears the gate after the timeout.
 */
const PROMPT_OPEN_FAILSAFE_MS = 120_000;

/**
 * Gates web-originated message injection into a live PTY so it only happens
 * when `claude` is idle at its prompt. See the module doc for the model.
 */
export class InjectionController {
  private readonly deps: InjectionControllerDeps;
  private readonly submitDelayMs: number;
  private readonly postSubmitCooldownMs: number;
  private readonly setTimeoutImpl: NonNullable<InjectionControllerDeps["setTimeoutImpl"]>;
  private readonly clearTimeoutImpl: NonNullable<InjectionControllerDeps["clearTimeoutImpl"]>;
  private readonly logger: Logger;

  private readonly queue: PendingInjection[] = [];
  private ready = false;
  private busy = false;
  private injecting = false;
  private cooldown = false;
  private promptOpen = false;
  private localDraft = false;
  private disposed = false;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private promptOpenFailsafeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: InjectionControllerDeps) {
    this.deps = deps;
    this.submitDelayMs = deps.submitDelayMs ?? DEFAULT_SUBMIT_DELAY_MS;
    this.postSubmitCooldownMs = deps.postSubmitCooldownMs ?? DEFAULT_POST_SUBMIT_COOLDOWN_MS;
    this.setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl = deps.clearTimeoutImpl ?? ((handle) => clearTimeout(handle));
    this.logger = deps.logger ?? noopLogger;
  }

  /** Queue a web message for injection. Flushed as soon as the gate opens. */
  enqueue(message: PendingInjection): void {
    if (this.disposed) return;
    this.queue.push(message);
    this.logger.debug("[injection] enqueued web message", {
      id: message.id,
      queueDepth: this.queue.length,
    });
    this.tryFlush();
  }

  /** Reflects whether `claude` is mid-turn (from the launcher's fetch signal). */
  setBusy(busy: boolean): void {
    if (this.disposed || this.busy === busy) return;
    this.busy = busy;
    if (!busy) this.tryFlush();
  }

  /** Marks the TUI as painted/interactive so the first message may be injected. */
  markReady(): void {
    if (this.disposed || this.ready) return;
    this.ready = true;
    this.tryFlush();
  }

  /** Number of messages still waiting to be injected. */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** True while a queued message is mid-write/submit — the local-submit-detection heuristic's own "not us" check. */
  get isInjecting(): boolean {
    return this.injecting;
  }

  /**
   * A TUI dialog (permission prompt / AskUserQuestion widget / trust prompt)
   * is on screen — never type a queued message into it. Cleared by the next
   * observed tool-result/`Stop`, or by the {@link PROMPT_OPEN_FAILSAFE_MS}
   * failsafe below if nothing ever clears it.
   */
  setPromptOpen(open: boolean): void {
    if (this.disposed || this.promptOpen === open) return;
    this.promptOpen = open;
    if (open) {
      this.promptOpenFailsafeTimer = this.setTimeoutImpl(() => {
        this.promptOpenFailsafeTimer = null;
        this.logger.warn(
          "[injection] promptOpen failsafe fired — clearing a gate nothing else cleared",
        );
        this.setPromptOpen(false);
      }, PROMPT_OPEN_FAILSAFE_MS);
    } else {
      if (this.promptOpenFailsafeTimer) {
        this.clearTimeoutImpl(this.promptOpenFailsafeTimer);
        this.promptOpenFailsafeTimer = null;
      }
      this.tryFlush();
    }
  }

  /** The human is mid-draft at the real keyboard — don't clobber their composer. */
  setLocalDraft(active: boolean): void {
    if (this.disposed || this.localDraft === active) return;
    this.localDraft = active;
    if (!active) this.tryFlush();
  }

  /**
   * Cancels pending timers and drops the queue. Safe to call once. Returns
   * whatever was still queued (never injected) so the caller can fail those
   * messages' send-claims instead of leaving them indeterminate — also
   * reported via {@link InjectionControllerDeps.onDropped}.
   *
   * The submit timer is deliberately NOT cleared here: if a message is
   * mid-injection (its text already written, waiting on the submit
   * keystroke — `this.injecting`), that message was already shifted off
   * `this.queue` and so can't appear in this method's own splice. Leaving
   * its timer running lets `tryFlush`'s own submit callback observe
   * `this.disposed` when it fires and report THAT message as dropped too —
   * one code path owns "a message that will now never be submitted"
   * instead of duplicating the check here.
   */
  dispose(): PendingInjection[] {
    if (this.disposed) return [];
    this.disposed = true;
    if (this.cooldownTimer) this.clearTimeoutImpl(this.cooldownTimer);
    if (this.promptOpenFailsafeTimer) this.clearTimeoutImpl(this.promptOpenFailsafeTimer);
    this.cooldownTimer = null;
    this.promptOpenFailsafeTimer = null;
    const dropped = this.queue.splice(0);
    if (dropped.length > 0) this.deps.onDropped?.(dropped);
    return dropped;
  }

  /**
   * True exactly when a queued message WOULD be injected right now — the
   * same idle/no-prompt predicate {@link canInject} uses, minus the
   * queue-length check. Exposed for the mode-cycle keystroke feature
   * (`ptyClaudeSession.ts`'s `sendModeCycle`): those
   * synthetic Shift+Tab presses carry the identical TUI-corruption risk as
   * typing a message mid-turn or into an open dialog, so they must be gated
   * by the identical rule, not a looser one.
   */
  get canInjectNow(): boolean {
    return (
      !this.disposed &&
      this.ready &&
      !this.busy &&
      !this.injecting &&
      !this.cooldown &&
      !this.promptOpen &&
      !this.localDraft
    );
  }

  private canInject(): boolean {
    return this.canInjectNow && this.queue.length > 0;
  }

  private tryFlush(): void {
    if (!this.canInject()) return;
    const message = this.queue.shift();
    if (!message) return;

    this.injecting = true;
    this.logger.debug("[injection] typing web message into PTY", { id: message.id });
    this.deps.writeText(message.text);

    // Deliberately not tracked/cancelable via a stored timer handle (unlike
    // `cooldownTimer`/`promptOpenFailsafeTimer`): `dispose()` intentionally
    // leaves this timer running so its own `this.disposed` check below still
    // fires and reports a mid-injection message as dropped (see `dispose`'s
    // doc comment).
    this.setTimeoutImpl(() => {
      if (this.disposed) {
        // The text was already typed (writeText ran above before this timer
        // was scheduled), but the child exited before the submit keystroke
        // could be sent — dispose()'s own queue splice never saw this
        // message (it was shifted off the queue before this callback was
        // scheduled), so it must be reported here or its send-claim would
        // hang open forever.
        this.deps.onDropped?.([message]);
        return;
      }
      this.deps.submit();
      this.injecting = false;
      this.logger.debug("[injection] submitted web message", { id: message.id });
      this.deps.onInjected?.(message.id);

      // Hold the gate closed briefly so a following queued message can't race
      // into the same prompt before this turn's own fetch-start lands (and so
      // a no-fetch message like a slash command still releases the gate).
      this.cooldown = true;
      this.cooldownTimer = this.setTimeoutImpl(() => {
        this.cooldownTimer = null;
        if (this.disposed) return;
        this.cooldown = false;
        this.tryFlush();
      }, this.postSubmitCooldownMs);
    }, this.submitDelayMs);
  }
}
