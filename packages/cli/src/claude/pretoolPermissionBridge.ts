/**
 * Remote permission answering for the LIVE Claude Code TUI, via a
 * `PreToolUse` hook (design §7.4/§7.6, plan.md §17).
 *
 * ## The problem this solves
 * In the new `falcon claude` model the real `claude` TUI stays live at the
 * terminal and web-sent messages are injected into it (PTY-injection input
 * path — a separate concern, built elsewhere). When a web-injected message
 * makes Claude want to run a tool that needs approval, the permission prompt
 * appears in the *terminal* TUI — which a remote web user can't answer.
 *
 * Claude Code's `PreToolUse` hook runs a command before every tool executes
 * and its stdout JSON can approve/deny/defer the call. This bridge is the
 * decision-routing core behind that hook: it takes the hook's tool payload,
 * runs it through Falcon's EXISTING permission pipeline (a `perm-request`
 * envelope for the web PermCard, the first-wins `perm.answer` RPC, a
 * `perm-resolve` envelope), and translates the answer back into the
 * `PreToolUse` output contract — all while the TUI stays live and normal.
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
 * ## Local-vs-web policy (the load-bearing UX decision)
 * A `PreToolUse` hook fires for EVERY tool call — including ones a human
 * typed at the terminal, where they can just answer the TUI prompt
 * themselves. Intercepting those would make the local flow slower and
 * weirder (a round-trip to the web for a prompt the terminal user is already
 * looking at). So the policy is: **only route to the web when the current
 * turn was initiated by a web-injected message.** That signal is the
 * injected `isWebTurnActive()` predicate (the caller flips it true when the
 * `message` RPC delivers web input, false when the turn ends). When it's
 * false, the bridge returns `ask` IMMEDIATELY (zero added latency, zero
 * behavior change) so the terminal TUI prompt shows exactly as it always
 * does. The default is fail-safe: if the caller can't tell, treat it as a
 * local turn and defer to the terminal — a remote-answer path is never
 * forced onto a human sitting at the keyboard.
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
   * False for a locally-typed turn — see the "Local-vs-web policy" section.
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
  /** Max wait for a web answer before falling back to a deny. Default {@link DEFAULT_ANSWER_TIMEOUT_MS}. */
  answerTimeoutMs?: number;
  /** Injectable timer (default `setTimeout`) so tests can trigger the timeout on demand. */
  setTimer?: (callback: () => void, ms: number) => CancelableTimer;
  logger?: Logger;
}

interface PendingPreToolRequest {
  settle: (output: PreToolUseHookOutput) => void;
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
 * Decision-routing core for the `PreToolUse` remote-permission hook. Wire
 * {@link handlePreToolUse} into the loopback hook server's `onPreToolUse`
 * callback, and {@link resolve} into the `perm.answer` session RPC.
 */
export class PreToolPermissionBridge {
  private readonly pending = new Map<string, PendingPreToolRequest>();
  private requests: Record<string, AgentStateRequest> = {};
  private completedRequests: Record<string, AgentStateCompletedRequest> = {};
  private readonly answerTimeoutMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => CancelableTimer;

  constructor(private readonly deps: PreToolPermissionBridgeDeps) {
    this.answerTimeoutMs = deps.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
    this.setTimer = deps.setTimer ?? defaultSetTimer;
  }

  /** Number of unanswered requests — introspection/tests. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * The `PreToolUse` hook handler. Returns immediately with `ask` for a
   * locally-initiated turn (the terminal TUI owns the prompt); otherwise
   * emits a `perm-request` and blocks until a `perm.answer` decision arrives
   * ({@link resolve}), the answer times out (→ deny), or {@link reset}.
   */
  handlePreToolUse(input: PreToolUseHookInput): Promise<PreToolUseHookOutput> {
    const toolName = input.tool_name;
    const toolInput = input.tool_input ?? {};

    if (!this.deps.isWebTurnActive()) {
      // Locally-typed turn: never intercept — let Claude Code show its own
      // TUI permission prompt, exactly as if no hook existed.
      this.deps.logger?.debug("[pretool-bridge] local turn — deferring to terminal", { toolName });
      return Promise.resolve(
        output(
          "ask",
          "Locally-initiated turn — answer the prompt at the terminal (Falcon only routes web-initiated turns to the web UI).",
        ),
      );
    }

    const reqId = createId();

    return new Promise<PreToolUseHookOutput>((resolvePromise) => {
      const timer = this.setTimer(() => {
        const pending = this.pending.get(reqId);
        if (!pending) return;
        this.pending.delete(reqId);
        const decision: PermDecision = {
          kind: "deny",
          message: `No response from the web within ${Math.round(this.answerTimeoutMs / 1000)}s — denied.`,
        };
        this.finishRequest(reqId, decision, "denied");
        this.deps.logger?.warn("[pretool-bridge] request timed out — denying", { reqId, toolName });
        pending.settle(output("deny", decision.message ?? "Timed out."));
      }, this.answerTimeoutMs);

      this.pending.set(reqId, {
        settle: resolvePromise,
        toolName,
        input: toolInput,
        timer,
      });

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
   * First-wins resolution for a `perm.answer` RPC call (design §7.6). The
   * first caller to resolve a given `reqId` gets `{ok:true}` and settles the
   * blocked hook; every later caller gets `{ok:false, reason:
   * 'already-answered', decision}` carrying the decision that actually won.
   */
  resolve(params: { reqId: string; decision: PermDecision }): PermAnswerResult {
    const pending = this.pending.get(params.reqId);
    if (!pending) {
      const completed = this.completedRequests[params.reqId];
      this.deps.logger?.debug("[pretool-bridge] resolve: already answered", {
        reqId: params.reqId,
      });
      return completed
        ? { ok: false, reason: "already-answered", decision: completed.decision }
        : { ok: false, reason: "already-answered" };
    }
    this.pending.delete(params.reqId);
    pending.timer.clear();

    const result = this.mapDecision(pending, params.decision);
    this.finishRequest(
      params.reqId,
      params.decision,
      result.hookSpecificOutput.permissionDecision === "deny" ? "denied" : "approved",
    );
    pending.settle(result);
    return { ok: true };
  }

  /**
   * Settles every in-flight request as a deny (`ask` would re-surface the
   * prompt at a terminal nobody is guaranteed to be watching; a clean deny is
   * the safe terminal state). Call on session shutdown.
   */
  reset(reason = "Session ended before the permission request was answered."): void {
    for (const [reqId, pending] of this.pending.entries()) {
      pending.timer.clear();
      this.finishRequest(reqId, { kind: "deny", message: reason }, "canceled");
      pending.settle(output("deny", reason));
    }
    this.pending.clear();
  }

  private mapDecision(
    pending: PendingPreToolRequest,
    decision: PermDecision,
  ): PreToolUseHookOutput {
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
        return output("deny", decision.message ?? "Denied from the Falcon web UI.");
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
