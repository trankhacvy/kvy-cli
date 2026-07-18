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
 *    local turn. (The `AskUserQuestion` special case is Wave 2.1, not built
 *    here.)
 *  - `PermissionRequest` ({@link handlePermissionRequest}) is where the
 *    web-vs-terminal fork now lives: a local turn gets `undefined` (no
 *    decision → Claude Code's normal TUI dialog renders untouched); a web
 *    turn runs through the same perm-request/perm-resolve pipeline as
 *    before.
 * This makes the web see *exactly* the prompts a terminal user would see —
 * no more, no less.
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
 * Claude Code's `PermissionRequest` hook stdin payload (verified against
 * 2.1.214, plan-v2.md W0.3). Only `tool_name`/`tool_input` are load-bearing
 * here; everything else (`permission_suggestions` included) is accepted and
 * ignored so a Claude Code version that adds fields never breaks this.
 */
export interface PermissionRequestHookInput {
  session_id?: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
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
  /** Max wait for a web answer before falling back to a deny. Default {@link DEFAULT_ANSWER_TIMEOUT_MS}. */
  answerTimeoutMs?: number;
  /** Injectable timer (default `setTimeout`) so tests can trigger the timeout on demand. */
  setTimer?: (callback: () => void, ms: number) => CancelableTimer;
  logger?: Logger;
}

/**
 * A `PreToolUse`-style pending entry — kept for {@link resolve}/{@link reset}
 * to share with {@link PendingPermissionRequest} even though nothing
 * currently populates {@link PreToolPermissionBridge.pending} (`handlePreToolUse`
 * always resolves immediately with `ask`). Wave 2.1's `AskUserQuestion`
 * special case is the intended future occupant of this map — see
 * plan-v2.md's W2.1 section, which reuses this exact pipeline.
 */
interface PendingPreToolRequest {
  settle: (output: PreToolUseHookOutput) => void;
  toolName: string;
  input: Record<string, unknown>;
  timer: CancelableTimer;
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
  // See {@link PendingPreToolRequest}'s own doc: unpopulated today, reserved
  // for Wave 2.1's `AskUserQuestion` special case, which reuses this exact
  // pipeline. `resolve()`/`reset()` already look here so that wiring is a
  // pure addition later.
  private readonly pending = new Map<string, PendingPreToolRequest>();
  private readonly permRequestPending = new Map<string, PendingPermissionRequest>();
  private requests: Record<string, AgentStateRequest> = {};
  private completedRequests: Record<string, AgentStateCompletedRequest> = {};
  private readonly answerTimeoutMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => CancelableTimer;

  constructor(private readonly deps: PreToolPermissionBridgeDeps) {
    this.answerTimeoutMs = deps.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
    this.setTimer = deps.setTimer ?? defaultSetTimer;
  }

  /** Number of unanswered requests across both hook types — introspection/tests. */
  get pendingCount(): number {
    return this.pending.size + this.permRequestPending.size;
  }

  /**
   * The `PreToolUse` hook handler. Always defers with `ask` — Claude Code's
   * own permission engine decides from there (auto-allow, or a genuine
   * prompt that fires `PermissionRequest`, where the web-vs-terminal fork now
   * lives; see {@link handlePermissionRequest}). The `AskUserQuestion` special
   * case is Wave 2.1, not built here.
   */
  handlePreToolUse(_input: PreToolUseHookInput): Promise<PreToolUseHookOutput> {
    return Promise.resolve(output("ask", "Deferred to Claude Code's own permission engine."));
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
    const toolName = input.tool_name;
    const toolInput = input.tool_input ?? {};

    if (!this.deps.isWebTurnActive()) {
      // Locally-typed turn: never intercept — the terminal user is already
      // looking at the TUI dialog Claude Code is about to show.
      this.deps.logger?.debug("[pretool-bridge] local turn — TUI dialog owns it", { toolName });
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
