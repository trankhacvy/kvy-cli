/**
 * Remote permission answering for the LIVE Claude Code TUI, via the
 *
 * ## The problem this solves
 * In the new `kvy claude` model the real `claude` TUI stays live at the
 * terminal and web-sent messages are injected into it (PTY-injection input
 * path — a separate concern, built elsewhere). When a web-injected message
 * makes Claude want to run a tool that needs approval, the permission prompt
 * appears in the *terminal* TUI — which a remote web user can't answer.
 *
 * Claude Code's hooks run a command around tool execution and their stdout
 * JSON can approve/deny/defer the call. This bridge is the decision-routing
 * core behind both hooks: it takes the hook's tool payload, runs it through
 * Kvy's EXISTING permission pipeline (a `perm-request` envelope for the
 * web PermCard, the first-wins `perm.answer` RPC, a `perm-resolve`
 * envelope), and translates the answer back into each hook's own output
 * contract — all while the TUI stays live and normal.
 *
 * ## The `PreToolUse` contract (verified against Claude Code 2.1.212)
 * Input (stdin JSON): `{ session_id, tool_name, tool_input, permission_mode,
 * hook_event_name: "PreToolUse", cwd, transcript_path }`.
 * Output (stdout JSON):
 * ```json
 * { "hookSpecificOutput": {
 *     "hookEventName": "PreToolUse",
 *     "permissionDecision": "allow" | "deny" | "ask",
 *     "permissionDecisionReason": "..." } }
 * ```
 *  - `allow` → the tool runs, bypassing the normal permission prompt.
 *  - `deny`  → the tool is blocked; the reason is shown to Claude.
 *  - `ask`   → Claude Code shows its normal TUI permission prompt (the same
 *    thing that happens when a hook returns nothing / exits 0 empty).
 * (The top-level `decision: "approve"|"block"` form is deprecated for
 * PreToolUse — Claude's own docs say "use hookSpecificOutput.permissionDecision
 * instead", so this bridge only emits the new form.)
 *
 * ## The `PermissionRequest` contract (verified against Claude Code 2.1.214,
 * Fires only when a permission dialog would actually be shown — auto-allowed
 * tools (settings/allowlist/mode) never reach it. Input (stdin JSON):
 * `{ session_id, tool_name, tool_input, permission_mode, hook_event_name:
 * "PermissionRequest", cwd, transcript_path, prompt_id,
 * permission_suggestions }`. Output (stdout JSON):
 * ```json
 * { "hookSpecificOutput": {
 *     "hookEventName": "PermissionRequest",
 *     "decision": { "behavior": "allow" | "deny", "message": "..." } } }
 * ```
 * Returning `undefined` (→ the hook server's 204) means "no decision" — the
 * forwarder writes nothing and Claude Code's normal TUI dialog renders.
 *
 * "kill the web-turn permission flood")
 * An earlier version of this bridge routed EVERY `PreToolUse` call of a
 * web-initiated turn to the web — Read/Grep/Glob included, one web message
 * → a wall of PermCards. `PermissionRequest` (verified against our installed
 * Claude Code's own settings/allowlist/mode evaluation and would genuinely
 * show a dialog — auto-allowed tools never reach it. So responsibilities
 * split across the two hooks:
 *  - `PreToolUse` ({@link handlePreToolUse}) always defers with `ask` —
 *    Claude Code's own permission engine decides from there, exactly like a
 *    local turn — EXCEPT for `AskUserQuestion` ({@link handleAskUserQuestion},
 *    `PreToolUse` happens *before* Claude Code ever runs the tool, so a web
 *    answer never renders the question widget at all — see "AskUserQuestion
 *    deny-with-answer" below.
 *  - `PermissionRequest` ({@link handlePermissionRequest}) is where the
 *    web-vs-terminal fork now lives for every OTHER tool: a local turn gets
 *    `undefined` (no decision → Claude Code's normal TUI dialog renders
 *    untouched); a web turn runs through the same perm-request/perm-resolve
 *    pipeline as before.
 * This makes the web see *exactly* the prompts a terminal user would see —
 * no more, no less.
 *
 * ## Local turns are visible on web too (docs/known-issues.md issue #5 fix)
 * The web-vs-local fork inside {@link handlePermissionRequest} and {@link
 * handleAskUserQuestion} used to gate the `perm-request` EMISSION itself: a
 * locally-typed turn (`!isWebTurnActive()`) returned before ever creating a
 * `reqId` or emitting anything, so a web viewer watching that same session
 * saw a bare "Running" tool card with no buttons until the terminal human
 * finished answering — yet `onPendingAttention` still fired a push
 * notification unconditionally, so a push could arrive pointing at a dead
 * end. The fork now only decides whether the hook itself BLOCKS waiting for
 * an answer, not whether web finds out a decision is pending at all:
 *  - A web turn still blocks (as before) until {@link resolve}, the answer
 *    timeout, or {@link reset} settles it.
 *  - A local turn ALWAYS emits its `perm-request` too (so web always shows a
 *    live card, regardless of who started the turn) but still hands off to
 *    the terminal immediately — `undefined` / `output("ask", ...)` — with
 *    zero added latency, so the real TUI dialog/widget renders exactly as
 *    fast as it does today. This `perm-request` carries `answerable: false`
 *    (see the wire schema) so the web card renders read-only — the terminal,
 *    not a web click, is what actually drives the outcome, and offering
 *    interactive buttons that can't do anything would just be a false
 *    affordance. The request is tracked in {@link localOutcomePending} (NOT
 *    the blocking `pending`/`permRequestPending` maps — there is no promise
 *    left open to settle) instead, and {@link resolveLocalOutcome} — fed
 *    from `start.ts`'s transcript tailer, which already observes the tool's
 *    own `tool-start`/`tool-end` pair the moment the terminal human answers
 *    (Claude Code records a `tool_result` for a permission-gated call either
 *    way, allowed or denied — see this header's `PreToolUse` contract) —
 *    completes it and emits the matching `perm-resolve` the instant the real
 *    outcome is known, so the web card resolves instead of hanging forever. A
 *    web `perm.answer` call racing in for one of these reqIds (e.g. an older
 *    web build that doesn't yet honor `answerable`) gets an honest
 *    `{ok:false, reason:"local-turn"}` (see {@link resolve}) — nothing was
 *    "already answered", this bridge just has no channel to make a web click
 *    actually drive the live terminal dialog without also keystroke-injecting
 *    it (docs/known-issues.md issue #5's stretch goal — real PTY-based racing
 *    — is intentionally not implemented here).
 *
 * probe — **PASS**, 2026-07-18, claude 2.1.214)
 * `AskUserQuestion` can't go through `PermissionRequest` like a normal
 * prompt: there is no output channel there for the actual answer text, only
 * allow/deny. Instead, {@link handleAskUserQuestion} intercepts it at
 * `PreToolUse` (before Claude Code decides whether to show its own dialog)
 * and, on a web turn, denies the call with a reason string formatted exactly
 * like Claude Code's own native multiple-choice answer output
 * ({@link composeAskAnswerReason}). The probe confirmed the model reads that
 * denial as "the user already answered" and proceeds with the same turn —
 * the question widget never renders, and no re-ask happens. A local turn
 * (or a web turn that times out) instead gets `ask`/a plain-text fallback
 * reason ({@link ASK_FALLBACK_REASON}) instructing the model to ask again as
 * ordinary chat text, which the composer can answer like any other message.
 *
 * A live probe showed the model working around a `PreToolUse`/
 * `PermissionRequest` deny by retrying the same effect through an
 * allowlisted tool (e.g. an allowlisted `Bash` to create a file after a
 * denied `Write`). Every deny message this bridge produces — default or
 * web-supplied — is therefore run through {@link appendDenyGuard}, which
 * appends "Do not attempt this action another way." so the model reads it
 * as a hard stop rather than a suggestion to route around.
 *
 * ## Timeout / fallback
 * A blocked `PreToolUse` hook holds up the tool, and Claude Code enforces its
 * own per-hook timeout (after which it reports "hook did not respond" and
 * does NOT run the tool). So this bridge waits for a web answer only up to
 * `answerTimeoutMs` (default {@link DEFAULT_ANSWER_TIMEOUT_MS}, deliberately
 * below the hook command's own {@link HOOK_COMMAND_TIMEOUT_SECONDS}), and on
 * expiry resolves the request as a **deny** with an explicit "timed out"
 * message — a safe, consistent outcome (tool blocked, PermCard resolved,
 * timeline honest) rather than letting Claude's own timeout fire a confusing
 * server-side push pipeline and is driven by the `perm-request` envelope this
 * bridge emits, so no re-notification logic is duplicated here.
 *
 * What is intentionally reused from `acp/acpPermissionHandler.ts` (the ACP
 * remote-mode handler): the `AgentStateSnapshot`/`AgentStateRequest` shapes,
 * the `PermAnswerResult` first-wins contract, and the exact
 * `perm-request`/`perm-resolve` envelope emission. The mapping target
 * differs (a `PreToolUse` `permissionDecision` string vs. ACP's option-id
 * response), so the two handlers are parallel rather than one reused class.
 *
 * Both hooks' input carries `permission_mode` — the live TUI's own,
 * authoritative idea of its current mode — on every call. {@link
 * cachePermissionMode} records the latest value ({@link
 * currentPermissionMode}) so `start.ts`'s PTY `setMode` RPC handler can
 * compute a Shift+Tab press count via {@link permissionModeCyclePresses}
 * around the fixed {@link PERMISSION_MODE_CYCLE} instead of guessing at the
 * live TUI's state blind. After sending that keystroke cycle (gated
 * idle+no-prompt, same rule as message injection — `ptyClaudeSession.ts`'s
 * `sendModeCycle`), the RPC handler awaits {@link waitForModeEcho} to
 * confirm the switch actually landed before reporting success back to the
 * web — this bridge has no other channel to ask the live TUI "did that
 * work", so the next hook input's own `permission_mode` IS the verification.
 */

import {
  createEnvelope,
  type PermDecision,
  type PermissionMode,
  type SessionEnvelope,
} from "@kvy/wire";
import { createId } from "@paralleldrive/cuid2";
import type {
  AgentStateCompletedRequest,
  AgentStateRequest,
  AgentStateSnapshot,
  PermAnswerResult,
} from "../acp/acpPermissionHandler.js";
import type { Logger } from "../logger.js";

/** The three `permissionDecision` values Claude Code's `PreToolUse` hook accepts. */
export type PreToolPermissionDecision = "allow" | "deny" | "ask";

/** True for either of Claude Code's two `AskUserQuestion` tool-name spellings
 * (the SDK/hook payload has used both across versions). */
export const isAskUserQuestion = (name: string): boolean =>
  name === "AskUserQuestion" || name === "ask_user_question";

/** True for either of Claude Code's two `ExitPlanMode` tool-name spellings
export const isExitPlanTool = (name: string): boolean =>
  name === "ExitPlanMode" || name === "exit_plan_mode";

/** One option Claude Code's `AskUserQuestion` tool offers — either a bare
 * string or `{label, description?}`, per the tool's own input schema. */
export type AskQuestionOption = { label: string; description?: string } | string;

/** One entry of the `AskUserQuestion` tool's `questions` array. */
export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskQuestionOption[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Composes the `PreToolUse` deny reason in Claude Code's own native answer
 * format (`- {question}\n  → {labels}`) so the model reads it exactly like a
 * real `AskUserQuestion` result (format verified by the W0.2 live probe,
 * which itself mimics Claude Code's own).
 */
export function composeAskAnswerReason(
  questions: AskQuestion[],
  answers: Record<string, string>,
): string {
  const lines = questions.map(
    (q) => `- ${q.question}\n  → ${answers[q.question] ?? "(no answer)"}`,
  );
  return [
    "The user answered via the Kvy web UI:",
    ...lines,
    "Proceed using these answers. Do not call AskUserQuestion again for these questions.",
  ].join("\n");
}

/**
 * The `PreToolUse` deny reason used both when a web turn's answer times out
 * and when a web-supplied decision doesn't carry a usable answer shape
 * (degraded mode — also the primary path if the W0.2 probe had failed).
 * Deliberately NOT run through {@link appendDenyGuard}: this message already
 * tells the model exactly what to do next (ask again in plain text, then
 * stop and wait), so appending the generic anti-workaround sentence would
 * only muddy that instruction.
 */
export const ASK_FALLBACK_REASON =
  "The remote user did not answer the structured question form. Ask the same question(s) again in PLAIN TEXT in your reply (no AskUserQuestion tool), then end your turn and wait for the user's typed answer.";

/**
 * Claude Code's `PreToolUse` hook stdin payload (verified against 2.1.212).
 * Only `tool_name`/`tool_input` are load-bearing here; everything else is
 * accepted and ignored so a Claude Code version that adds fields never
 * breaks this.
 */
export interface PreToolUseHookInput {
  session_id?: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  permission_mode?: string;
  [key: string]: unknown;
}

/** The `PreToolUse` hook stdout JSON this bridge emits. */
export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: PreToolPermissionDecision;
    permissionDecisionReason?: string;
  };
  /** Keep the hook's own stdout out of the Claude Code transcript UI. */
  suppressOutput: true;
}

/**
 * Claude Code's `PermissionRequest` hook stdin payload (verified against
 * here; everything else (`permission_suggestions` included) is accepted and
 * ignored so a Claude Code version that adds fields never breaks this.
 */
export interface PermissionRequestHookInput {
  session_id?: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  /** Present per the header doc's verified `PermissionRequest` contract;
   * W4.3) — a `PermissionRequest` fires strictly more often than a mode
   * switch, so it's as good an echo source as `PreToolUse`. */
  permission_mode?: string;
  [key: string]: unknown;
}

/**
 * The `PermissionRequest` hook stdout JSON this bridge emits for a web turn.
 * `undefined` (handled by the hook server as a 204) is the local-turn escape
 * hatch — "no decision, let the TUI dialog render."
 */
export interface PermissionRequestHookOutput {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest";
    decision?: { behavior: "allow" | "deny"; message?: string };
  };
}

/**
 * Default max wait for a web answer. Kept below the hook command's own
 * timeout ({@link HOOK_COMMAND_TIMEOUT_SECONDS}) so the bridge resolves the
 * request itself (as a clean deny) before Claude Code fires its "hook did not
 * respond" path.
 */
export const DEFAULT_ANSWER_TIMEOUT_MS = 570_000;

/**
 * The `timeout` (seconds) written into the generated `PreToolUse` hook
 * command config — the outer bound Claude Code will wait for the hook. Must
 * stay comfortably above {@link DEFAULT_ANSWER_TIMEOUT_MS} / 1000 so the
 * bridge's own timeout always wins.
 */
export const HOOK_COMMAND_TIMEOUT_SECONDS = 600;

const ALL_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];
/** `ExitPlanMode` can't reasonably offer "switch to plan mode" as a way to resolve itself. */
const EXIT_PLAN_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];

function availableModes(toolName: string): PermissionMode[] {
  return [...(isExitPlanTool(toolName) ? EXIT_PLAN_MODES : ALL_MODES)];
}

/**
 * The fixed order Claude Code's own Shift+Tab keystroke cycles permission
 * four states {@link ALL_MODES} already enumerates, exported under its own
 * name here because the PTY keystroke feature's identity as "a fixed 4-state
 * implementation detail of the permission pipeline.
 */
export const PERMISSION_MODE_CYCLE: readonly PermissionMode[] = ALL_MODES;

/**
 * Number of forward Shift+Tab presses to get from `from` to `to` around
 * {@link PERMISSION_MODE_CYCLE} (there is no reverse keystroke). `0` when
 * already there. Exported so the PTY session/`start.ts` can compute the
 * keystroke count without duplicating the cycle order.
 */
export function permissionModeCyclePresses(from: PermissionMode, to: PermissionMode): number {
  const fromIndex = PERMISSION_MODE_CYCLE.indexOf(from);
  const toIndex = PERMISSION_MODE_CYCLE.indexOf(to);
  if (fromIndex === -1 || toIndex === -1) return 0;
  return (toIndex - fromIndex + PERMISSION_MODE_CYCLE.length) % PERMISSION_MODE_CYCLE.length;
}

/** Minimal timer seam so tests can drive the timeout deterministically. */
export interface CancelableTimer {
  clear: () => void;
}

export interface PreToolPermissionBridgeDeps {
  emitEnvelope: (envelope: SessionEnvelope) => void;
  /**
   * True when the currently-running Claude turn was initiated by a
   * web-injected message (so the human is remote and needs the PermCard).
   * False for a locally-typed turn — see the "Two hooks, one responsibility
   * split" section above.
   */
  isWebTurnActive: () => boolean;
  /** Fires with the full requests/completedRequests snapshot on every change. */
  onAgentStateChange?: (snapshot: AgentStateSnapshot) => void;
  /**
   * Fires when a `perm.answer` decision is a `{kind:'mode'}` switch. The
   * live TUI's own mode isn't changed by a hook here — the caller owns any
   * best-effort sync (e.g. via the PTY input path); this bridge stays
   * transport-neutral and simply allows the pending call under the new mode.
   */
  onModeChange?: (mode: PermissionMode) => void;
  /**
   * Fires on the local-turn path of either hook — `handlePreToolUse` always
   * defers to `ask`, and on a local turn that genuinely means "Claude Code's
   * own TUI dialog may render next"; `handlePermissionRequest`'s local-
   * `undefined` return means the same thing, more precisely (only calls that
   * survive Claude Code's own auto-allow evaluation reach it). The caller
   * W1.3) so a queued web message is never typed into an open dialog. Never
   * fires on a web turn — those prompts resolve remotely with no local
   * dialog rendered.
   */
  onPromptLikely?: () => void;
  /**
   * Fires the instant a permission request or `AskUserQuestion` becomes
   * pending — at the TOP of {@link handlePermissionRequest} /
   * {@link handleAskUserQuestion}, before either branch decides local vs.
   * web (docs/user-flows.md fix-plan task 4). Unlike {@link emitEnvelope}'s
   * `perm-request` (which stays local-turn-honest — a locally-typed
   * permission request must never show a PermCard on web), this fires on
   * BOTH local and web turns: it's an additive push-notification side
   * signal, not a routing decision, and the server's own presence
   * suppression already avoids over-notifying an actively-watching tab.
   */
  onPendingAttention?: (kind: "perm" | "question") => void;
  /**
   * Attempts to actually drive a locally-typed turn's live TUI dialog from a
   * web `perm.answer` decision, by writing the matching keystrokes into the
   * PTY (`ptyClaudeSession.ts`'s `answerPermission`) — real two-way remote
   * control, not just a read-only mirror. Called only for a `drivable`
   * {@link localOutcomePending} entry (an ordinary permission/`ExitPlanMode`
   * prompt — never `AskUserQuestion`'s own widget, which uses {@link
   * driveLocalQuestion} instead). Returns `false` (nothing written) when
   * there's no live PTY to drive — `resolve()` falls back to the honest
   * `{ok:false, reason:"local-turn"}` in that case. Undefined entirely means
   * the caller hasn't wired real terminal-driving (e.g. tests, or a future
   * transport with no PTY at all) — same fallback. `toolName` is passed
   * through so the driver can special-case `ExitPlanMode`'s dialog, whose
   * option digits mean something different from every other permission
   * dialog's ({@link isExitPlanTool}; `ptyClaudeSession.ts`'s
   * `answerPermission` doc has the live-verified keystroke mapping).
   */
  driveLocalDialog?: (decision: PermDecision, toolName: string) => boolean;
  /**
   * Same as {@link driveLocalDialog}, but for a locally-typed turn's
   * `AskUserQuestion` widget (`ptyClaudeSession.ts`'s
   * `answerAskUserQuestion`) — a distinct keystroke model (per-question
   * tabs, digit-select, Right-arrow between tabs) that only ever applies
   * when every question's answer matches a listed option; a free-text
   * answer returns `false` without writing anything (live-verified: driving
   * that path wrong silently declines the whole form) and `resolve()` falls
   * back to the honest local-turn reason.
   */
  driveLocalQuestion?: (decision: PermDecision, questions: AskQuestion[]) => boolean;
  /** Max wait for a web answer before falling back to a deny. Default {@link DEFAULT_ANSWER_TIMEOUT_MS}. */
  answerTimeoutMs?: number;
  /** Injectable timer (default `setTimeout`) so tests can trigger the timeout on demand. */
  setTimer?: (callback: () => void, ms: number) => CancelableTimer;
  /**
   * The mode the session actually launched in (docs/bug-fix-plan.md issue #5's
   * known gap) — the caller's best knowledge of "what mode is this *before*
   * any hook has ever fired", e.g. `extractPermissionModeFlag`'s read of a
   * `--permission-mode` passthrough flag, falling back to `"default"`.
   * Seeds {@link currentPermissionMode} so the very first hook echo has a
   * real baseline to compare against — without this, a mode switched via
   * Shift+Tab *before* the first tool call looks identical to "no transition
   * happened" (the bridge only sees the already-switched mode, with nothing
   * to diff it against), and the web mode chip silently never catches up
   * until an unrelated second switch. Defaults to `"default"`, matching
   * Claude Code's own default when the caller has no better information.
   */
  initialPermissionMode?: PermissionMode;
  logger?: Logger;
}

/**
 * A `PreToolUse`-style pending entry. Its only occupant is
 * {@link PreToolPermissionBridge.handleAskUserQuestion}'s web-turn path
 * (`handlePreToolUse` itself always resolves every other tool immediately
 * with `ask` — see that method's doc). `isQuestion`/`questions` carry enough
 * of the original `AskUserQuestion` call for {@link
 * PreToolPermissionBridge.mapDecision} to compose the deny-with-answer
 * reason once a web decision arrives.
 */
interface PendingPreToolRequest {
  settle: (output: PreToolUseHookOutput) => void;
  toolName: string;
  input: Record<string, unknown>;
  timer: CancelableTimer;
  isQuestion?: boolean;
  /** The original `questions` array — kept for {@link composeAskAnswerReason}. */
  questions?: AskQuestion[];
}

/** A pending `PermissionRequest` — settled with a `PermDecision` that {@link
 * handlePermissionRequest}'s own closure translates into the hook's output shape. */
interface PendingPermissionRequest {
  settle: (decision: PermDecision) => void;
  toolName: string;
  input: Record<string, unknown>;
  timer: CancelableTimer;
}

function defaultSetTimer(callback: () => void, ms: number): CancelableTimer {
  const handle = setTimeout(callback, ms);
  // Don't keep the event loop alive purely for a pending permission timeout.
  handle.unref?.();
  return { clear: () => clearTimeout(handle) };
}

function output(decision: PreToolPermissionDecision, reason: string): PreToolUseHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
    suppressOutput: true,
  };
}

/**
 * Appends the anti-workaround instruction every deny message must carry
 * denied `Write` via an allowlisted `Bash` instead of treating the deny as
 * final). Applied exactly once, at the point each deny message is authored.
 */
function appendDenyGuard(message: string): string {
  return `${message} Do not attempt this action another way.`;
}

/**
 * Decision-routing core for the `PreToolUse`/`PermissionRequest`
 * remote-permission hooks. Wire {@link handlePreToolUse} into the loopback
 * hook server's `onPreToolUse` callback, {@link handlePermissionRequest} into
 * `onPermissionRequest`, and {@link resolve} into the `perm.answer` session RPC.
 */
export class PreToolPermissionBridge {
  // Populated only by {@link handleAskUserQuestion}'s web-turn path — see
  private readonly pending = new Map<string, PendingPreToolRequest>();
  private readonly permRequestPending = new Map<string, PendingPermissionRequest>();
  // A local turn's `perm-request` (docs/known-issues.md issue #5 fix, see the
  // class-level doc's "Local turns are visible on web too" section) — no
  // blocking promise to settle, so these live in their own FIFO-by-tool-name
  // queue rather than `pending`/`permRequestPending`. Populated by both
  // {@link handlePermissionRequest} and {@link handleAskUserQuestion}'s
  // local-turn branches, drained by {@link resolveLocalOutcome}.
  private readonly localOutcomePending: {
    reqId: string;
    toolName: string;
    /** True for an ordinary permission/`ExitPlanMode` prompt {@link resolve}
     * may attempt to drive via {@link PreToolPermissionBridgeDeps.driveLocalDialog}.
     * Irrelevant when {@link questions} is set — that case always routes
     * through {@link PreToolPermissionBridgeDeps.driveLocalQuestion} instead. */
    drivable: boolean;
    /** Set only for an `AskUserQuestion` entry — the original parsed
     * questions, needed by {@link PreToolPermissionBridgeDeps.driveLocalQuestion}
     * to map a web decision's answer strings back to option indices. */
    questions?: AskQuestion[];
  }[] = [];
  /** `reqId`s of {@link localOutcomePending} entries a web decision has
   * already driven into the live PTY — a second `resolve()` call for the
   * same reqId must not replay the keystrokes (e.g. a double-click). */
  private readonly drivenLocalReqIds = new Set<string>();
  private requests: Record<string, AgentStateRequest> = {};
  private completedRequests: Record<string, AgentStateCompletedRequest> = {};
  private readonly answerTimeoutMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => CancelableTimer;
  // The last `permission_mode` seen on ANY hook input — `PreToolUse` and
  // is the PTY `setMode` RPC's only source of truth for "what mode is the
  // live TUI actually in right now" (there is no other channel to ask it),
  // and the verification target for {@link waitForModeEcho} after sending a
  // Shift+Tab cycle.
  private lastPermissionMode: PermissionMode | null;
  private readonly modeWatchers = new Set<(mode: PermissionMode) => void>();

  constructor(private readonly deps: PreToolPermissionBridgeDeps) {
    this.answerTimeoutMs = deps.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
    this.setTimer = deps.setTimer ?? defaultSetTimer;
    // `null` (not seeded) preserves the pre-existing behavior for any caller
    // that doesn't pass this — the first hook echo is treated as "no prior
    // state", same as before docs/bug-fix-plan.md issue #5's fix.
    this.lastPermissionMode = deps.initialPermissionMode ?? null;
  }

  /** The last observed `permission_mode`, the seeded
   * {@link PreToolPermissionBridgeDeps.initialPermissionMode} before any hook
   * has fired, or `null` if neither is available. */
  get currentPermissionMode(): PermissionMode | null {
    return this.lastPermissionMode;
  }

  /**
   * Caches `permission_mode` off any hook input and notifies pending
   * {@link waitForModeEcho} callers. An unrecognized value (a future Claude
   * Code build renaming/adding modes) is ignored rather than corrupting the
   * cache with something {@link permissionModeCyclePresses} can't index.
   *
   * Also emits a `permission-mode` wire event whenever the observed mode is a
   * genuine transition from the previously-cached one (docs/bug-fix-plan.md
   * but nothing previously surfaced, reaches the web mode chip without a
   * round-trip through a permission decision. With `lastPermissionMode`
   * seeded from {@link PreToolPermissionBridgeDeps.initialPermissionMode}
   * (falling back to `null` when the caller doesn't provide one), the very
   * first hook call *can* now emit — if the caller told us the session
   * launched in `"default"` and the first hook echoes `"plan"` (a Shift+Tab
   * before ever using a tool), that's a real transition worth surfacing, not
   * an echo of current state. Only when `lastPermissionMode` is still `null`
   * (no seed given) does the first observed mode stay silent — there's
   * nothing to diff it against, and the web's `"default"` fallback
   * (`deriveCurrentPermissionMode`) is exactly right until a real transition
   * happens.
   */
  /**
   * Publicly feeds an externally-confirmed mode into the same
   * cache/watcher/emit pipeline {@link cachePermissionMode} drives off a
   * hook input's own `permission_mode` field — used by `setMode`'s raw-PTY-
   * output confirmation path (`ptyClaudeSession.ts`'s `waitForModeStatus`),
   * which can confirm a switch WITHOUT any hook call ever occurring (the
   * whole point of that fix: an idle session may never get a hook call at
   * all). Without this, {@link currentPermissionMode} — read by `start.ts`'s
   * `setMode` handler to compute the NEXT switch's own Shift+Tab press count
   * — stays stale after a raw-output-only-confirmed switch, so a second
   * switch typed right after the first (no intervening tool call) computes
   * its press count from the wrong starting mode and lands on the wrong
   * target. Live-reproduced: Default→Plan (raw-output-confirmed, no hook
   * call) followed immediately by Plan→AcceptEdits computed its press count
   * from a still-`"default"` cache and landed back on `"default"` instead.
   */
  notePermissionMode(mode: PermissionMode): void {
    this.cachePermissionMode(mode);
  }

  private cachePermissionMode(raw: string | undefined): void {
    if (raw === undefined) return;
    const mode = PERMISSION_MODE_CYCLE.find((m) => m === raw);
    if (!mode) return;
    if (this.lastPermissionMode !== null && mode !== this.lastPermissionMode) {
      this.deps.emitEnvelope(
        createEnvelope("agent", { t: "permission-mode", mode, source: "terminal" }),
      );
    }
    this.lastPermissionMode = mode;
    for (const watcher of [...this.modeWatchers]) watcher(mode);
  }

  /**
   * Resolves with the `permission_mode` observed on the NEXT hook input
   * (whichever mode that turns out to be — the caller compares it to what it
   * expected), or `null` if none arrives within `timeoutMs`. This is the
   * bridge can't reach into the live TUI to ask its mode directly, so
   * confirmation is "did the next thing Claude Code told us agree with what
   * we expect".
   */
  waitForModeEcho(timeoutMs: number): Promise<PermissionMode | null> {
    return new Promise((resolve) => {
      let settled = false;
      const watcher = (mode: PermissionMode): void => {
        if (settled) return;
        settled = true;
        this.modeWatchers.delete(watcher);
        timer.clear();
        resolve(mode);
      };
      const timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        this.modeWatchers.delete(watcher);
        resolve(null);
      }, timeoutMs);
      this.modeWatchers.add(watcher);
    });
  }

  /** Number of unanswered requests across both hook types, including local
   * turns awaiting a {@link resolveLocalOutcome} correlation —
   * introspection/tests. */
  get pendingCount(): number {
    return this.pending.size + this.permRequestPending.size + this.localOutcomePending.length;
  }

  /**
   * The `PreToolUse` hook handler. Defers with `ask` for every tool — Claude
   * Code's own permission engine decides from there (auto-allow, or a
   * genuine prompt that fires `PermissionRequest`, where the web-vs-terminal
   * fork now lives; see {@link handlePermissionRequest}) — EXCEPT
   * `AskUserQuestion`, which {@link handleAskUserQuestion} intercepts here
   * deny-with-answer" doc for why this can't wait for `PermissionRequest`).
   */
  handlePreToolUse(input: PreToolUseHookInput): Promise<PreToolUseHookOutput> {
    this.cachePermissionMode(input.permission_mode);
    if (isAskUserQuestion(input.tool_name)) return this.handleAskUserQuestion(input);

    // A web turn's `ask` here doesn't mean a local dialog is coming — the
    // `PermissionRequest` hook that follows resolves it remotely with no
    // TUI dialog ever rendered. Only signal "a dialog may be about to show"
    // on the local-turn path.
    if (!this.deps.isWebTurnActive()) this.deps.onPromptLikely?.();
    return Promise.resolve(output("ask", "Deferred to Claude Code's own permission engine."));
  }

  /**
   * Always emits a `perm-request` (`modes: []` — a question offers no mode
   * switches; docs/known-issues.md issue #5 — web must see this pending too,
   * regardless of who's driving the turn). A local turn then defers to `ask`
   * — the terminal TUI's own question widget renders there, answered by the
   * human at the keyboard, and the tailer mirrors question+answer as an
   * ordinary tool-start/tool-end pair (a read-only card — no interception
   * needed, so unlike {@link handlePermissionRequest}'s local path this
   * doesn't even need `undefined`; `ask` is Claude Code's own "run the tool"
   * signal) — tracked in {@link localOutcomePending} so {@link
   * resolveLocalOutcome} can complete it once that mirrored tool-end arrives.
   * A web turn instead blocks for an answer, exactly like {@link
   * handlePermissionRequest}, but settles through {@link mapDecision}'s
   * question branch instead of the generic allow/deny/mode mapping.
   */
  private handleAskUserQuestion(input: PreToolUseHookInput): Promise<PreToolUseHookOutput> {
    // Fires regardless of local vs. web — see `onPendingAttention`'s own doc.
    this.deps.onPendingAttention?.("question");

    const toolInput = input.tool_input ?? {};
    const questions = (toolInput.questions ?? []) as AskQuestion[];
    const reqId = createId();

    // Emitted unconditionally (docs/known-issues.md issue #5 fix — see the
    // class-level "Local turns are visible on web too" doc) so web always
    // sees the pending question, regardless of who's driving this turn.
    this.requests[reqId] = { tool: input.tool_name, arguments: toolInput, createdAt: Date.now() };
    this.publishAgentState();
    this.deps.emitEnvelope(
      createEnvelope("agent", {
        t: "perm-request",
        reqId,
        name: input.tool_name,
        args: toolInput,
        modes: [], // a question offers no mode switches
        answerable: this.deps.isWebTurnActive() || this.deps.driveLocalQuestion !== undefined,
      }),
    );

    if (!this.deps.isWebTurnActive()) {
      // Local turn: the terminal TUI's own question widget renders and the
      // human answers it there — the tailer mirrors question+answer as an
      // ordinary tool-start/tool-end pair once answered (see this method's
      // own class-level doc). Tracked in `localOutcomePending` (not the
      // blocking `pending` map — the hook already hands off below, so there's
      // no promise left to settle) for {@link resolveLocalOutcome} to
      // complete once that mirrored tool-end arrives.
      // `questions` carried through for {@link PreToolPermissionBridgeDeps.driveLocalQuestion}
      // to map a web decision's answers back to this widget's option digits.
      this.localOutcomePending.push({
        reqId,
        toolName: input.tool_name,
        drivable: false,
        questions,
      });
      this.deps.onPromptLikely?.();
      return Promise.resolve(
        output("ask", "Locally-initiated turn. Answer the widget at the terminal."),
      );
    }

    return new Promise<PreToolUseHookOutput>((resolvePromise) => {
      const timer = this.setTimer(() => {
        const pending = this.pending.get(reqId);
        if (!pending) return;
        this.pending.delete(reqId);
        // Degraded mode (also the W0.2-fail primary): turn the widget into a
        // plain conversational question — the composer handles the reply.
        const decision: PermDecision = { kind: "deny", message: ASK_FALLBACK_REASON };
        this.finishRequest(reqId, decision, "denied");
        pending.settle(output("deny", ASK_FALLBACK_REASON));
      }, this.answerTimeoutMs);

      this.pending.set(reqId, {
        settle: (out) => resolvePromise(out),
        toolName: input.tool_name,
        input: toolInput,
        timer,
        isQuestion: true,
        questions,
      });

      this.deps.logger?.debug("[pretool-bridge] question sent", { reqId });
    });
  }

  /**
   * The `PermissionRequest` hook handler — fires only for calls Claude Code
   * Always emits a `perm-request` (docs/known-issues.md issue #5 — web must
   * see every pending prompt, not just web-initiated ones). A local turn then
   * returns `undefined` immediately (no decision → the terminal TUI dialog
   * renders untouched, zero added delay) and tracks the request in {@link
   * localOutcomePending} for {@link resolveLocalOutcome} to complete later; a
   * web turn instead blocks until a `perm.answer` decision arrives ({@link
   * resolve}), the answer times out (→ deny), or {@link reset}.
   */
  handlePermissionRequest(
    input: PermissionRequestHookInput,
  ): Promise<PermissionRequestHookOutput | undefined> {
    this.cachePermissionMode(input.permission_mode);

    // `AskUserQuestion` is fully owned by {@link handleAskUserQuestion}'s own
    // `PreToolUse` interception, which already emits its own `perm-request`
    // and tracks its own local-outcome entry. On a LOCAL turn, that method's
    // `PreToolUse` output is `ask` (not `deny`), so Claude Code's own engine
    // still fires this `PermissionRequest` hook afterward as a normal,
    // expected follow-up (AskUserQuestion always needs a human) — not a bug
    // in Claude Code, just a fact of the two-hook design this class's header
    // doc describes. Before this fix, that follow-up call independently
    // created a SECOND reqId/pending entry for the exact same logical
    // question (docs/known-issues.md issue #5 regression): since only one
    // real `tool-end` ever fires for one actual tool call,
    // {@link resolveLocalOutcome}'s FIFO-by-tool-name match could only ever
    // resolve ONE of the two, leaving the other stuck pending forever (and,
    // since both emitted their own `perm-request`, a duplicate card on web).
    // Deferring here (`undefined`, same as "no decision") is safe regardless
    // of local vs. web — a web turn never even reaches this method for
    // `AskUserQuestion` in the first place, since `handleAskUserQuestion`'s
    // web branch resolves `PreToolUse` with a `deny`, which stops Claude Code
    // from ever firing `PermissionRequest` for that call at all.
    if (isAskUserQuestion(input.tool_name)) return Promise.resolve(undefined);

    // Fires regardless of local vs. web — see `onPendingAttention`'s own doc.
    this.deps.onPendingAttention?.("perm");
    const toolName = input.tool_name;
    const toolInput = input.tool_input ?? {};
    const reqId = createId();

    // Emitted unconditionally (docs/known-issues.md issue #5 fix — see the
    // class-level "Local turns are visible on web too" doc) so web always
    // sees the pending request, regardless of who's driving this turn.
    this.requests[reqId] = { tool: toolName, arguments: toolInput, createdAt: Date.now() };
    this.publishAgentState();
    this.deps.emitEnvelope(
      createEnvelope("agent", {
        t: "perm-request",
        reqId,
        name: toolName,
        args: toolInput,
        modes: availableModes(toolName),
        // A locally-typed turn is still answerable from web when a
        // `driveLocalDialog` is wired (real keystroke-injection into the live
        // PTY) — only falls back to read-only when the caller hasn't wired
        // that (e.g. tests).
        answerable: this.deps.isWebTurnActive() || this.deps.driveLocalDialog !== undefined,
      }),
    );

    if (!this.deps.isWebTurnActive()) {
      // Locally-typed turn: never intercept — the terminal user is already
      // looking at the TUI dialog Claude Code is about to show, and the hook
      // itself still hands off immediately (`undefined`) with zero added
      // delay. Tracked in `localOutcomePending` (not the blocking map below —
      // there's no promise left to settle) for {@link resolveLocalOutcome} to
      // complete once a matching tool-start/tool-end pair reveals the real
      // outcome. `drivable: true` — an ordinary permission/`ExitPlanMode`
      // prompt `resolve()` may attempt to answer via `driveLocalDialog`.
      this.localOutcomePending.push({ reqId, toolName, drivable: true });
      this.deps.logger?.debug("[pretool-bridge] local turn — TUI dialog owns it", {
        toolName,
        reqId,
      });
      this.deps.onPromptLikely?.();
      return Promise.resolve(undefined);
    }

    return new Promise<PermissionRequestHookOutput>((resolvePromise) => {
      const settle = (decision: PermDecision): void => {
        if (decision.kind === "allow" && decision.updatedInput !== undefined) {
          // The `PermissionRequest` output contract has no `updatedInput`
          // channel (unlike `PreToolUse`'s), so an edited input can't be
          // plumbed back through the live TUI here either — same limitation
          // `mapDecision` documents for its own (currently dead) path. Warn
          // rather than silently discarding the edit, so an "Allow" on an
          // edited-input PermCard is never silently a no-op.
          this.deps.logger?.warn(
            "[pretool-bridge] updatedInput is not applied — allowing with original input",
            { toolName },
          );
        }
        const behavior = decision.kind === "deny" ? "deny" : "allow";
        const message =
          decision.kind === "deny"
            ? appendDenyGuard(decision.message ?? "Denied from the Kvy web UI.")
            : decision.kind === "mode"
              ? `Switched permission mode to "${decision.mode}" and allowed from the Kvy web UI.`
              : "Allowed from the Kvy web UI.";
        resolvePromise({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior, message },
          },
        });
      };

      const timer = this.setTimer(() => {
        const pending = this.permRequestPending.get(reqId);
        if (!pending) return;
        this.permRequestPending.delete(reqId);
        const decision: PermDecision = {
          kind: "deny",
          message: `No response from the web within ${Math.round(this.answerTimeoutMs / 1000)}s. Denied.`,
        };
        this.finishRequest(reqId, decision, "denied");
        this.deps.logger?.warn("[pretool-bridge] request timed out — denying", { reqId, toolName });
        pending.settle(decision);
      }, this.answerTimeoutMs);

      this.permRequestPending.set(reqId, { settle, toolName, input: toolInput, timer });

      this.deps.logger?.debug("[pretool-bridge] request sent", { reqId, toolName });
    });
  }

  /**
   * up both the `PreToolUse`-style {@link pending} map and the
   * `PermissionRequest`-style {@link permRequestPending} map — one RPC
   * method serves both hook types. The first caller to resolve a given
   * `reqId` gets `{ok:true}` and settles the blocked hook; every later caller
   * gets `{ok:false, reason: 'already-answered', decision}` carrying the
   * decision that actually won.
   *
   * A `reqId` that belongs to a LOCAL turn (in {@link localOutcomePending}
   * instead of either blocking map — docs/known-issues.md issue #5) is
   * neither "already answered" nor a normal blocked hook to settle. If it's
   * `drivable` (or, for an `AskUserQuestion` entry, has `questions`) and the
   * caller wired the matching {@link PreToolPermissionBridgeDeps.driveLocalDialog}/
   * {@link PreToolPermissionBridgeDeps.driveLocalQuestion}, this actually
   * writes the matching keystrokes into the live PTY — real two-way remote
   * control, not just a mirror — and reports `{ok:true}`; the request itself
   * still resolves later, the normal way, once {@link resolveLocalOutcome}
   * sees the terminal's own tool-start/tool-end pair. Otherwise (no live PTY
   * to drive, or an answer `driveLocalQuestion` can't safely map to this
   * widget's option digits — e.g. free text) it falls back to the honest
   * `{ok:false, reason:"local-turn"}` — nobody knows the outcome yet, this
   * call just had no way to affect it. A second `resolve()` call for a reqId
   * already driven once gets `{ok:false, reason:"already-answered"}` so a
   * double-click can't replay the keystrokes.
   */
  resolve(params: { reqId: string; decision: PermDecision }): PermAnswerResult {
    const localEntry = this.localOutcomePending.find((entry) => entry.reqId === params.reqId);
    if (localEntry) {
      if (this.drivenLocalReqIds.has(params.reqId)) {
        this.deps.logger?.debug("[pretool-bridge] resolve: local request already driven from web", {
          reqId: params.reqId,
        });
        return { ok: false, reason: "already-answered" };
      }
      const drove = localEntry.questions
        ? this.deps.driveLocalQuestion?.(params.decision, localEntry.questions)
        : localEntry.drivable && this.deps.driveLocalDialog?.(params.decision, localEntry.toolName);
      if (drove) {
        this.drivenLocalReqIds.add(params.reqId);
        this.deps.logger?.debug(
          "[pretool-bridge] resolve: drove the live terminal dialog from a web decision",
          { reqId: params.reqId },
        );
        return { ok: true };
      }
      this.deps.logger?.debug(
        "[pretool-bridge] resolve: reqId belongs to a locally-handled request — no channel to drive it from web",
        { reqId: params.reqId },
      );
      return { ok: false, reason: "local-turn" };
    }

    const preToolPending = this.pending.get(params.reqId);
    if (preToolPending) {
      this.pending.delete(params.reqId);
      preToolPending.timer.clear();

      const result = this.mapDecision(preToolPending, params.decision);
      this.finishRequest(
        params.reqId,
        params.decision,
        result.hookSpecificOutput.permissionDecision === "deny" ? "denied" : "approved",
      );
      preToolPending.settle(result);
      return { ok: true };
    }

    const permRequestPending = this.permRequestPending.get(params.reqId);
    if (permRequestPending) {
      this.permRequestPending.delete(params.reqId);
      permRequestPending.timer.clear();

      // Choosing a mode is itself the resolving action (mirrors the ACP
      // handler's rule and `mapDecision`'s `case "mode"` below). The live
      // TUI's mode isn't changed by this hook; the caller owns any
      // best-effort sync via `onModeChange`.
      if (params.decision.kind === "mode") this.deps.onModeChange?.(params.decision.mode);

      this.finishRequest(
        params.reqId,
        params.decision,
        params.decision.kind === "deny" ? "denied" : "approved",
      );
      permRequestPending.settle(params.decision);
      return { ok: true };
    }

    const completed = this.completedRequests[params.reqId];
    this.deps.logger?.debug("[pretool-bridge] resolve: already answered", {
      reqId: params.reqId,
    });
    return completed
      ? { ok: false, reason: "already-answered", decision: completed.decision }
      : { ok: false, reason: "already-answered" };
  }

  /**
   * Completes a local turn's pending permission/question (docs/known-issues.md
   * issue #5's "web card must not hang forever" fix) once its real outcome is
   * known — fed from `start.ts`'s transcript tailer, which sees the tool's own
   * `tool-start`/`tool-end` pair the instant the terminal human actually
   * answers (Claude Code records a `tool_result` for a permission-gated call
   * either way, allowed or denied). Matches FIFO by `toolName`: Claude Code's
   * hooks fire strictly sequentially on the main thread, so the oldest still-
   * open local entry for a given tool name is always the one a subsequent
   * tool-start/tool-end for that name reflects. A no-op if nothing matches —
   * e.g. a tool that never went through a permission hook at all (auto-
   * allowed by settings/mode) or whose request was already resolved (session
   * `reset()`).
   */
  resolveLocalOutcome(toolName: string, outcome: "approved" | "denied"): void {
    const index = this.localOutcomePending.findIndex((entry) => entry.toolName === toolName);
    if (index === -1) return;
    const [entry] = this.localOutcomePending.splice(index, 1);
    if (!entry) return;
    this.drivenLocalReqIds.delete(entry.reqId);

    const decision: PermDecision =
      outcome === "approved"
        ? { kind: "allow", scope: "once" }
        : { kind: "deny", message: "Resolved at the terminal." };
    this.finishRequest(entry.reqId, decision, outcome === "approved" ? "approved" : "denied");
  }

  /**
   * Settles every in-flight request (across both maps, plus any local
   * turn still awaiting a {@link resolveLocalOutcome} correlation) as a deny
   * (`ask` would re-surface the prompt at a terminal nobody is guaranteed to
   * be watching; a clean deny is the safe terminal state). Call on session
   * shutdown.
   */
  reset(reason = "Session ended before the permission request was answered."): void {
    const finalReason = appendDenyGuard(reason);
    for (const [reqId, pending] of this.pending.entries()) {
      pending.timer.clear();
      this.finishRequest(reqId, { kind: "deny", message: finalReason }, "canceled");
      pending.settle(output("deny", finalReason));
    }
    this.pending.clear();

    for (const [reqId, pending] of this.permRequestPending.entries()) {
      pending.timer.clear();
      const decision: PermDecision = { kind: "deny", message: reason };
      this.finishRequest(reqId, decision, "canceled");
      pending.settle(decision);
    }
    this.permRequestPending.clear();

    for (const entry of this.localOutcomePending) {
      this.finishRequest(entry.reqId, { kind: "deny", message: finalReason }, "canceled");
    }
    this.localOutcomePending.length = 0;
    this.drivenLocalReqIds.clear();
  }

  private mapDecision(
    pending: PendingPreToolRequest,
    decision: PermDecision,
  ): PreToolUseHookOutput {
    if (pending.isQuestion) {
      // question widget never renders — Claude reads the deny reason as the
      // user's answer and continues the same turn.
      if (
        decision.kind === "allow" &&
        isRecord(decision.updatedInput) &&
        isRecord((decision.updatedInput as Record<string, unknown>).answers)
      ) {
        const answers = (decision.updatedInput as { answers: Record<string, string> }).answers;
        return output("deny", composeAskAnswerReason(pending.questions ?? [], answers));
      }
      if (decision.kind === "deny") {
        return output("deny", decision.message ?? ASK_FALLBACK_REASON);
      }
      // Any other decision shape for a question (e.g. a bare allow with no
      // answers, or a mode switch — neither makes sense for a question)
      // degrades to the plain-text fallback.
      return output("deny", ASK_FALLBACK_REASON);
    }

    switch (decision.kind) {
      case "allow": {
        if (decision.updatedInput !== undefined) {
          // The wire schema allows `updatedInput`, and PreToolUse *does* have
          // an `updatedInput` output channel — but plumbing modified input
          // safely back through the live TUI is out of scope here, so this
          // degrades to a plain allow with the original input (visible warn).
          this.deps.logger?.warn(
            "[pretool-bridge] updatedInput is not applied — allowing with original input",
            { toolName: pending.toolName },
          );
        }
        return output("allow", `Allowed from the Kvy web UI (${decision.scope}).`);
      }
      case "deny":
        return output("deny", appendDenyGuard(decision.message ?? "Denied from the Kvy web UI."));
      case "mode": {
        // Choosing a mode is itself the resolving action (mirrors the ACP
        // handler's rule). The live TUI's mode isn't changed by this hook;
        // the caller owns any best-effort sync via `onModeChange`.
        this.deps.onModeChange?.(decision.mode);
        return output(
          "allow",
          `Switched permission mode to "${decision.mode}" and allowed this call.`,
        );
      }
    }
  }

  /** Moves a request to `completedRequests` and emits its `perm-resolve` envelope. */
  private finishRequest(
    reqId: string,
    decision: PermDecision,
    status: AgentStateCompletedRequest["status"],
  ): void {
    const request = this.requests[reqId];
    if (request) {
      delete this.requests[reqId];
      this.completedRequests[reqId] = {
        ...request,
        completedAt: Date.now(),
        status,
        decision,
      };
      this.publishAgentState();
    }
    this.deps.emitEnvelope(createEnvelope("agent", { t: "perm-resolve", reqId, decision }));
  }

  private publishAgentState(): void {
    this.deps.onAgentStateChange?.({
      requests: { ...this.requests },
      completedRequests: { ...this.completedRequests },
    });
  }
}
