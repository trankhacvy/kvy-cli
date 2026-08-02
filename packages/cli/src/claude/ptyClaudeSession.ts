/**
 * PTY-injection Claude session — the terminal-attached `kvy claude` input
 * takeover for sessions that have a real terminal).
 *
 * ## What this replaces and why
 * The v1 local path spawned the real `claude` CLI with `stdio: 'inherit'` and
 * could only OBSERVE it (via the transcript tailer). To accept a web-sent
 * message it had to KILL the interactive `claude` and take over with a
 * headless remote turn that rendered an Ink "remote mode" status view —
 * destroying the normal TUI (no typing, no slash commands). That takeover is
 * the #1 UX complaint.
 *
 * Instead, this module runs `claude` on a **pseudo-terminal**:
 *  1. `claude` renders its **normal TUI**, always. The user's real stdin is
 *     forwarded (raw mode) to the PTY master, so typing and slash commands
 *     feel exactly normal; PTY output is forwarded to stdout; SIGWINCH-style
 *     resizes are propagated to the pty.
 *  2. A message arriving from the web (`injectMessage`) is **typed into the
 *     same PTY** — text, then a submit key — as if the user typed it. No mode
 *     switch, no process kill, no Ink takeover, ever. Timing is gated by
 *     `InjectionController` off the launcher's idle/busy signal.
 *  3. Mirroring to the web is UNCHANGED: the transcript tailer
 *     (`scanner.ts` → `mapClaudeToEnvelopes` → `onEnvelopes` → outbox) keeps
 *     producing structured envelopes for the web timeline.
 *
 * ## The idle/busy signal under a PTY
 * The launcher (`kvy_claude_launcher.cjs`) instruments `global.fetch` and
 * emits `fetch-start`/`fetch-end` JSON lines. A PTY child has no spare fd 3,
 * so those lines are delivered over a unix-domain socket this module listens
 * on (path passed as `KVY_FETCH_SIGNAL_PATH`). The same debounce
 * `claudeLocal.ts` uses for its "thinking" indicator turns them into a clean
 * busy/idle edge for the `InjectionController`. Native-binary Claude installs
 * can't be fetch-instrumented in-process (documented launcher limitation) —
 * there the busy edge never fires and injection is gated by the post-submit
 * cooldown alone.
 *
 * ## Permission / lifecycle-hook seam (owned by the caller, not this module)
 * There is exactly ONE hook server per session, and this module does NOT own
 * it. The terminal `kvy claude` flow installs a single hook server (via
 * `remotePermissionHook.ts`'s `installRemotePermissionHook()`) that owns all
 * four Claude Code hooks — `SessionStart` (real provider session id),
 * `Notification`/`Stop` (attention + turn-end), and `PreToolUse` (remote
 * permission answering while the TUI stays live). That composition hands this
 * module two things:
 *  - `settingsPath`/`settingsEnv` — merged into the PTY-spawned `claude`'s
 *    args (`--settings <path>`) + env (`KVY_HOOK_SETTINGS_PATH`) so every
 *    hook fires.
 *  - the provider session id, forwarded in via `notifyProviderSessionId()` on
 *    the returned handle, which this module routes to the transcript tailer
 *    (`scanner.onNewSession`) exactly as the old self-owned hook server did.
 * This module never starts its own hook server — running two would double the
 * hooks and race the session-id/attention signals.
 */

import type { PermDecision, PermissionMode, SessionEnvelope } from "@kvy/wire";
import { createId } from "@paralleldrive/cuid2";
import { spawn as spawnPtyDefault } from "node-pty";
import type { Logger } from "../logger.js";
import { findLastLocalSession, KVY_SYSTEM_PROMPT, resolveSessionFlags } from "./claudeLocal.js";
import {
  type ClaudeEnvelopeMapperState,
  closeClaudeTurnWithStatus,
  createClaudeEnvelopeMapperState,
  mapClaudeToEnvelopes,
  type SessionTurnEndStatus,
} from "./envelopeMapper.js";
import { InjectionController, type PendingInjection } from "./injectionController.js";
import {
  type AskQuestion,
  type AskQuestionOption,
  isExitPlanTool,
  permissionModeCyclePresses,
} from "./pretoolPermissionBridge.js";
import {
  createFetchSignalServer as createFetchSignalServerDefault,
  type FetchSignalEvent,
  type FetchSignalServer,
} from "./ptyFetchSignal.js";
import {
  createSessionScanner as createSessionScannerDefault,
  type SessionScanner,
} from "./scanner.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** How long after the last active fetch ends before `busy` flips back to idle (mirrors `claudeLocal.ts`). */
const DEFAULT_BUSY_DEBOUNCE_MS = 500;
/** Grace period after spawn before the first web message may be typed in (lets the TUI paint its prompt). */
const DEFAULT_READY_DELAY_MS = 1500;
const DRAFT_IDLE_MS = 15_000;
const DEFAULT_PTY_NAME = "xterm-256color";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * `closeTurn`'s retry budget (docs/user-flows.md fix-plan task 1). Confirmed
 * live: Claude Code's `Stop` hook can fire before its own transcript write
 * for the final assistant message has landed on disk — `flush()` alone
 * can't help if the entry genuinely isn't there yet, no matter how fresh
 * the read is. A few short retries gives the write time to land without
 * noticeably delaying the (already async, fire-and-forget) turn close from
 * the user's perspective.
 *
 * A single "this flush found nothing new" reading is NOT enough to declare
 * the transcript settled: for a tool-using turn, `currentTurnId` becomes
 * non-null at the FIRST assistant entry (the tool call) and stays open
 * across several more disk writes (tool result, final text) — so a flush
 * landing between two of those writes finds nothing new for reasons
 * indistinguishable from "genuinely done." Confirmed live: trusting one
 * quiet flush closed the turn right after the tool call, before the
 * model's actual final reply had been written — silently orphaning that
 * reply in a turn that never got its own `turn-end`. Requiring
 * {@link CLOSE_TURN_QUIET_FLUSHES_REQUIRED} *consecutive* quiet flushes
 * before closing gives a still-in-progress write another full retry
 * interval to show up before we trust the quiet reading.
 */
const CLOSE_TURN_MAX_ATTEMPTS = 5;
const CLOSE_TURN_RETRY_DELAY_MS = 100;
const CLOSE_TURN_QUIET_FLUSHES_REQUIRED = 2;

/** The submit keystroke — a carriage return, the same byte a real Enter sends on a TTY. */
const SUBMIT_KEY = "\r";
const SHIFT_TAB_KEY = "[Z";
/** Right arrow — moves between the `AskUserQuestion` widget's per-question
 * tabs and its final "Submit" review tab (live-verified against Claude Code
 * 2.1.220: a multi-select question's checkboxes don't auto-advance the way a
 * single-select answer does, so this is the only way off that tab). */
const RIGHT_ARROW_KEY = "[C";

/**
 * Claude Code's own confirmation dialog when `/model <alias>` is run mid-
 * conversation (issue #12 — a session with existing history costs a
 * cache-invalidating re-read, so it asks "Switch model? ... 1. Yes ... 2.
 * No" before actually switching; a fresh, history-free session applies
 * instantly with no dialog at all). Confirmed live against real Claude Code
 * v2.1.218: the dialog is rendered PURELY in the live terminal, never
 * written to the JSONL transcript, so it's invisible to every other
 * detection mechanism in this codebase (all transcript-file-based) — this
 * is the one place Kvy pattern-matches raw PTY output instead. Matched
 * against a small rolling buffer, not each individual `onData` chunk, since
 * a PTY can split the string across writes.
 */
const MODEL_SWITCH_CONFIRM_PATTERN = /Switch model\?/;
/** How long after typing `/model` to keep watching for the confirmation dialog before giving up. */
const MODEL_SWITCH_CONFIRM_ARM_MS = 5000;
/** Bounds the rolling raw-output buffer `MODEL_SWITCH_CONFIRM_PATTERN` is tested against. */
const MODEL_SWITCH_CONFIRM_BUFFER_MAX = 500;

/**
 * Claude Code's own live status-bar text for the permission mode the TUI is
 * CURRENTLY in — rendered at the bottom of the screen on every frame, never
 * written to the JSONL transcript, same reasoning {@link
 * MODEL_SWITCH_CONFIRM_PATTERN}'s doc comment gives for pattern-matching raw
 * PTY output instead: this is the only other place in Kvy that does it.
 *
 * Exists for `setMode`'s own bug (`start.ts`'s RPC handler,
 * `pretoolPermissionBridge.ts`'s "permission_mode cache + real PTY setMode"
 * doc comment): the ONLY other confirmation channel — the next hook call's
 * own `permission_mode` field — never arrives at all while the session sits
 * idle, which is the COMMON case for a web-initiated mode switch (a user
 * usually changes mode before their next message, not mid-tool-call), so
 * hook-echo-only verification honestly-but-wrongly reported failure even
 * though the keystrokes had already landed. This is a second, faster,
 * hook-independent signal the caller races alongside the hook echo — see
 * `waitForModeStatus`'s own doc comment.
 *
 * Live-verified against real Claude Code v2.1.220 by scripting an actual
 * `claude` PTY session (via `node-pty`, not a guess from a captured
 * terminal) and driving genuine Shift+Tab presses:
 *  - `default`: `⏸ manual mode on` — NOT followed by `(shift+tab to
 *    cycle)`; the idle/default status line always ends `· ? for shortcuts`
 *    instead, unlike the other two modes below (live-verified: this is
 *    consistent whether it's the session's very first render or a Shift+Tab
 *    cycle landing back on default).
 *  - `acceptEdits`: `⏵⏵ accept edits on`, followed by `(shift+tab to
 *    cycle)`.
 *  - `plan`: `⏸ plan mode on`, followed by `(shift+tab to cycle)`.
 *  - `bypassPermissions` has NO entry: live-verified unreachable via the
 *    Shift+Tab cycle in this environment at all (cycling past `plan`
 *    produces `auto mode unavailable for this model` and falls back to
 *    `default`, never rendering a `bypassPermissions` status line) — already
 *    documented as genuine Claude Code behavior in docs/known-issues.md
 *    issue #11, not a Kvy bug. There is no status text to ever match for
 *    it, so {@link waitForModeStatus} resolves `false` immediately rather
 *    than arming a watcher that could never fire.
 *
 * Each pattern anchors on the glyph immediately preceding its phrase
 * (`⏸`/`⏵⏵`) — live-verified always written CONTIGUOUSLY with the phrase in
 * one PTY write, unlike the trailing `(shift+tab to cycle)`/`· ? for
 * shortcuts` hint text, which Claude Code's own renderer sometimes splits
 * around a mid-string cursor-repositioning escape (a partial-redraw diff
 * against the PREVIOUS frame — e.g. `"(shift+tab " + "\x1b[30G" + "o
 * cycle)"` was captured live, the diff only rewriting the one byte that
 * actually changed). That's a real frame-diffing behavior, not a PTY
 * write-boundary split a rolling buffer can paper over — the bytes
 * genuinely interrupting the phrase belong to the same logical frame — so
 * the trailing hint text is deliberately NOT part of the match. Anchoring on
 * glyph+phrase alone (rather than the bare phrase) still minimizes any
 * chance of the model's own conversational output accidentally matching —
 * the same false-positive concern {@link MODEL_SWITCH_CONFIRM_PATTERN}
 * already accepts for "Switch model?", but a glyph+phrase pair reads far
 * less like ordinary prose than a bare phrase would.
 */
const MODE_STATUS_PATTERNS: Partial<Record<PermissionMode, RegExp>> = {
  default: /⏸ manual mode on/,
  acceptEdits: /⏵⏵ accept edits on/,
  plan: /⏸ plan mode on/,
};
/** Bounds the rolling raw-output buffer {@link MODE_STATUS_PATTERNS} is tested against — mirrors `MODEL_SWITCH_CONFIRM_BUFFER_MAX`. */
const MODE_STATUS_BUFFER_MAX = 500;

/** The minimal `IPty` surface this module drives — node-pty's `IPty` satisfies it structurally. */
export interface PtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** Options node-pty's `spawn` accepts that this module sets. */
export interface SpawnPtyOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** The real terminal stdin surface this module reads (a subset of `tty.ReadStream`). */
export interface StdinLike {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (data: Buffer) => void): void;
  removeListener(event: "data", listener: (data: Buffer) => void): void;
}

/** The real terminal stdout surface this module writes (a subset of `tty.WriteStream`). */
export interface StdoutLike {
  columns?: number;
  rows?: number;
  write(data: string): boolean;
  on(event: "resize", listener: () => void): void;
  removeListener(event: "resize", listener: () => void): void;
}

export interface PtyClaudeSessionOptions {
  workingDirectory: string;
  /** Resolved path to `scripts/kvy_claude_launcher.cjs`. */
  launcherPath: string;
  /** Resolved real path to the `claude` CLI (passed to the launcher as `KVY_CLAUDE_PATH`). */
  claudeCliPath: string;
  /** Provider passthrough args (never mutated). */
  claudeArgs: string[];
  /** Provider (Claude Code) session id to resume, or null for fresh/whatever-claudeArgs-says. */
  providerSessionId: string | null;
  /** `~/.kvy` (or override) — hosts the fetch-signal socket + temp dirs. */
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Path to the shared hook `--settings` file (owned by the caller's single
   * `installRemotePermissionHook()` composition). Passed to the PTY-spawned
   * `claude` as `--settings <path>` so all four hooks fire. Null/undefined
   * when the hook server failed to install (session runs without hooks).
   */
  settingsPath?: string | null;
  /**
   * Env vars carrying the hook settings path onto the spawned `claude`'s
   * environment (`{ KVY_HOOK_SETTINGS_PATH: <path> }`) — merged into the
   * PTY child's env. From the same composition as `settingsPath`.
   */
  settingsEnv?: Record<string, string>;
  /** Every envelope the tailer maps off the transcript. Forward to the outbox. */
  onEnvelopes: (envelopes: SessionEnvelope[]) => void;
  /** Fires with Claude Code's own auto-generated one-line summary
   * (`{"type":"summary","summary":"..."}` transcript entry) the moment it
   * appears — `mapClaudeToEnvelopes` discards this entry type entirely
   * (it's not conversation content), so it has to be read here, straight off
   * the raw scanner output, before that mapping call. */
  onSummaryTitle?: (title: string) => void;
  onInjected?: (id: string) => void;
  /**
   * Fires with messages that will never be injected — session ending with
   * some still queued, or one whose text was typed but whose submit was
   * The caller must fail those messages' send-claims (`start.ts` completes
   * them as `dropped-session-ended`) so a web retry sees an honest
   * `duplicate` instead of hanging as `outcome-unknown` forever.
   */
  onDroppedInjections?: (messages: PendingInjection[]) => void;
  onLocalSubmit?: () => void;
  logger?: Logger;
}

export interface PtyClaudeSessionDeps {
  /** Injectable for tests; defaults to node-pty's `spawn`. */
  spawnPty?: (file: string, args: string[], options: SpawnPtyOptions) => PtyLike;
  /** Injectable for tests; defaults to `process.stdin`. */
  stdin?: StdinLike;
  /** Injectable for tests; defaults to `process.stdout`. */
  stdout?: StdoutLike;
  createSessionScanner?: typeof createSessionScannerDefault;
  createFetchSignalServer?: typeof createFetchSignalServerDefault;
  findLastSession?: (workingDirectory: string, env?: NodeJS.ProcessEnv) => string | null;
  systemPrompt?: string;
  /** Grace period after spawn before the first injection (default 1500ms). */
  readyDelayMs?: number;
  /** Idle debounce after the last fetch ends (default 500ms). */
  busyDebounceMs?: number;
  /** Passed through to `InjectionController` — delay between typing text and Enter (default 250ms). */
  submitDelayMs?: number;
  /** Passed through to `InjectionController` — post-submit quiet window (default 1200ms). */
  postSubmitCooldownMs?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
  logger?: Logger;
}

export interface PtyClaudeSessionHandle {
  /** Resolves with the child's exit code once `claude` exits (or 1 on a spawn/setup failure). */
  readonly done: Promise<number>;
  /** Types a web-originated message into the live PTY when idle (queued while busy). */
  injectMessage(message: PendingInjection): void;
  /**
   * Feed the real provider session id (from the caller's single shared hook
   * server's `SessionStart`) to the transcript tailer. Buffered if the tailer
   * isn't up yet. Replaces the old self-owned hook server's direct
   * `scanner.onNewSession` call.
   */
  notifyProviderSessionId(id: string): void;
  /**
   * Reflects "a TUI dialog is open" from the hook layer (`Notification`
   * attention / a local-turn `PreToolUse`-or-`PermissionRequest` deferral) —
   * gates injection so a queued web message is never typed into an open
   */
  setPromptOpen(open: boolean): void;
  sendInterrupt(): boolean;
  /**
   * Types `presses` Shift+Tab keystrokes into the live PTY — Claude Code's
   * PTY path"). Gated by the SAME idle/no-prompt rule as message injection
   * (`InjectionController.canInjectNow`) — a synthetic keystroke mid-turn or
   * into an open dialog carries the identical TUI-corruption risk a queued
   * message would. Returns `false` (and sends nothing) when the gate is
   * closed or the child hasn't spawned yet; the caller (`start.ts`'s
   * `setMode` RPC handler) reports that as an honest `{ok:false}` rather
   * than pretending the switch happened.
   */
  sendModeCycle(presses: number): boolean;
  /**
   * Resolves `true` the instant Claude Code's own live status-bar text for
   * `target` mode appears in raw PTY output (see {@link
   * MODE_STATUS_PATTERNS}'s doc comment for the exact live-verified text per
   * mode), or `false` once `timeoutMs` elapses with no match. A second,
   * FASTER, hook-independent confirmation signal for `setMode` — this
   * module has no visibility into the hook-echo path at all (it lives in
   * `pretoolPermissionBridge.ts`'s `waitForModeEcho`); the caller
   * (`start.ts`'s `setMode` RPC handler) races the two, resolving success as
   * soon as EITHER confirms, so an idle session with no tool call imminent
   * (the common case for a web-initiated mode switch, and the exact bug this
   * closes) doesn't have to wait out a hook echo that may never arrive at
   * all. Resolves `false` immediately, arming nothing, for
   * `bypassPermissions` — live-verified unreachable via the Shift+Tab cycle,
   * so there is no status text that could ever match.
   *
   * At most one watcher armed at a time (mirrors the `sendModelChange`
   * confirm-dialog watcher just above) — a second call disarms the first's
   * watcher (which then resolves `false`, same as an ordinary timeout) and
   * takes over the shared rolling buffer. Fine in practice: `start.ts`'s
   * `setMode` RPC handler only ever has one mode switch in flight.
   */
  waitForModeStatus(target: PermissionMode, timeoutMs: number): Promise<boolean>;
  /**
   * Answers a locally-typed turn's OPEN permission dialog from a web
   * `perm.answer` decision — real two-way remote control (the point of
   * running `kvy claude` in a terminal at all: a user can walk away and
   * approve from their phone). Deliberately NOT gated by
   * `InjectionController.canInjectNow` like {@link sendModeCycle}/{@link
   * injectMessage} — those exist to keep a keystroke OUT of an open dialog;
   * this method's whole job is to answer the dialog that's currently open,
   * so requiring `!promptOpen` would make it unable to ever fire. Mirrors
   * {@link sendInterrupt}'s simpler gate instead (just "is there a live PTY
   * to write to").
   *
   * Keystroke mapping for an ORDINARY permission dialog (matches Claude
   * Code's own conventions — "1. Yes" / an optional "session" option
   * shortcut-labeled `(shift+tab)` / "N. No", "Esc to cancel"):
   *  - `{kind:"deny"}` → Escape, the dialog's own documented cancel gesture.
   *  - `{kind:"mode", mode}` or `{kind:"allow", scope:"session"}` (session-
   *    scoped allow IS a mode switch to `acceptEdits` in the live TUI) →
   *    the same Shift+Tab cycle {@link sendModeCycle} uses, computed from
   *    `currentMode` via `permissionModeCyclePresses`, then Enter to confirm.
   *  - `{kind:"allow", scope:"once"}` → `"1"` then Enter — the dialog's
   *    first, most conservative affirmative option, explicit rather than
   *    relying on it staying the pre-highlighted default (same reasoning
   *    {@link MODEL_SWITCH_CONFIRM_PATTERN}'s watcher already uses above).
   *
   * `ExitPlanMode`'s OWN dialog ({@link isExitPlanTool}) is a DIFFERENT
   * widget with different option semantics — live-verified against 2.1.220,
   * NOT assumed:
   *  - `{kind:"deny"}` → still Escape (confirmed: rejects the plan cleanly,
   *    same as the dialog's own "Tell Claude what to change" + no feedback).
   *  - `{kind:"allow", scope:"once"}` → `"2"` then Enter — "Yes, manually
   *    approve edits" (approves the plan, mode unchanged — every subsequent
   *    edit still asks). Digit `"1"` here is a DIFFERENT thing entirely
   *    ("Yes, auto-accept edits", a mode switch), the reverse of what `"1"`
   *    means on every other permission dialog — using it for a plain
   *    "once" approval would silently flip the session into acceptEdits.
   *  - `{kind:"allow", scope:"session"}` → `"1"` then Enter — "Yes,
   *    auto-accept edits". No Shift+Tab cycle: this dialog's own Shift+Tab
   *    means "approve with this feedback" (tied to option 4), unrelated to
   *    {@link sendModeCycle}'s generic mode-cycle gesture.
   *  - `{kind:"mode", mode}` → `false`, nothing written. This dialog has no
   *    general mode picker (only the two affirmative options above), so an
   *    arbitrary target mode has no keystroke to reach it.
   *
   * This has an inherent, irreducible race this method cannot fully close:
   * if the human at the keyboard answers the SAME dialog at the same moment
   * a web decision drives it, both inputs land on one live TUI. Accepted
   * trade-off for the feature actually working, not a bug to "fix" here.
   *
   * Returns `false` (writes nothing) only when there's no live PTY child at
   * all (not spawned yet, or already exited), or for an unreachable
   * `ExitPlanMode` mode target as above.
   */
  answerPermission(
    decision: PermDecision,
    currentMode: PermissionMode | null,
    toolName: string,
  ): boolean;
  /**
   * Answers a locally-typed turn's OPEN `AskUserQuestion` widget from a web
   * decision — same real two-way remote control as {@link answerPermission},
   * a distinct keystroke model. Live-verified against Claude Code 2.1.220:
   *
   *  - `{kind:"deny"}` (the web card's "Chat about this") → Escape, this
   *    widget's own documented cancel gesture.
   *  - `{kind:"allow", updatedInput:{answers}}` — for each question in
   *    order, its answer string (a label, or comma-joined labels for a
   *    multi-select question) is matched against that question's own
   *    options: matched option(s) get their 1-based digit pressed (a
   *    single-select question's digit press auto-advances to the next tab;
   *    a multi-select question's does not, so {@link RIGHT_ARROW_KEY}
   *    explicitly advances after its digits). An answer that matches none of
   *    the options is driven as free text instead: the digit one past the
   *    last option selects the widget's own always-present "Type something"
   *    row (live-verified: that digit only puts the row into an inline edit
   *    field, it does NOT submit on its own — unlike every other option's
   *    digit), then each character of the answer is typed into it, then
   *    Enter confirms that question's answer and advances. Answering the
   *    LAST question lands on the widget's own "Submit answers" review tab,
   *    so `"1"` + Enter there confirms.
   *
   * Computes every keystroke for every question BEFORE writing anything, and
   * writes nothing at all (returns `false`) if any question has no answer.
   */
  answerAskUserQuestion(decision: PermDecision, questions: AskQuestion[]): boolean;
  /**
   * Types `/model <alias>` + submit into the live PTY — Claude Code's own
   * model-switch slash command (docs/known-issues.md issue #12, "web model
   * selector"). Unlike {@link sendModeCycle}'s raw Shift+Tab escape bytes,
   * this goes through the SAME `InjectionController` queue/gate a web chat
   * message uses (`injectMessage`'s underlying `controller.enqueue`) rather
   * than a direct `ptyProcess.write` — a slash command is ordinary typed
   * text + Enter, not a synthetic terminal escape sequence, and the
   * controller's `submitDelayMs`/cooldown timing exists specifically to let
   * the TUI ingest pasted text before Enter (`injectionController.ts`'s
   * module doc). Still requires `canInjectNow` to already be true at call
   * time (checked here, synchronously, before enqueueing) so the caller
   * gets an honest `false` instead of the command silently queuing behind
   * whatever's next — same gate discipline as `sendModeCycle`. Returns
   * `false` (and injects nothing) when the gate is closed or the child
   * hasn't spawned yet; the caller (`start.ts`'s `setModel` RPC handler)
   * reports that as an honest `{ok:false}` rather than pretending the
   * switch happened.
   *
   * Also arms a short-lived watcher (`MODEL_SWITCH_CONFIRM_PATTERN`) for
   * Claude Code's own "Switch model?" dialog — real Claude Code shows this
   * whenever the session already has conversation history (switching costs
   * a cache-invalidating re-read), and auto-confirms it on the caller's
   * behalf: the web user already decided to switch by calling this, so a
   * second confirmation would just be `/model` silently hanging the RPC out
   * to an honest-but-misleading timeout. A brand-new, history-free session
   * applies instantly with no dialog at all — that's why this wasn't caught
   * until live end-to-end testing against a real session with prior turns.
   */
  sendModelChange(model: string): boolean;
  /**
   * Force-closes the currently open turn on the wire, the instant Claude
   * Code's own `Stop` hook fires (docs/user-flows.md fix-plan task 1) —
   * reuses the SAME tailer mapper state `onEnvelopes` is driven from
   * (`envelopeMapper.ts`'s `closeClaudeTurnWithStatus`), rather than
   * inventing a parallel turn-tracking mechanism. A no-op when no turn is
   * currently open (e.g. the transcript scanner's own `type:"user"` branch
   * already closed it first) — `closeClaudeTurnWithStatus` itself is
   * idempotent. Any resulting `turn-end` (and `sub-stop`) envelopes are
   * forwarded through `onEnvelopes`, exactly like a tailer-driven turn close.
   *
   * Awaits the scanner's `flush()` first — but a single flush isn't always
   * enough, and "a turn is open" isn't the right thing to wait for either:
   * confirmed live, Claude Code's `Stop` hook can fire before its own
   * transcript write for the final assistant message has landed on disk,
   * AND (for a tool-using turn) `currentTurnId` becomes non-null at the
   * FIRST assistant entry and stays open across several more writes (tool
   * result, final text) — so "a turn is open" is true almost immediately
   * and proves nothing about whether the turn has actually finished.
   * Instead, retries `flush()` up to {@link CLOSE_TURN_MAX_ATTEMPTS} times,
   * {@link CLOSE_TURN_RETRY_DELAY_MS} apart, requiring
   * {@link CLOSE_TURN_QUIET_FLUSHES_REQUIRED} *consecutive* passes that find
   * nothing new before trusting that the transcript has actually settled —
   * so the common case (everything already landed) costs two quick
   * flushes, and the race case costs a few hundred ms, not an
   * indefinitely-stuck turn or a prematurely-closed one.
   */
  closeTurn(status: SessionTurnEndStatus): Promise<void>;
  /** Terminates the session (SIGTERM to the pty child). Safe to call once. */
  stop(): void;
}

/**
 * A desktop notification via OSC 9, plus a BEL. Deliberately NOT a screen write: the
 * provider's TUI owns the framebuffer while a session runs, and painting into it would
 * corrupt its rendering exactly the way `logger.ts` exists to prevent
 *
 * HONEST SCOPE: OSC 9 is implemented by iTerm2, WezTerm, kitty and Ghostty, and ignored by
 * terminals that don't support it. This raises the chance the user notices in time; it does
 * not guarantee it. The guarantee is `start.ts`'s post-session review, which always runs.
 */
export function notifyTerminal(write: (text: string) => void, text: string): void {
  // ESC ] 9 ; <text> BEL — OSC 9, BEL-terminated. Non-rendering: no cursor movement and
  // no framebuffer write, so there is nothing for the provider TUI to repaint over.
  write(`\x1b]9;${text}\x07`);
}

function askQuestionOptionLabel(option: AskQuestionOption): string {
  return typeof option === "string" ? option : option.label;
}

/** `decision.updatedInput.answers` narrowed to `Record<string,string>`, or
 * `null` for any other shape (including a plain `allow` with no `answers`
 * at all) — mirrors the web's own `extractAskAnswers` (`ask-question-state.ts`). */
function extractQuestionAnswers(updatedInput: unknown): Record<string, string> | null {
  if (typeof updatedInput !== "object" || updatedInput === null || Array.isArray(updatedInput)) {
    return null;
  }
  const answers = (updatedInput as Record<string, unknown>).answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return null;
  for (const value of Object.values(answers)) {
    if (typeof value !== "string") return null;
  }
  return answers as Record<string, string>;
}

/**
 * The exact keystrokes to answer every question in order, or `null` if any
 * question has no answer at all. An answer that doesn't match one of the
 * question's own option labels is driven as free text (live-verified against
 * 2.1.220): the widget always appends its own "Type something" row right
 * after the listed options; that row's digit puts it into an inline edit
 * field instead of submitting, typed characters replace its placeholder text
 * in place, and Enter then confirms it like any other answered tab.
 */
function planAskUserQuestionKeystrokes(
  questions: AskQuestion[],
  answers: Record<string, string>,
): string[] | null {
  const keystrokes: string[] = [];
  for (const question of questions) {
    const answer = answers[question.question];
    if (!answer) return null;
    const selectedLabels = answer
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label.length > 0);

    const indices: number[] = [];
    let allMatched = selectedLabels.length > 0;
    for (const label of selectedLabels) {
      const index = question.options.findIndex(
        (option) => askQuestionOptionLabel(option) === label,
      );
      if (index === -1) {
        allMatched = false;
        break;
      }
      indices.push(index);
    }

    if (allMatched) {
      for (const index of indices) keystrokes.push(String(index + 1));
      // A single-select answer auto-advances to the next tab; a multi-select
      // one doesn't, so it needs an explicit push off its own tab.
      if (question.multiSelect) keystrokes.push(RIGHT_ARROW_KEY);
    } else {
      keystrokes.push(String(question.options.length + 1));
      keystrokes.push(...answer.split(""));
      keystrokes.push(SUBMIT_KEY);
    }
  }
  // A lone single-select question has no tab bar at all — its digit press
  // both answers AND submits the whole form immediately (live-verified: a
  // trailing "1" here would leak into the next chat prompt instead). Any
  // multi-select question, or more than one question, DOES use the tabbed
  // flow, which lands on the widget's own "Submit answers" review tab
  // (itself option "1") once every question is answered.
  if (questions.length > 1 || questions.some((question) => question.multiSelect)) {
    keystrokes.push("1");
  }
  return keystrokes;
}

/**
 * Gap between consecutive `answerAskUserQuestion` keystrokes. Live-verified
 * necessary against Claude Code 2.1.220: writing two digit keystrokes back
 * to back with no gap (e.g. toggling two multi-select checkboxes) silently
 * dropped the second one — the widget's own re-render needs a moment to
 * catch up before it can register the next keypress, the same reasoning
 * `injectionController.ts`'s `submitDelayMs` documents for pasted text vs.
 * its trailing Enter.
 */
const ASK_QUESTION_KEYSTROKE_DELAY_MS = 150;

/** Writes `keystrokes` to `pty` one at a time, `delayMs` apart — see {@link
 * ASK_QUESTION_KEYSTROKE_DELAY_MS}'s doc for why consecutive writes can't
 * just happen synchronously back to back. */
function writeKeystrokesPaced(
  pty: PtyLike,
  keystrokes: string[],
  delayMs: number,
  setTimeoutImpl: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
): void {
  const [next, ...rest] = keystrokes;
  if (next === undefined) return;
  pty.write(next);
  if (rest.length > 0) {
    setTimeoutImpl(() => writeKeystrokesPaced(pty, rest, delayMs, setTimeoutImpl), delayMs);
  }
}

/**
 * Start one PTY-attached Claude session. Returns immediately with a handle;
 * spawn/setup happens asynchronously, and `injectMessage` calls made before
 * setup finishes are queued by the `InjectionController` until the TUI is
 * ready. See the module doc for the model.
 */
export function startPtyClaudeSession(
  opts: PtyClaudeSessionOptions,
  deps: PtyClaudeSessionDeps = {},
): PtyClaudeSessionHandle {
  const logger = deps.logger ?? opts.logger ?? noopLogger;
  const env = opts.env ?? process.env;
  const spawnPty = deps.spawnPty ?? ((file, args, options) => spawnPtyDefault(file, args, options));
  const stdin = deps.stdin ?? (process.stdin as unknown as StdinLike);
  const stdout = deps.stdout ?? (process.stdout as unknown as StdoutLike);
  const createSessionScanner = deps.createSessionScanner ?? createSessionScannerDefault;
  const createFetchSignalServer = deps.createFetchSignalServer ?? createFetchSignalServerDefault;
  const findLastSession = deps.findLastSession ?? findLastLocalSession;
  const systemPrompt = deps.systemPrompt ?? KVY_SYSTEM_PROMPT;
  const readyDelayMs = deps.readyDelayMs ?? DEFAULT_READY_DELAY_MS;
  const busyDebounceMs = deps.busyDebounceMs ?? DEFAULT_BUSY_DEBOUNCE_MS;
  const setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? ((handle) => clearTimeout(handle));

  let ptyProcess: PtyLike | null = null;
  let settled = false;
  let stopped = false;
  const cleanups: Array<() => void | Promise<void>> = [];

  // `sendModelChange`'s confirmation-dialog watcher (see
  // `MODEL_SWITCH_CONFIRM_PATTERN`'s doc comment) — armed for a short window
  // right after typing `/model`, disarmed on either a match (confirmed) or
  // the arm timer expiring (no dialog appeared, e.g. a fresh history-free
  // session). `modelSwitchConfirmBuffer` only accumulates while armed, so a
  // long-lived session sitting idle for hours doesn't pay for it.
  let awaitingModelSwitchConfirm = false;
  let modelSwitchConfirmBuffer = "";
  let modelSwitchConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  const disarmModelSwitchConfirmWatcher = (): void => {
    awaitingModelSwitchConfirm = false;
    modelSwitchConfirmBuffer = "";
    if (modelSwitchConfirmTimer) {
      clearTimeoutImpl(modelSwitchConfirmTimer);
      modelSwitchConfirmTimer = null;
    }
  };
  const armModelSwitchConfirmWatcher = (): void => {
    disarmModelSwitchConfirmWatcher();
    awaitingModelSwitchConfirm = true;
    modelSwitchConfirmTimer = setTimeoutImpl(
      disarmModelSwitchConfirmWatcher,
      MODEL_SWITCH_CONFIRM_ARM_MS,
    );
  };
  cleanups.push(disarmModelSwitchConfirmWatcher);

  // `waitForModeStatus`'s watcher — same arm/disarm shape as the model-switch
  // confirm watcher just above, but for `MODE_STATUS_PATTERNS` (see that
  // constant's doc comment). At most one armed at a time: settling an
  // in-flight watcher early — a match, a second `waitForModeStatus` call
  // superseding it, or the session stopping — always goes through this one
  // function so `modeStatusResolve` is nulled out BEFORE the promise
  // resolves, making a redundant second settle attempt (e.g. a match arriving
  // in the same tick the arm-expiry timer already fired) a safe no-op instead
  // of a double-resolve.
  let modeStatusTarget: PermissionMode | null = null;
  let modeStatusBuffer = "";
  let modeStatusResolve: ((matched: boolean) => void) | null = null;
  let modeStatusTimer: ReturnType<typeof setTimeout> | null = null;
  const finishModeStatusWatcher = (matched: boolean): void => {
    const resolve = modeStatusResolve;
    modeStatusTarget = null;
    modeStatusBuffer = "";
    modeStatusResolve = null;
    if (modeStatusTimer) {
      clearTimeoutImpl(modeStatusTimer);
      modeStatusTimer = null;
    }
    resolve?.(matched);
  };
  cleanups.push(() => finishModeStatusWatcher(false));

  // The transcript tailer, created asynchronously in `run()`. The provider
  // session id arrives from the caller's shared hook server via
  // `notifyProviderSessionId()` and is routed here; if it lands before the
  // tailer is up it's buffered and applied once the tailer exists.
  let scanner: SessionScanner | null = null;
  let bufferedSessionId: string | null = null;
  const routeProviderSessionId = (id: string): void => {
    if (scanner) void scanner.onNewSession(id);
    else bufferedSessionId = id;
  };

  // The tailer's turn-tracking state (created once the scanner is up, in
  // `run()` below) — hoisted here so `closeTurn()` on the returned handle can
  // reuse the SAME state `onMessage`'s `mapClaudeToEnvelopes` call mutates,
  // rather than tracking a second, parallel notion of "is a turn open".
  let mapperState: ClaudeEnvelopeMapperState | null = null;
  // Incremented by `onMessage` (in `run()` below) once per newly-processed
  // transcript entry — `closeTurn()`'s retry loop uses this, not
  // `currentTurnId`'s truthiness, to know when it's actually safe to close.
  // A tool-use turn opens (currentTurnId becomes non-null) at the FIRST
  // assistant entry, then stays open across several more disk writes (tool
  // result, final text) — "a turn is open" is true almost immediately and
  // says nothing about whether the turn has actually finished. "Flushing
  // found nothing new this pass" is the real signal that the transcript has
  // caught up with whatever prompted the `Stop` hook to fire.
  let entriesProcessedCount = 0;

  const controller = new InjectionController({
    writeText: (text) => ptyProcess?.write(text),
    submit: () => ptyProcess?.write(SUBMIT_KEY),
    onInjected: (id) => opts.onInjected?.(id),
    onDropped: (messages) => opts.onDroppedInjections?.(messages),
    submitDelayMs: deps.submitDelayMs,
    postSubmitCooldownMs: deps.postSubmitCooldownMs,
    setTimeoutImpl,
    clearTimeoutImpl,
    logger,
  });
  cleanups.push(() => {
    // Dropped (never-injected) messages are reported via the `onDropped`
    // callback wired above — the return value isn't needed here.
    controller.dispose();
  });

  // Debounced busy edge from the launcher's fetch-start/fetch-end signal —
  // structurally identical to `claudeLocal.ts`'s "thinking" tracking.
  const activeFetches = new Set<number>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeoutImpl(idleTimer);
      idleTimer = null;
    }
  };
  cleanups.push(clearIdleTimer);
  const onFetchEvent = (event: FetchSignalEvent): void => {
    if (event.type === "fetch-start") {
      activeFetches.add(event.id);
      clearIdleTimer();
      controller.setBusy(true);
    } else {
      activeFetches.delete(event.id);
      if (activeFetches.size === 0 && !idleTimer) {
        idleTimer = setTimeoutImpl(() => {
          idleTimer = null;
          if (activeFetches.size === 0) controller.setBusy(false);
        }, busyDebounceMs);
      }
    }
  };

  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const teardown = async (): Promise<void> => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        logger.debug("[pty-session] cleanup step failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const finish = (code: number): void => {
    if (settled) return;
    settled = true;
    void teardown().finally(() => resolveDone(code));
  };

  async function run(): Promise<void> {
    try {
      // Transcript tailer → structured envelopes for the web timeline. This is
      // the mirroring path, unchanged from the legacy local launcher (minus the
      // cross-mode dedupe, which had no purpose without a second producer). The
      // provider session id that drives `onNewSession` comes from the caller's
      // single shared hook server via `notifyProviderSessionId()`, not a
      // hook server owned here.
      // Captured in a non-null local for the `onMessage` closure below —
      // `mapperState` itself stays a mutable outer `let` (nullable until
      // `run()` reaches here) so `closeTurn()` on the returned handle can
      // reuse it too (see that field's own doc comment).
      const state = createClaudeEnvelopeMapperState();
      mapperState = state;
      const sessionScanner: SessionScanner = await createSessionScanner({
        sessionId: opts.providerSessionId,
        workingDirectory: opts.workingDirectory,
        onMessage: (raw) => {
          entriesProcessedCount++;
          if (raw.type === "summary") opts.onSummaryTitle?.(raw.summary);
          const envelopes = mapClaudeToEnvelopes(raw, state);
          if (envelopes.length > 0) opts.onEnvelopes(envelopes);
        },
        logger,
        env,
      });
      scanner = sessionScanner;
      cleanups.push(() => sessionScanner.cleanup());
      // A provider session id that arrived before the tailer was up is applied now.
      if (bufferedSessionId) {
        void sessionScanner.onNewSession(bufferedSessionId);
        bufferedSessionId = null;
      }

      // Unix-socket transport for the launcher's fetch-start/fetch-end signal
      // (no fd 3 under a PTY). Best-effort: on bind failure the idle edge is
      // simply never observed and injection falls back to the cooldown gate.
      const fetchSignal: FetchSignalServer = await createFetchSignalServer({
        homeDir: opts.homeDir,
        onEvent: onFetchEvent,
        logger,
      });
      cleanups.push(() => fetchSignal.close());

      // Resolve --resume/--continue/--session-id exactly like the legacy local
      // spawn, then build the hook-mode arg list.
      const { claudeArgs: resolvedArgs, startFrom } = resolveSessionFlags(
        {
          claudeArgs: opts.claudeArgs,
          sessionId: opts.providerSessionId,
          workingDirectory: opts.workingDirectory,
        },
        findLastSession,
        env,
        logger,
      );
      if (startFrom) {
        void sessionScanner.onNewSession(startFrom, { treatExistingAsProcessed: true });
      }

      const args: string[] = [];
      if (startFrom) args.push("--resume", startFrom);
      args.push("--append-system-prompt", systemPrompt);
      args.push(...resolvedArgs);
      // The single shared hook server's `--settings` file (SessionStart/
      // Notification/Stop/PreToolUse), owned by the caller's
      // `installRemotePermissionHook()` composition. Absent only when the hook
      // server failed to install (session then runs without hooks).
      if (opts.settingsPath) args.push("--settings", opts.settingsPath);

      const cols = stdout.columns ?? DEFAULT_COLS;
      const rows = stdout.rows ?? DEFAULT_ROWS;
      const spawnEnv: NodeJS.ProcessEnv = {
        ...env,
        ...(opts.settingsEnv ?? {}),
        KVY_CLAUDE_PATH: opts.claudeCliPath,
      };
      if (fetchSignal.path) spawnEnv.KVY_FETCH_SIGNAL_PATH = fetchSignal.path;

      logger.debug("[pty-session] spawning claude on PTY", {
        launcherPath: opts.launcherPath,
        args,
        cols,
        rows,
      });

      const child = spawnPty("node", [opts.launcherPath, ...args], {
        name: DEFAULT_PTY_NAME,
        cols,
        rows,
        cwd: opts.workingDirectory,
        env: spawnEnv,
      });
      ptyProcess = child;

      // PTY output → the real terminal.
      const dataSub = child.onData((data) => {
        stdout.write(data);
        if (awaitingModelSwitchConfirm) {
          modelSwitchConfirmBuffer = (modelSwitchConfirmBuffer + data).slice(
            -MODEL_SWITCH_CONFIRM_BUFFER_MAX,
          );
          if (MODEL_SWITCH_CONFIRM_PATTERN.test(modelSwitchConfirmBuffer)) {
            disarmModelSwitchConfirmWatcher();
            // "1" selects the dialog's first (and only affirmative) option
            // explicitly rather than relying on it staying the highlighted
            // default; the trailing Enter both submits that selection and,
            // on a menu style that auto-confirms on the digit alone, lands
            // harmlessly on the resulting idle empty prompt (confirmed live:
            // Enter on an empty prompt is a no-op, not a blank chat send).
            ptyProcess?.write("1");
            ptyProcess?.write(SUBMIT_KEY);
          }
        }
        if (modeStatusTarget) {
          modeStatusBuffer = (modeStatusBuffer + data).slice(-MODE_STATUS_BUFFER_MAX);
          const pattern = MODE_STATUS_PATTERNS[modeStatusTarget];
          if (pattern?.test(modeStatusBuffer)) finishModeStatusWatcher(true);
        }
      });
      cleanups.push(() => dataSub.dispose());

      // The real terminal's stdin → the PTY, byte-for-byte in raw mode so the
      // TUI is fully interactive (typing, slash commands, Ctrl-C, etc.).
      if (stdin.isTTY && stdin.setRawMode) {
        try {
          stdin.setRawMode(true);
        } catch (error) {
          logger.debug("[pty-session] setRawMode(true) failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // skipped entirely while a queued web message is itself mid-injection
      // (`controller.isInjecting`) — those synthetic keystrokes are not the
      // human at the keyboard.
      let draftIdleTimer: ReturnType<typeof setTimeout> | null = null;
      const onStdinData = (data: Buffer): void => {
        if (!controller.isInjecting) {
          if (data.includes(0x0d) || data.includes(0x0a) || data.includes(0x1b)) {
            // Enter / newline / Escape all end a draft-in-progress.
            controller.setLocalDraft(false);
            if (data.includes(0x0d) || data.includes(0x0a)) opts.onLocalSubmit?.();
          } else if (data.some((b) => b >= 0x20 || b === 0x08 || b === 0x7f)) {
            // A printable char (or backspace/DEL) means the human is composing
            // at the real prompt — hold injection until they submit, cancel,
            // or go quiet for DRAFT_IDLE_MS.
            controller.setLocalDraft(true);
            if (draftIdleTimer) clearTimeoutImpl(draftIdleTimer);
            draftIdleTimer = setTimeoutImpl(() => controller.setLocalDraft(false), DRAFT_IDLE_MS);
          }
        }
        ptyProcess?.write(data.toString("utf8"));
      };
      stdin.on("data", onStdinData);
      stdin.resume();
      cleanups.push(() => {
        stdin.removeListener("data", onStdinData);
        stdin.pause();
        if (stdin.isTTY && stdin.setRawMode) {
          try {
            stdin.setRawMode(false);
          } catch {
            // Best-effort restore only.
          }
        }
      });
      cleanups.push(() => {
        if (draftIdleTimer) clearTimeoutImpl(draftIdleTimer);
      });

      // Terminal resize → pty resize (Node emits 'resize' on stdout when the
      // controlling terminal changes size; the same event SIGWINCH drives).
      const onResize = (): void => {
        ptyProcess?.resize(stdout.columns ?? DEFAULT_COLS, stdout.rows ?? DEFAULT_ROWS);
      };
      stdout.on("resize", onResize);
      cleanups.push(() => stdout.removeListener("resize", onResize));

      // Let the TUI paint its prompt before the first web message is typed in.
      const readyTimer = setTimeoutImpl(() => controller.markReady(), readyDelayMs);
      cleanups.push(() => clearTimeoutImpl(readyTimer));

      const exitSub = child.onExit(({ exitCode }) => {
        logger.debug("[pty-session] claude exited", { exitCode });
        finish(exitCode);
      });
      cleanups.push(() => exitSub.dispose());
    } catch (error) {
      logger.error("[pty-session] setup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      finish(1);
    }
  }

  void run();

  return {
    done,
    injectMessage: (message) => controller.enqueue(message),
    notifyProviderSessionId: (id) => routeProviderSessionId(id),
    setPromptOpen: (open) => controller.setPromptOpen(open),
    sendInterrupt: () => {
      if (!ptyProcess) return false;
      ptyProcess.write("\u001b"); // ESC, the TUI's own cancel gesture
      return true;
    },
    sendModeCycle: (presses) => {
      if (!ptyProcess || presses <= 0) return false;
      // Same idle/no-prompt gate message injection uses — a mode-cycle
      // keystroke mid-turn or into an open dialog is exactly as unsafe as
      if (!controller.canInjectNow) return false;
      for (let i = 0; i < presses; i++) ptyProcess.write(SHIFT_TAB_KEY);
      return true;
    },
    waitForModeStatus: (target, timeoutMs) => {
      const pattern = MODE_STATUS_PATTERNS[target];
      // `bypassPermissions` (or any future mode Claude Code adds that this
      // build doesn't recognize) has no live-verified status text — see
      // `MODE_STATUS_PATTERNS`'s doc comment. Arming a watcher that could
      // never match would just burn the caller's full `timeoutMs` for
      // nothing, so fail fast instead.
      if (!pattern) return Promise.resolve(false);
      // At most one watcher in flight — settle any prior one as a plain
      // `false` (not a leaked promise) before arming the new one.
      finishModeStatusWatcher(false);
      return new Promise<boolean>((resolve) => {
        modeStatusTarget = target;
        modeStatusBuffer = "";
        modeStatusResolve = resolve;
        modeStatusTimer = setTimeoutImpl(() => finishModeStatusWatcher(false), timeoutMs);
      });
    },
    answerPermission: (decision, currentMode, toolName) => {
      if (!ptyProcess) return false;
      if (decision.kind === "deny") {
        ptyProcess.write("\u001b"); // ESC — the dialog's own "Esc to cancel" gesture
        return true;
      }
      if (isExitPlanTool(toolName)) {
        // ExitPlanMode's own dialog offers only two affirmative options —
        // no general mode picker — and their digits mean the OPPOSITE of a
        // plain permission dialog's: "1" is a mode switch, "2" is the plain
        // approve. See this method's doc for the live-verified mapping.
        if (decision.kind === "allow" && decision.scope === "session") {
          ptyProcess.write("1"); // "Yes, auto-accept edits"
          ptyProcess.write(SUBMIT_KEY);
          return true;
        }
        if (decision.kind === "allow" && decision.scope === "once") {
          ptyProcess.write("2"); // "Yes, manually approve edits"
          ptyProcess.write(SUBMIT_KEY);
          return true;
        }
        return false; // a `mode` decision has no reachable option here
      }
      const targetMode =
        decision.kind === "mode"
          ? decision.mode
          : decision.kind === "allow" && decision.scope === "session"
            ? "acceptEdits"
            : null;
      if (targetMode) {
        const presses = permissionModeCyclePresses(currentMode ?? "default", targetMode);
        for (let i = 0; i < presses; i++) ptyProcess.write(SHIFT_TAB_KEY);
        ptyProcess.write(SUBMIT_KEY);
        return true;
      }
      // allow, scope "once" — the dialog's first, most conservative option.
      ptyProcess.write("1");
      ptyProcess.write(SUBMIT_KEY);
      return true;
    },
    answerAskUserQuestion: (decision, questions) => {
      if (!ptyProcess) return false;
      if (decision.kind === "deny") {
        ptyProcess.write(""); // ESC — this widget's own "Esc to cancel" gesture
        return true;
      }
      if (decision.kind !== "allow") return false; // a mode decision doesn't apply to a question
      const answers = extractQuestionAnswers(decision.updatedInput);
      if (!answers) return false;
      const keystrokes = planAskUserQuestionKeystrokes(questions, answers);
      if (!keystrokes) return false; // no answer for some question — nothing safe to drive
      writeKeystrokesPaced(ptyProcess, keystrokes, ASK_QUESTION_KEYSTROKE_DELAY_MS, setTimeoutImpl);
      return true;
    },
    sendModelChange: (model) => {
      if (!ptyProcess) return false;
      // Same idle/no-prompt gate message injection uses — checked BEFORE
      // enqueueing (not just relying on `enqueue`'s own internal gate) so
      // this call is synchronously honest about whether the command will
      // actually go in now, rather than silently queuing for later.
      if (!controller.canInjectNow) return false;
      // Enqueue first so the (synchronous) text write always precedes the
      // confirm watcher's own arm-expiry timer in scheduling order — the
      // watcher only ever needs to observe PTY output that arrives strictly
      // after this call returns, never before.
      controller.enqueue({ id: createId(), text: `/model ${model}` });
      armModelSwitchConfirmWatcher();
      return true;
    },
    closeTurn: async (status) => {
      let consecutiveQuietFlushes = 0;
      for (let attempt = 0; attempt < CLOSE_TURN_MAX_ATTEMPTS; attempt++) {
        const before = entriesProcessedCount;
        await scanner?.flush();
        if (entriesProcessedCount === before) {
          consecutiveQuietFlushes++;
          if (consecutiveQuietFlushes >= CLOSE_TURN_QUIET_FLUSHES_REQUIRED) break;
        } else {
          consecutiveQuietFlushes = 0;
        }
        if (attempt < CLOSE_TURN_MAX_ATTEMPTS - 1) {
          await new Promise<void>((resolve) => setTimeoutImpl(resolve, CLOSE_TURN_RETRY_DELAY_MS));
        }
      }
      if (!mapperState) return;
      const envelopes = closeClaudeTurnWithStatus(mapperState, status);
      if (envelopes.length > 0) opts.onEnvelopes(envelopes);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        ptyProcess?.kill();
      } catch (error) {
        logger.debug("[pty-session] kill failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
