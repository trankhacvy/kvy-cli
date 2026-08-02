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
} from "@kvy/wire";
import { createId } from "@paralleldrive/cuid2";
import type { z } from "zod";
import {
  type ReportSessionAttentionDeps,
  reportSessionAttention as reportSessionAttentionDefault,
  type SessionAttentionKind,
} from "../api/sessionNotify.js";
import { isAskUserQuestion } from "../claude/pretoolPermissionBridge.js";
import type { Logger } from "../logger.js";
import { type AcpSessionUpdate, pickAcpToolArgs, pickAcpToolName } from "./acpToEnvelope.js";

export type PermAnswerResult = z.infer<typeof PermAnswerResultSchema>;

/** One entry in `agentState.requests`. */
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
  /** Emits a `perm-request`/`perm-resolve` envelope onto the session timeline. */
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
  /**
   * Best-effort `POST /v1/sessions/:id/notify` so a push notification reaches
   * a user who's walked away from a headless/ACP session. `sessionId` is
   * Kvy's own session id (NOT the ACP/provider session id). Both `sessionId`
   * and `attention` must be supplied for reporting to fire; either missing is
   * treated as "no live caller has wired this yet" and reporting is a silent
   * no-op — every other permission-decision behavior is unchanged.
   */
  sessionId?: string;
  /** `reportSessionAttention`'s backend/auth config. See `sessionId` above. */
  attention?: ReportSessionAttentionDeps;
  /** Injectable for tests; defaults to the real `reportSessionAttention()`. */
  reportSessionAttention?: typeof reportSessionAttentionDefault;
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

    // Fires the instant a permission request becomes pending — BEFORE we
    // block awaiting a `perm.answer`/agent-side resolution below. Parity
    // with the terminal path's `onPendingAttention` timing
    // (`pretoolPermissionBridge.ts`'s `handlePermissionRequest`/
    // `handleAskUserQuestion`, both of which report before intercepting).
    this.reportAttention(isAskUserQuestion(toolName) ? "question" : "perm");

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
          // ACP mode has no "local terminal turn" concept — the agent process
          // has no TUI of its own, so every request genuinely is answerable
          // from the web card (contrast pretoolPermissionBridge.ts's
          // local-turn fork, which sets this to false).
          answerable: true,
        }),
      );

      this.deps.logger?.debug("[acp-permission-handler] request sent", { reqId, toolName });
    });
  }

  /**
   * First-wins resolution for a `perm.answer` RPC call — atomic
   * check-and-delete on the pending map. The first caller to resolve a given
   * `reqId` gets `{ok:true}`; every later caller for the same `reqId` gets
   * `{ok:false, reason:'already-answered', decision}` with the decision that
   * won.
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
   * Resets all state on a remote→local mode switch or session stop: every
   * in-flight ACP request settles as `cancelled` (the agent moves on rather
   * than hanging against a handler nobody will answer) and is surfaced as a
   * denied `perm-resolve`.
   */
  reset(reason = "Session switched to local mode"): void {
    for (const [reqId, pending] of this.pending.entries()) {
      this.finishRequest(reqId, { kind: "deny", message: reason }, "canceled");
      pending.settle({ outcome: { outcome: "cancelled" } });
    }
    this.pending.clear();
  }

  /**
   * Reports the `done` attention kind for a completed turn — call once a
   * `session/prompt` resolves. Kept as a method on this class so every
   * `reportSessionAttention` call site shares the same session-id/backend
   * deps this handler already owns.
   */
  reportTurnEnd(): void {
    this.reportAttention("done");
  }

  private reportAttention(kind: SessionAttentionKind): void {
    const { sessionId, attention } = this.deps;
    if (!sessionId || !attention) return; // no live caller has wired this yet — silent no-op
    const report = this.deps.reportSessionAttention ?? reportSessionAttentionDefault;
    void report(attention, { sessionId, kind });
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
