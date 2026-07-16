/**
 * Ported (adapted) from happy-cli/src/codex/utils/permissionHandler.ts (MIT
 * — https://github.com/slopus/happy), fidelity (P) — plan.md §16 "3.4 Codex
 * adapter": "Approval routing: `exec:request`/`patch:request` -> permission
 * pipeline"; design §7.7: "Approvals (`exec:request`, `patch:request`) ->
 * same permission pipeline."
 *
 * This is a Codex-specific *parallel* to `../claude/permissionHandler.ts`
 * (design §7.6/§7.7 — Claude's own file header calls out that Codex "is a
 * separate, not-yet-built adapter... that will need its own mapping layer
 * when it lands"): same pending-request-map + first-wins-`resolve()` shape,
 * same `emitEnvelope`/`onAgentStateChange` injectable seams, but driving
 * `CodexAppServerClient`'s `ApprovalHandler` (a Codex `exec`/`patch`
 * approval, resolved with a `ReviewDecision`) instead of the Claude Agent
 * SDK's `canUseTool`/`PermissionResult`.
 *
 * Deltas from both Happy's Codex handler and Falcon's own Claude handler:
 *
 *  - **`reqId` is a fresh cuid2 per request**, same as Claude's handler and
 *    for the same reason (design §7.6: "reqId = cuid2" — no provider ids on
 *    the wire). Happy's Codex handler instead keyed its pending map by the
 *    provider's own `toolCallId` string.
 *  - **Own `PermissionMode` -> Codex-approval mapping**, since Codex has no
 *    equivalent to Claude's four SDK modes (`default`/`acceptEdits`/`plan`/
 *    `bypassPermissions`) — Codex's own approval policies are
 *    `untrusted`/`on-failure`/`on-request`/`never` and don't participate in
 *    `@falcon/wire`'s `PermissionMode` schema at all. Rather than leaving
 *    `modes` on the `perm-request` envelope empty (the schema requires an
 *    array), this reuses the existing four-value enum as the set of
 *    session-level auto-rules a phone can switch to for the REST of a Codex
 *    session, picking the two that have an honest 1:1 meaning for Codex and
 *    dropping the two that don't:
 *      - `bypassPermissions` -> auto-approve every future exec/patch
 *        request (Codex's own `never`-policy equivalent).
 *      - `acceptEdits` -> auto-approve future PATCH requests only (file
 *        edits), still prompting for exec commands.
 *      - `default`/`plan` are never offered as a *destination* mode here —
 *        Codex has no read-only-vs-dangerous tool distinction the way
 *        Claude's `plan` mode does (every approval Codex raises is already
 *        for a write/exec action), so there is no honest second "still
 *        prompts everything" mode to distinguish from `default` itself.
 *  - **No Bash-literal/prefix allowlists.** Those exist in Claude's handler
 *    to auto-approve a previously-typed-and-approved exact shell command.
 *    Codex's exec approvals are matched by the same idea via
 *    `allowedExecLiterals`/`allowedExecPrefixes` below (ported the same
 *    shape, just Codex-scoped) — patches have no comparable "prefix" concept
 *    so `allow session` for a patch just adds `patch` to `allowedKinds`.
 */

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
import type { ApprovalKind, ApprovalRequest, ReviewDecision } from "./codexAppServerClient.js";

export type PermAnswerResult = z.infer<typeof PermAnswerResultSchema>;

export interface AgentStateRequest {
  tool: string;
  arguments: Record<string, unknown>;
  createdAt: number;
}

export interface AgentStateCompletedRequest extends AgentStateRequest {
  completedAt: number;
  status: "approved" | "denied" | "canceled";
  decision: PermDecision;
}

export interface AgentStateSnapshot {
  requests: Record<string, AgentStateRequest>;
  completedRequests: Record<string, AgentStateCompletedRequest>;
}

interface PendingApproval {
  resolve: (decision: ReviewDecision) => void;
  kind: ApprovalKind;
  toolName: string;
  input: Record<string, unknown>;
}

export interface CodexPermissionHandlerDeps {
  initialMode?: PermissionMode;
  emitEnvelope: (envelope: SessionEnvelope) => void;
  onAgentStateChange?: (snapshot: AgentStateSnapshot) => void;
  logger?: Logger;
}

/** The only two `PermissionMode` values with an honest, non-misleading meaning for Codex — see file header. */
const CODEX_AVAILABLE_MODES: readonly PermissionMode[] = ["acceptEdits", "bypassPermissions"];

function toolNameFor(kind: ApprovalKind): string {
  return kind === "exec" ? "exec" : "apply_patch";
}

function requestArgs(request: ApprovalRequest): Record<string, unknown> {
  if (request.type === "exec") {
    return {
      command: request.command ?? [],
      cwd: request.cwd,
      reason: request.reason ?? undefined,
    };
  }
  return { changes: request.fileChanges ?? {}, reason: request.reason ?? undefined };
}

function execCommandLiteral(input: Record<string, unknown>): string | undefined {
  const command = input.command;
  return Array.isArray(command) && command.every((part) => typeof part === "string")
    ? (command as string[]).join(" ")
    : undefined;
}

/**
 * Owns the Codex remote-mode permission pipeline for one session: the
 * pending-approval map, the `bypassPermissions`/`acceptEdits` auto-rules,
 * exec-literal allowlisting, and first-wins `perm.answer` resolution. Handed
 * to `CodexAppServerClient.setApprovalHandler` via `handleApproval`; `resolve`
 * is what a `perm.answer` session RPC handler calls.
 */
export class CodexPermissionHandler {
  private mode: PermissionMode;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly allowedKinds = new Set<ApprovalKind>();
  private readonly allowedExecLiterals = new Set<string>();
  private requests: Record<string, AgentStateRequest> = {};
  private completedRequests: Record<string, AgentStateCompletedRequest> = {};

  constructor(private readonly deps: CodexPermissionHandlerDeps) {
    this.mode = deps.initialMode ?? "default";
  }

  get currentMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** The `ApprovalHandler` handed to `CodexAppServerClient.setApprovalHandler`. */
  handleApproval = async (request: ApprovalRequest): Promise<ReviewDecision> => {
    const toolName = toolNameFor(request.type);
    const input = requestArgs(request);

    if (request.type === "exec") {
      const literal = execCommandLiteral(input);
      if (literal && this.allowedExecLiterals.has(literal)) return "approved";
    }
    if (this.allowedKinds.has(request.type)) return "approved";

    if (this.mode === "bypassPermissions") return "approved";
    if (this.mode === "acceptEdits" && request.type === "patch") return "approved";

    return this.requestApproval(request.callId, request.type, toolName, input);
  };

  /** First-wins resolution for a `perm.answer` RPC call — same semantics as `../claude/permissionHandler.ts`'s `resolve()`. */
  resolve(params: { reqId: string; decision: PermDecision }): PermAnswerResult {
    const pending = this.pending.get(params.reqId);
    if (!pending) {
      const completed = this.completedRequests[params.reqId];
      this.deps.logger?.debug("[codex-permission-handler] resolve: already answered", {
        reqId: params.reqId,
      });
      return completed
        ? { ok: false, reason: "already-answered", decision: completed.decision }
        : { ok: false, reason: "already-answered" };
    }
    this.pending.delete(params.reqId);

    const decision = this.applyDecision(pending, params.decision);
    pending.resolve(decision);
    this.completeRequest(
      params.reqId,
      params.decision,
      decision === "denied" ? "denied" : "approved",
    );

    this.deps.emitEnvelope(
      createEnvelope("agent", {
        t: "perm-resolve",
        reqId: params.reqId,
        decision: params.decision,
      }),
    );

    return { ok: true };
  }

  /** Resets all state on a local<->remote mode switch or session stop — every in-flight approval is denied so nothing hangs forever. */
  reset(reason = "Session reset"): void {
    for (const [reqId, pending] of this.pending.entries()) {
      pending.resolve("denied");
      this.completeRequest(reqId, { kind: "deny", message: reason }, "canceled");
      this.deps.emitEnvelope(
        createEnvelope("agent", {
          t: "perm-resolve",
          reqId,
          decision: { kind: "deny", message: reason },
        }),
      );
    }
    this.pending.clear();
    this.allowedKinds.clear();
    this.allowedExecLiterals.clear();
    this.mode = "default";
  }

  private requestApproval(
    callId: string,
    kind: ApprovalKind,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ReviewDecision> {
    const reqId = createId();

    return new Promise<ReviewDecision>((resolve) => {
      this.pending.set(reqId, { resolve, kind, toolName, input });
      this.requests[reqId] = { tool: toolName, arguments: input, createdAt: Date.now() };
      this.publishAgentState();

      this.deps.emitEnvelope(
        createEnvelope("agent", {
          t: "perm-request",
          reqId,
          name: toolName,
          args: { ...input, callId },
          modes: [...CODEX_AVAILABLE_MODES],
        }),
      );

      this.deps.logger?.debug("[codex-permission-handler] request sent", {
        reqId,
        toolName,
        callId,
      });
    });
  }

  private applyDecision(pending: PendingApproval, decision: PermDecision): ReviewDecision {
    switch (decision.kind) {
      case "allow":
        if (decision.scope === "session") this.allowForSession(pending.kind, pending.input);
        return "approved";
      case "deny":
        return "denied";
      case "mode":
        this.mode = decision.mode;
        // Choosing a mode is itself the resolving action, same generalization
        // Claude's handler applies to ExitPlanMode's approve+switch flow.
        return "approved";
    }
  }

  private allowForSession(kind: ApprovalKind, input: Record<string, unknown>): void {
    if (kind === "exec") {
      const literal = execCommandLiteral(input);
      if (literal) {
        this.allowedExecLiterals.add(literal);
        return;
      }
    }
    this.allowedKinds.add(kind);
  }

  private completeRequest(
    reqId: string,
    decision: PermDecision,
    status: AgentStateCompletedRequest["status"],
  ): void {
    const request = this.requests[reqId];
    if (!request) return;
    delete this.requests[reqId];
    this.completedRequests[reqId] = { ...request, completedAt: Date.now(), status, decision };
    this.publishAgentState();
  }

  private publishAgentState(): void {
    this.deps.onAgentStateChange?.({
      requests: { ...this.requests },
      completedRequests: { ...this.completedRequests },
    });
  }
}
