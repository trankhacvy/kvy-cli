/**
 * Remote permission answering for the LIVE Claude Code TUI, via the
 * `PreToolUse` + `PermissionRequest` hooks (design §7.4/§7.6, plan.md §17,
 * plan-v2.md Wave 1.1).
 *
 * ## The problem this solves
 * In the new `falcon claude` model the real `claude` TUI stays live at the
 * terminal and web-sent messages are injected into it (PTY-injection input
 * path — a separate concern, built elsewhere). When a web-injected message
 * makes Claude want to run a tool that needs approval, the permission prompt
 * appears in the *terminal* TUI — which a remote web user can't answer.
 *
 * Claude Code's hooks run a command around tool execution and their stdout
 * JSON can approve/deny/defer the call. This bridge is the decision-routing
 * core behind both hooks: it takes the hook's tool payload, runs it through
 * Falcon's EXISTING permission pipeline (a `perm-request` envelope for the
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
 * plan-v2.md W0.3)
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
 * ## Two hooks, one responsibility split (design §7.6, plan-v2.md Wave 1.1 —
 * "kill the web-turn permission flood")
 * An earlier version of this bridge routed EVERY `PreToolUse` call of a
 * web-initiated turn to the web — Read/Grep/Glob included, one web message
 * → a wall of PermCards. `PermissionRequest` (verified against our installed
 * Claude Code build, plan-v2.md W0.3) fires only for calls that survive
 * Claude Code's own settings/allowlist/mode evaluation and would genuinely
 * show a dialog — auto-allowed tools never reach it. So responsibilities
 * split across the two hooks:
 *  - `PreToolUse` ({@link handlePreToolUse}) always defers with `ask` —
 *    Claude Code's own permission engine decides from there, exactly like a
 *    local turn — EXCEPT for `AskUserQuestion` ({@link handleAskUserQuestion},
 *    plan-v2.md Wave 2.1), which this hook intercepts directly. Denying at
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
 * ## AskUserQuestion deny-with-answer (plan-v2.md Wave 2.1, gated on the W0.2
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
 * ## Deny copy (probe finding, plan-v2.md W0.3)
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
 * error. Design §7.6's re-notify ×3 policy still applies: it lives in the
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
 * ## `permission_mode` cache + real PTY `setMode` (plan-v2.md W4.3, flag-gated)
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
} from "@falcon/wire";
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
 * plan-v2.md; mirrors the format claude-code-anywhere's intercept.cjs uses,
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
    "The user answered via the Falcon web UI:",
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
 * 2.1.214, plan-v2.md W0.3). Only `tool_name`/`tool_input` are load-bearing
 * here; everything else (`permission_suggestions` included) is accepted and
 * ignored so a Claude Code version that adds fields never breaks this.
 */
export interface PermissionRequestHookInput {
  session_id?: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  /** Present per the header doc's verified `PermissionRequest` contract;
   * cached the same way `PreToolUse`'s own `permission_mode` is (plan-v2.md
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
  return [
    ...(toolName === "ExitPlanMode" || toolName === "exit_plan_mode" ? EXIT_PLAN_MODES : ALL_MODES),
  ];
}

/**
 * The fixed order Claude Code's own Shift+Tab keystroke cycles permission
 * modes through (plan-v2.md W4.3 "Real setMode for the PTY path") — the same
 * four states {@link ALL_MODES} already enumerates, exported under its own
 * name here because the PTY keystroke feature's identity as "a fixed 4-state
 * cycle, not a freeform widget" (plan-v2.md W4.3) is the point, not an
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
  /** Emits a `perm-request`/`perm-resolve` envelope onto the session timeline (design §7.6). */
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
   * wires this to the injection gate's `setPromptOpen(true)` (plan-v2.md
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
  /** Max wait for a web answer before falling back to a deny. Default {@link DEFAULT_ANSWER_TIMEOUT_MS}. */
  answerTimeoutMs?: number;
  /** Injectable timer (default `setTimeout`) so tests can trigger the timeout on demand. */
  setTimer?: (callback: () => void, ms: number) => CancelableTimer;
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
  /** True only for the `AskUserQuestion` pending path (plan-v2.md W2.1). */
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
 * (plan-v2.md W0.3 probe finding: without it, the model routed around a
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
  // {@link PendingPreToolRequest}'s own doc (plan-v2.md Wave 2.1).
  private readonly pending = new Map<string, PendingPreToolRequest>();
  private readonly permRequestPending = new Map<string, PendingPermissionRequest>();
  private requests: Record<string, AgentStateRequest> = {};
  private completedRequests: Record<string, AgentStateCompletedRequest> = {};
  private readonly answerTimeoutMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => CancelableTimer;
  // The last `permission_mode` seen on ANY hook input — `PreToolUse` and
  // `PermissionRequest` both carry it on every call (plan-v2.md W4.3). This
  // is the PTY `setMode` RPC's only source of truth for "what mode is the
  // live TUI actually in right now" (there is no other channel to ask it),
  // and the verification target for {@link waitForModeEcho} after sending a
  // Shift+Tab cycle.
  private lastPermissionMode: PermissionMode | null = null;
  private readonly modeWatchers = new Set<(mode: PermissionMode) => void>();

  constructor(private readonly deps: PreToolPermissionBridgeDeps) {
    this.answerTimeoutMs = deps.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
    this.setTimer = deps.setTimer ?? defaultSetTimer;
  }

  /** The last observed `permission_mode`, or `null` before any hook has fired. */
  get currentPermissionMode(): PermissionMode | null {
    return this.lastPermissionMode;
  }

  /**
   * Caches `permission_mode` off any hook input and notifies pending
   * {@link waitForModeEcho} callers. An unrecognized value (a future Claude
   * Code build renaming/adding modes) is ignored rather than corrupting the
   * cache with something {@link permissionModeCyclePresses} can't index.
   */
  private cachePermissionMode(raw: string | undefined): void {
    if (raw === undefined) return;
    const mode = PERMISSION_MODE_CYCLE.find((m) => m === raw);
    if (!mode) return;
    this.lastPermissionMode = mode;
    for (const watcher of [...this.modeWatchers]) watcher(mode);
  }

  /**
   * Resolves with the `permission_mode` observed on the NEXT hook input
   * (whichever mode that turns out to be — the caller compares it to what it
   * expected), or `null` if none arrives within `timeoutMs`. This is the
   * "verify via hook echo" half of plan-v2.md W4.3's real PTY `setMode`: the
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

  /** Number of unanswered requests across both hook types — introspection/tests. */
  get pendingCount(): number {
    return this.pending.size + this.permRequestPending.size;
  }

  /**
   * The `PreToolUse` hook handler. Defers with `ask` for every tool — Claude
   * Code's own permission engine decides from there (auto-allow, or a
   * genuine prompt that fires `PermissionRequest`, where the web-vs-terminal
   * fork now lives; see {@link handlePermissionRequest}) — EXCEPT
   * `AskUserQuestion`, which {@link handleAskUserQuestion} intercepts here
   * directly (plan-v2.md Wave 2.1; see the class-level "AskUserQuestion
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
   * `AskUserQuestion`'s `PreToolUse` special case (plan-v2.md Wave 2.1). A
   * local turn defers to `ask` — the terminal TUI's own question widget
   * renders there, answered by the human at the keyboard, and the tailer
   * mirrors question+answer as an ordinary tool-start/tool-end pair (a
   * read-only card — no interception needed, so unlike
   * {@link handlePermissionRequest}'s local path this doesn't even need
   * `undefined`; `ask` is Claude Code's own "run the tool" signal). A web
   * turn emits a `perm-request` (with `modes: []` — a question offers no
   * mode switches) and blocks for an answer, exactly like {@link
   * handlePermissionRequest}, but settles through {@link mapDecision}'s
   * question branch instead of the generic allow/deny/mode mapping.
   */
  private handleAskUserQuestion(input: PreToolUseHookInput): Promise<PreToolUseHookOutput> {
    // Fires regardless of local vs. web — see `onPendingAttention`'s own doc.
    this.deps.onPendingAttention?.("question");
    if (!this.deps.isWebTurnActive()) {
      this.deps.onPromptLikely?.();
      return Promise.resolve(
        output("ask", "Locally-initiated turn — answer the widget at the terminal."),
      );
    }

    const toolInput = input.tool_input ?? {};
    const questions = (toolInput.questions ?? []) as AskQuestion[];
    const reqId = createId();

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

      this.requests[reqId] = { tool: input.tool_name, arguments: toolInput, createdAt: Date.now() };
      this.publishAgentState();

      this.deps.emitEnvelope(
        createEnvelope("agent", {
          t: "perm-request",
          reqId,
          name: input.tool_name,
          args: toolInput,
          modes: [], // a question offers no mode switches
        }),
      );

      this.deps.logger?.debug("[pretool-bridge] question sent", { reqId });
    });
  }

  /**
   * The `PermissionRequest` hook handler — fires only for calls Claude Code
   * itself decided need a genuine prompt (design §7.6, plan-v2.md Wave 1.1).
   * A local turn returns `undefined` (no decision → the terminal TUI dialog
   * renders untouched); a web turn emits a `perm-request` and blocks until a
   * `perm.answer` decision arrives ({@link resolve}), the answer times out
   * (→ deny), or {@link reset}.
   */
  handlePermissionRequest(
    input: PermissionRequestHookInput,
  ): Promise<PermissionRequestHookOutput | undefined> {
    this.cachePermissionMode(input.permission_mode);
    // Fires regardless of local vs. web — see `onPendingAttention`'s own doc.
    this.deps.onPendingAttention?.("perm");
    const toolName = input.tool_name;
    const toolInput = input.tool_input ?? {};

    if (!this.deps.isWebTurnActive()) {
      // Locally-typed turn: never intercept — the terminal user is already
      // looking at the TUI dialog Claude Code is about to show.
      this.deps.logger?.debug("[pretool-bridge] local turn — TUI dialog owns it", { toolName });
      this.deps.onPromptLikely?.();
      return Promise.resolve(undefined);
    }

    const reqId = createId();

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
            ? appendDenyGuard(decision.message ?? "Denied from the Falcon web UI.")
            : decision.kind === "mode"
              ? `Switched permission mode to "${decision.mode}" and allowed from the Falcon web UI.`
              : "Allowed from the Falcon web UI.";
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
          message: `No response from the web within ${Math.round(this.answerTimeoutMs / 1000)}s — denied.`,
        };
        this.finishRequest(reqId, decision, "denied");
        this.deps.logger?.warn("[pretool-bridge] request timed out — denying", { reqId, toolName });
        pending.settle(decision);
      }, this.answerTimeoutMs);

      this.permRequestPending.set(reqId, { settle, toolName, input: toolInput, timer });

      this.requests[reqId] = { tool: toolName, arguments: toolInput, createdAt: Date.now() };
      this.publishAgentState();

      this.deps.emitEnvelope(
        createEnvelope("agent", {
          t: "perm-request",
          reqId,
          name: toolName,
          args: toolInput,
          modes: availableModes(toolName),
        }),
      );

      this.deps.logger?.debug("[pretool-bridge] request sent", { reqId, toolName });
    });
  }

  /**
   * First-wins resolution for a `perm.answer` RPC call (design §7.6). Looks
   * up both the `PreToolUse`-style {@link pending} map and the
   * `PermissionRequest`-style {@link permRequestPending} map — one RPC
   * method serves both hook types. The first caller to resolve a given
   * `reqId` gets `{ok:true}` and settles the blocked hook; every later caller
   * gets `{ok:false, reason: 'already-answered', decision}` carrying the
   * decision that actually won.
   */
  resolve(params: { reqId: string; decision: PermDecision }): PermAnswerResult {
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
   * Settles every in-flight request (across both maps) as a deny (`ask`
   * would re-surface the prompt at a terminal nobody is guaranteed to be
   * watching; a clean deny is the safe terminal state). Call on session
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
  }

  private mapDecision(
    pending: PendingPreToolRequest,
    decision: PermDecision,
  ): PreToolUseHookOutput {
    if (pending.isQuestion) {
      // deny-with-answer (plan-v2.md Wave 2.1, W0.2-probe-verified): the
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
        return output("allow", `Allowed from the Falcon web UI (${decision.scope}).`);
      }
      case "deny":
        return output(
          "deny",
          appendDenyGuard(decision.message ?? "Denied from the Falcon web UI."),
        );
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
