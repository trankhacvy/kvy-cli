/**
 * PTY-injection gating (the "omnara model" — design §7, the terminal-attached
 * `falcon claude` input path).
 *
 * When a message arrives from the web (the `message` session RPC), Falcon
 * types it into the SAME pseudo-terminal the interactive `claude` TUI is
 * running on — the text, then a submit keystroke — exactly as if the human at
 * the keyboard had typed it. There is no mode switch and no process kill:
 * `claude` stays live and renders its normal TUI throughout.
 *
 * The one thing that MUST be gated is *timing*: injecting mid-turn (while
 * `claude` is streaming a reply, or mid-render) corrupts the TUI and/or gets
 * swallowed. So a web message is only ever typed in when the session is
 * **idle** — sitting at its input prompt. This class is the pure, fully
 * testable core of that gate; the surrounding `ptyClaudeSession.ts` feeds it
 * the idle/busy signal (derived from the launcher's `fetch-start`/`fetch-end`
 * instrumentation — the same signal `claudeLocal.ts` uses for its "thinking"
 * indicator) and the concrete PTY-write callbacks.
 *
 * Design (mirrors omnara's `claude_wrapper_v3.py` input-queue loop):
 *  - `enqueue()` queues a web message; it is never dropped.
 *  - `setBusy(true|false)` reflects whether `claude` is mid-turn.
 *  - A queued message is flushed only when the controller is `ready` (the TUI
 *    has painted its prompt after spawn), NOT busy, not already mid-injection,
 *    not in the brief post-submit cooldown, and neither `promptOpen` nor
 *    `localDraft` is set (plan-v2.md W1.3 — see those setters' own docs).
 *  - Flushing writes the text, waits `submitDelayMs` (letting the TUI ingest
 *    the pasted text before the Enter — omnara's 0.25s), then submits. After
 *    submit, a `postSubmitCooldownMs` cooldown prevents a second message from
 *    racing into the same prompt before the turn's own `fetch-start` flips
 *    `busy` true. The cooldown ALSO covers messages that trigger no model
 *    fetch at all (e.g. a slash command) — without it such a message would
 *    wait forever for a `busy` edge that never comes.
 */

import type { Logger } from "../logger.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** One web-originated message awaiting injection. `id` is the send envelope id (echoed to the §7.10 send-claim completion). */
export interface PendingInjection {
  id: string;
  text: string;
}

export interface InjectionControllerDeps {
  /** Write the message text into the PTY master (as if pasted at the prompt). */
  writeText: (text: string) => void;
  /** Send the submit keystroke (Enter / carriage return) into the PTY master. */
  submit: () => void;
  /** Fired once a queued message has actually been submitted — the send-claim completion hook (design §7.10). */
  onInjected?: (id: string) => void;
  /** Delay between writing the text and sending the submit key. Default 250ms (omnara's value). */
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
 * (a dialog that vanished without an observed clearing signal — the TUI
 * exited a menu some way the tailer/hook layer didn't catch) must not starve
 * the injection queue forever. This self-clears the gate (plan-v2.md W1.3).
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
  private submitTimer: ReturnType<typeof setTimeout> | null = null;
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

  /** Cancels any pending timers and drops the queue. Safe to call once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.submitTimer) this.clearTimeoutImpl(this.submitTimer);
    if (this.cooldownTimer) this.clearTimeoutImpl(this.cooldownTimer);
    if (this.promptOpenFailsafeTimer) this.clearTimeoutImpl(this.promptOpenFailsafeTimer);
    this.submitTimer = null;
    this.cooldownTimer = null;
    this.promptOpenFailsafeTimer = null;
    this.queue.length = 0;
  }

  private canInject(): boolean {
    return (
      !this.disposed &&
      this.ready &&
      !this.busy &&
      !this.injecting &&
      !this.cooldown &&
      !this.promptOpen &&
      !this.localDraft &&
      this.queue.length > 0
    );
  }

  private tryFlush(): void {
    if (!this.canInject()) return;
    const message = this.queue.shift();
    if (!message) return;

    this.injecting = true;
    this.logger.debug("[injection] typing web message into PTY", { id: message.id });
    this.deps.writeText(message.text);

    this.submitTimer = this.setTimeoutImpl(() => {
      this.submitTimer = null;
      if (this.disposed) return;
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
