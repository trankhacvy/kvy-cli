/**
 * Unified ACP permission handler (design §7.6 "Permission pipeline (remote
 * mode)" v0.3, plan.md §17 "Phase 2.1 — ACP core": "Unified ACP permission
 * handler: `session/request_permission` → existing §7.6 pipeline
 * (auto-rules, first-wins `resolve()`, `perm.answer` RPC) → mapped ACP
 * option response; mode-switch decisions call `session/set_mode`").
 *
 * ONE handler for every provider: Claude and Codex `exec`/`patch` approvals
 * both arrive through ACP's `session/request_permission`, so the per-provider
 * handlers (`claude/permissionHandler.ts`, `codex/permissionHandler.ts`)
 * have no successor here — this class replaces both when Phases 2.2/2.3
 * delete them.
 *
 * What deliberately did NOT carry over from `claude/permissionHandler.ts`,
 * and why:
 *
 *  - **The mode auto-rule engine (bypass/acceptEdits/plan) and Bash/tool
 *    allow-lists.** Under ACP those rules run *inside the agent process*:
 *    the Claude adapter hands the SDK the session's `permissionMode` (synced
 *    via `session/set_mode`) and the SDK's own `canUseTool` auto-allows per
 *    mode before any request reaches Falcon; an `allow_always` option
 *    selection is likewise persisted agent-side. Falcon only ever sees the
 *    requests that genuinely need a human, so re-implementing the rules here
 *    would be dead code shadowing the agent's real behavior. (v1 needed the
 *    engine because Falcon itself *was* the `canUseTool` callback.)
 *  - **`updatedInput` on allow decisions.** ACP's `selected` outcome carries
 *    only an `optionId` — there is no channel for modified tool input. A
 *    decision carrying `updatedInput` still resolves as a plain allow, with
 *    a warn log so the degradation is visible (wire schema keeps the field;
 *    a future ACP extension could restore it).
 *
 * What did carry over, exactly: the pending-request map keyed by a minted
 * cuid2 `reqId`, `perm-request`/`perm-resolve` envelope emission via the
 * injected `emitEnvelope` (ordering/encryption stay the caller's job), the
 * `agentState` snapshot seam (`onAgentStateChange`), first-wins `resolve()`
 * for the `perm.answer` RPC (losers get `{ok:false, reason:
 * 'already-answered', decision}`), reset-on-mode-switch (`reset()` cancels
 * every in-flight request), and the "choosing a mode is itself the
 * resolving action" rule — a `{kind:'mode'}` decision fires `onModeChange`
 * (the caller syncs the live session via `session/set_mode` with its own
 * provider-specific mode-id mapping) and answers the request with an allow.
 *
 * `PermDecision` → ACP option mapping (`options` come from the agent, kinds
 * are ACP's `allow_once | allow_always | reject_once | reject_always`):
 *  - `{kind:'allow', scope:'once'}`    → `allow_once`   (fallback: `allow_always`)
 *  - `{kind:'allow', scope:'session'}` → `allow_always` (fallback: `allow_once`)
 *  - `{kind:'deny'}`                   → `reject_once`  (fallback: `reject_always`,
 *    else the `cancelled` outcome — an agent offering no reject option at all
 *    still must not see the request hang)
 *  - `{kind:'mode', mode}`             → `onModeChange(mode)` + allow (as above)
 *
 * No timeout, no default: ACP blocks a permission request until answered or
 * aborted (same as mobvibe's reference handler) — Falcon's re-notify policy
 * lives in the push pipeline (§6.4), driven by the `perm-request` envelope
 * this class emits, not here.
 */

import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  createEnvelope,
  type PermAnswerResultSchema,
  type PermDecision,
  type PermissionMode,
  type SessionEnvelope,
} from "@falcon/wire";
import { createId } from "@paralleldrive/cuid2";
import type { z } from "zod";
import type { Logger } from "../logger.js";
import { type AcpSessionUpdate, pickAcpToolArgs, pickAcpToolName } from "./acpToEnvelope.js";

export type PermAnswerResult = z.infer<typeof PermAnswerResultSchema>;

/** One entry of `agentState.requests` (design §7.6 step 1) — same shape v1's handler published. */
export interface AgentStateRequest {
  tool: string;
  arguments: Record<string, unknown>;
  createdAt: number;
}

/** One entry of `agentState.completedRequests`, carrying the resolving decision for late/losing `perm.answer` calls. */
export interface AgentStateCompletedRequest extends AgentStateRequest {
  completedAt: number;
  status: "approved" | "denied" | "canceled";
  decision: PermDecision;
}

export interface AgentStateSnapshot {
  requests: Record<string, AgentStateRequest>;
  completedRequests: Record<string, AgentStateCompletedRequest>;
}

interface PendingAcpRequest {
  settle: (response: RequestPermissionResponse) => void;
  toolName: string;
  input: Record<string, unknown>;
  options: readonly PermissionOption[];
}

export interface AcpPermissionHandlerDeps {
  /** Emits a `perm-request`/`perm-resolve` envelope onto the session timeline (design §7.6). */
  emitEnvelope: (envelope: SessionEnvelope) => void;
  /** Fires with the full requests/completedRequests snapshot on every change. */
  onAgentStateChange?: (snapshot: AgentStateSnapshot) => void;
  /**
   * Fires when a `perm.answer` decision switches the permission mode. The
   * caller owns syncing the live ACP session (`session/set_mode`) including
   * the provider-specific wire-mode → ACP-mode-id mapping — this handler
   * stays provider-neutral.
   */
  onModeChange?: (mode: PermissionMode) => void;
  logger?: Logger;
}

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

function findOption(
  options: readonly PermissionOption[],
  ...preferredKinds: readonly PermissionOption["kind"][]
): PermissionOption | undefined {
  for (const kind of preferredKinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) return match;
  }
  return undefined;
}

/**
 * Owns the remote-mode permission pipeline for one ACP session. Wire
 * `handleRequest` into `AcpConnection.setPermissionHandler`; wire `resolve`
 * into the `perm.answer` session RPC.
 */
export class AcpPermissionHandler {
  private readonly pending = new Map<string, PendingAcpRequest>();
  private requests: Record<string, AgentStateRequest> = {};
  private completedRequests: Record<string, AgentStateCompletedRequest> = {};

  constructor(private readonly deps: AcpPermissionHandlerDeps) {}

  /** Number of unanswered requests — introspection/tests. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * The `session/request_permission` handler. Resolves when a `perm.answer`
   * decision arrives (`resolve()`), the ACP request is aborted (agent-side
   * cancel — e.g. `session/cancel` interrupting the turn), or `reset()`.
   */
  handleRequest(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    // `ToolCallUpdate` is structurally the narrow shape the mapper's own
    // pickers read (toolCallId/title/kind/rawInput/_meta) — reuse them so a
    // permission card names the tool exactly like its tool-start card does.
    const toolCallShape = params.toolCall as unknown as AcpSessionUpdate;
    const toolName = pickAcpToolName(toolCallShape);
    const input = pickAcpToolArgs(toolCallShape);
    const reqId = createId();

    return new Promise<RequestPermissionResponse>((resolvePromise) => {
      if (signal.aborted) {
        resolvePromise({ outcome: { outcome: "cancelled" } });
        return;
      }

      const abortHandler = () => {
        // Agent-side cancellation: settle as cancelled AND surface the
        // resolution on the timeline so the PermCard doesn't dangle.
        const pending = this.pending.get(reqId);
        if (!pending) return;
        this.pending.delete(reqId);
        this.finishRequest(
          reqId,
          { kind: "deny", message: "Permission request cancelled" },
          "canceled",
        );
        pending.settle({ outcome: { outcome: "cancelled" } });
      };
      signal.addEventListener("abort", abortHandler, { once: true });

      this.pending.set(reqId, {
        settle: (response) => {
          signal.removeEventListener("abort", abortHandler);
          resolvePromise(response);
        },
        toolName,
        input,
        options: params.options,
      });

      this.requests[reqId] = { tool: toolName, arguments: input, createdAt: Date.now() };
      this.publishAgentState();

      this.deps.emitEnvelope(
        createEnvelope("agent", {
          t: "perm-request",
          reqId,
          name: toolName,
          args: input,
          modes: availableModes(toolName),
        }),
      );

      this.deps.logger?.debug("[acp-permission-handler] request sent", { reqId, toolName });
    });
  }

  /**
   * First-wins resolution for a `perm.answer` RPC call (design §7.6): an
   * atomic check-and-delete on the pending map. The first caller to resolve
   * a given `reqId` gets `{ok:true}`; every later caller for the same
   * `reqId` gets `{ok:false, reason:'already-answered', decision}` with the
   * decision that actually won.
   */
  resolve(params: { reqId: string; decision: PermDecision }): PermAnswerResult {
    const pending = this.pending.get(params.reqId);
    if (!pending) {
      const completed = this.completedRequests[params.reqId];
      this.deps.logger?.debug("[acp-permission-handler] resolve: already answered", {
        reqId: params.reqId,
      });
      return completed
        ? { ok: false, reason: "already-answered", decision: completed.decision }
        : { ok: false, reason: "already-answered" };
    }
    this.pending.delete(params.reqId);

    const response = this.mapDecision(pending, params.decision);
    const denied =
      response.outcome.outcome === "cancelled" || this.isRejectSelection(pending, response);
    this.finishRequest(params.reqId, params.decision, denied ? "denied" : "approved");
    pending.settle(response);

    return { ok: true };
  }

  /**
   * Resets all state on a remote→local mode switch or session stop (design:
   * "reset-on-mode-switch"): every in-flight ACP request settles as
   * `cancelled` (the agent moves on rather than hanging against a handler
   * nobody will answer) and is surfaced as a denied `perm-resolve`.
   */
  reset(reason = "Session switched to local mode"): void {
    for (const [reqId, pending] of this.pending.entries()) {
      this.finishRequest(reqId, { kind: "deny", message: reason }, "canceled");
      pending.settle({ outcome: { outcome: "cancelled" } });
    }
    this.pending.clear();
  }

  private isRejectSelection(
    pending: PendingAcpRequest,
    response: RequestPermissionResponse,
  ): boolean {
    if (response.outcome.outcome !== "selected") return false;
    const selectedId = response.outcome.optionId;
    const selected = pending.options.find((option) => option.optionId === selectedId);
    return selected?.kind === "reject_once" || selected?.kind === "reject_always";
  }

  private mapDecision(
    pending: PendingAcpRequest,
    decision: PermDecision,
  ): RequestPermissionResponse {
    switch (decision.kind) {
      case "allow": {
        if (decision.updatedInput !== undefined) {
          // ACP's `selected` outcome has no modified-input channel (file
          // header) — the allow still goes through, unmodified.
          this.deps.logger?.warn(
            "[acp-permission-handler] updatedInput is not supported over ACP — allowing with original input",
            { toolName: pending.toolName },
          );
        }
        const option =
          decision.scope === "session"
            ? findOption(pending.options, "allow_always", "allow_once")
            : findOption(pending.options, "allow_once", "allow_always");
        if (!option) {
          this.deps.logger?.warn(
            "[acp-permission-handler] agent offered no allow option — cancelling",
            { toolName: pending.toolName },
          );
          return { outcome: { outcome: "cancelled" } };
        }
        return { outcome: { outcome: "selected", optionId: option.optionId } };
      }
      case "deny": {
        const option = findOption(pending.options, "reject_once", "reject_always");
        if (!option) {
          this.deps.logger?.warn(
            "[acp-permission-handler] agent offered no reject option — cancelling",
            { toolName: pending.toolName },
          );
          return { outcome: { outcome: "cancelled" } };
        }
        return { outcome: { outcome: "selected", optionId: option.optionId } };
      }
      case "mode": {
        // Choosing a mode is itself the resolving action (v1 rule, kept):
        // the caller syncs the live session via session/set_mode, and this
        // request resolves as a plain allow under the new mode.
        this.deps.onModeChange?.(decision.mode);
        const option = findOption(pending.options, "allow_once", "allow_always");
        if (!option) {
          this.deps.logger?.warn(
            "[acp-permission-handler] agent offered no allow option for mode decision — cancelling",
            { toolName: pending.toolName },
          );
          return { outcome: { outcome: "cancelled" } };
        }
        return { outcome: { outcome: "selected", optionId: option.optionId } };
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
