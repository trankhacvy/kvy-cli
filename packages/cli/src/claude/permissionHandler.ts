/**
 * Ported (adapted) from happy-cli/src/claude/utils/permissionHandler.ts
 * (MIT — https://github.com/slopus/happy), fidelity (P) — plan.md §16
 * "2.3 Permission pipeline": "`PermissionHandler` port: auto-rules
 * (bypass/acceptEdits/plan/read-only descriptors), AskUserQuestion +
 * ExitPlanMode always-prompt, Bash literal/prefix allowlists, pending-promise
 * map, agentState CAS writes, reset-on-mode-switch"; design §7.6 "Permission
 * pipeline (remote mode)".
 *
 * Auto-rules preserved from Happy: `bypassPermissions` -> allow everything;
 * `acceptEdits` -> allow edit tools; `plan` -> allow non-dangerous (read-only)
 * tools; `AskUserQuestion` and `ExitPlanMode`/`exit_plan_mode` always prompt,
 * even under `bypassPermissions` (mirrors the SDK's own
 * `requiresUserInteraction()` check). Bash literal/prefix allow-lists and a
 * pending-request `Map` keyed by a minted request id are also ported as-is.
 *
 * Deltas from Happy, driven by Falcon's actual (already-merged) wire
 * contract and architecture rather than Happy's own:
 *
 *  - **`reqId` is a fresh cuid2 per request** (design §7.6: "reqId = cuid2"),
 *    not Happy's `agentID:toolUseID` composite. Falcon's wire schemas
 *    (`PermAnswerParamsSchema`, `SessionEventSchema`'s `perm-request`) treat
 *    `reqId` as an opaque adapter-minted string, so there is no need to
 *    disambiguate sub-agent calls by composing it from the SDK's own ids.
 *  - **No provider ids on the wire.** `perm-request` does not carry a `call`
 *    id — `envelopeMapper.ts` mints its own cuid2 `call` id for `tool-start`
 *    from the provider's raw `tool_use.id` via a mapping private to the
 *    converter, which this module has no access to (and, per
 *    `session.ts`'s "provider-native ids never cross the wire" rule,
 *    shouldn't reach into). The reducer already matches a call-less
 *    `perm-request` to its eventual `tool-start` by name+args
 *    (`packages/web/src/sync/reducer/reduce.ts`, design §9.1) — that fallback
 *    path is the intended one here, not a workaround.
 *  - **`perm-request`/`perm-resolve` are emitted as `SessionEnvelope`s** via
 *    an injected `emitEnvelope` callback instead of Happy's own
 *    encrypted-push + `updateAgentState` RPC transport — ordering,
 *    encryption, and delivery are the caller's job (e.g. `claudeRemote.ts`
 *    threads them through the same ordered outgoing queue as every other
 *    envelope), this class only ever produces envelopes and hands them off.
 *  - **`agentState` CAS persistence is an injectable seam
 *    (`onAgentStateChange`), not a network write.** Falcon has no
 *    session-scoped `agentState` CAS HTTP client yet (only the machine-scoped
 *    one, `daemon/machineClient.ts` — the session-scoped `PUT
 *    /v1/sessions/:id/state` route exists server-side,
 *    `packages/server/src/app/routes/sessionCas.ts`, but nothing in
 *    `packages/cli` calls it yet). This mirrors `sessionClient.ts`'s
 *    `getWorking` seam: a future task wires the real CAS write in without
 *    touching this file.
 *  - **No Codex mode mapping** (`isClaudeBypassEquivalent`/`mapToClaudeMode`
 *    in Happy). Falcon's wire `PermissionMode`
 *    (`packages/wire/src/permissions.ts`) already *is* the four Claude
 *    modes — Codex is a separate, not-yet-built adapter (plan.md §12) that
 *    will need its own mapping layer when it lands.
 *  - **First-wins resolution (`resolve`) is new** (design §7.6 "Falcon add":
 *    not present in Happy at all): an atomic check-and-delete on the pending
 *    map, so a second `perm.answer` for an already-resolved `reqId` gets
 *    `{ok:false, reason:'already-answered', decision}` — the decision that
 *    actually won — instead of an error, a silent no-op, or a hang.
 *  - **No `getResponseForToolUseId`/`isAborted` lookups.** Happy's transcript
 *    renderer used these to annotate a specific tool call after the fact;
 *    Falcon's timeline is built entirely from the `perm-request`/
 *    `perm-resolve` envelopes by the reducer, so there is no second
 *    lookup path to maintain here.
 */

import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
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
import { getToolDescriptor } from "./getToolDescriptor.js";

export type PermAnswerResult = z.infer<typeof PermAnswerResultSchema>;

/** One entry of `agentState.requests` (design §7.6 step 1). */
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

interface PendingRequest {
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  toolName: string;
  input: Record<string, unknown>;
}

export interface PermissionHandlerDeps {
  /** Permission mode to start under; defaults to `'default'`. */
  initialMode?: PermissionMode;
  /** Emits a `perm-request`/`perm-resolve` envelope onto the session timeline (design §7.6). */
  emitEnvelope: (envelope: SessionEnvelope) => void;
  /** Fires with the full requests/completedRequests snapshot on every change — see file header. */
  onAgentStateChange?: (snapshot: AgentStateSnapshot) => void;
  /** Fires when a `perm.answer` decision changes the permission mode, so the caller can sync the live SDK query (mirrors Happy's `setPermissionModeCallback`). */
  onModeChange?: (mode: PermissionMode) => void;
  logger?: Logger;
}

const DEFAULT_DENY_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

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

function mergeInput(
  original: Record<string, unknown>,
  updatedInput: unknown,
): Record<string, unknown> {
  if (updatedInput && typeof updatedInput === "object" && !Array.isArray(updatedInput)) {
    return { ...original, ...(updatedInput as Record<string, unknown>) };
  }
  return original;
}

/**
 * Owns the remote-mode permission pipeline for one session: auto-rules,
 * Bash allow-lists, the pending-request map, and first-wins `perm.answer`
 * resolution. `canUseTool` is handed directly to
 * `@anthropic-ai/claude-agent-sdk`'s `query({ options: { canUseTool } })`;
 * `resolve` is what a `perm.answer` session RPC handler calls.
 */
export class PermissionHandler {
  private mode: PermissionMode;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly allowedTools = new Set<string>();
  private readonly allowedBashLiterals = new Set<string>();
  private readonly allowedBashPrefixes = new Set<string>();
  private requests: Record<string, AgentStateRequest> = {};
  private completedRequests: Record<string, AgentStateCompletedRequest> = {};

  constructor(private readonly deps: PermissionHandlerDeps) {
    this.mode = deps.initialMode ?? "default";
  }

  get currentMode(): PermissionMode {
    return this.mode;
  }

  /** Changes the active permission mode without going through a `perm.answer` decision (e.g. the `setMode` RPC). */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Allow-lists a Bash command prefix (e.g. `"git "`) for the rest of the session. Nothing calls this yet — Falcon's `PermDecision` wire schema only carries a `scope: 'session'` boolean today, not a granular prefix string — but `canUseTool` already checks prefixes (ported from Happy) so a future finer-grained action has somewhere to plug in. */
  allowBashPrefix(prefix: string): void {
    this.allowedBashPrefixes.add(prefix);
  }

  /** The `CanUseTool` callback handed to `query()`. */
  canUseTool: CanUseTool = async (toolName, input, options) => {
    // AskUserQuestion requires user interaction — never auto-approve, even in
    // bypassPermissions mode. Mirrors the SDK's own requiresUserInteraction().
    if (toolName === "AskUserQuestion") {
      return this.requestPermission(toolName, input, options.signal);
    }

    const descriptor = getToolDescriptor(toolName);

    // ExitPlanMode always requires user approval — never auto-approve it,
    // even if a prior `{kind:'allow', scope:'session'}` decision added it to
    // `allowedTools` (checked below). This must run *before* the allow-list
    // checks, the same precedence AskUserQuestion gets above, or a single
    // "allow for session" answer would silently defeat the always-prompt
    // invariant for every later ExitPlanMode call.
    if (descriptor.exitPlan) {
      return this.requestPermission(toolName, input, options.signal);
    }

    if (toolName === "Bash") {
      const command = typeof input.command === "string" ? input.command : undefined;
      if (command) {
        if (this.allowedBashLiterals.has(command)) {
          return { behavior: "allow", updatedInput: input };
        }
        for (const prefix of this.allowedBashPrefixes) {
          if (command.startsWith(prefix)) {
            return { behavior: "allow", updatedInput: input };
          }
        }
      }
    } else if (this.allowedTools.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }

    if (this.mode === "bypassPermissions") {
      return { behavior: "allow", updatedInput: input };
    }
    if (this.mode === "acceptEdits" && descriptor.edit) {
      return { behavior: "allow", updatedInput: input };
    }
    // Plan mode: auto-approve read-only tools. Dangerous tools (Bash, Edit,
    // Write, ...) still require approval.
    if (this.mode === "plan" && !descriptor.dangerous) {
      return { behavior: "allow", updatedInput: input };
    }

    return this.requestPermission(toolName, input, options.signal);
  };

  /**
   * First-wins resolution for a `perm.answer` RPC call (design §7.6 "Falcon
   * add"): an atomic check-and-delete on the pending map. The first caller
   * to resolve a given `reqId` gets `{ok:true}`; every later caller for the
   * same `reqId` gets `{ok:false, reason:'already-answered', decision}` with
   * the decision that actually won, instead of an error or a silent no-op.
   */
  resolve(params: { reqId: string; decision: PermDecision }): PermAnswerResult {
    const pending = this.pending.get(params.reqId);
    if (!pending) {
      const completed = this.completedRequests[params.reqId];
      this.deps.logger?.debug("[permission-handler] resolve: already answered", {
        reqId: params.reqId,
      });
      return completed
        ? { ok: false, reason: "already-answered", decision: completed.decision }
        : { ok: false, reason: "already-answered" };
    }
    this.pending.delete(params.reqId);

    const result = this.applyDecision(pending, params.decision);
    pending.resolve(result);
    this.completeRequest(
      params.reqId,
      params.decision,
      result.behavior === "deny" ? "denied" : "approved",
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

  /**
   * Resets all state on a local<->remote mode switch (design: "reset-on-
   * mode-switch"): every in-flight request is rejected (so the SDK's
   * `canUseTool` call fails rather than hanging forever against a
   * permission handler nobody will ever answer again) and moved to
   * `completedRequests` with status `canceled`, allow-lists are cleared, and
   * the mode resets to `'default'`.
   */
  reset(reason = "Session switched to local mode"): void {
    for (const [reqId, pending] of this.pending.entries()) {
      pending.reject(new Error("Session reset"));
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
    this.allowedTools.clear();
    this.allowedBashLiterals.clear();
    this.allowedBashPrefixes.clear();
    this.mode = "default";
  }

  private requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const reqId = createId();

    return new Promise<PermissionResult>((resolvePromise, rejectPromise) => {
      const abortHandler = () => {
        this.pending.delete(reqId);
        rejectPromise(new Error("Permission request aborted"));
      };
      signal.addEventListener("abort", abortHandler, { once: true });

      this.pending.set(reqId, {
        resolve: (result) => {
          signal.removeEventListener("abort", abortHandler);
          resolvePromise(result);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abortHandler);
          rejectPromise(error);
        },
        toolName,
        input,
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

      this.deps.logger?.debug("[permission-handler] request sent", { reqId, toolName });
    });
  }

  private applyDecision(pending: PendingRequest, decision: PermDecision): PermissionResult {
    switch (decision.kind) {
      case "allow": {
        if (decision.scope === "session") this.allowForSession(pending.toolName, pending.input);
        return {
          behavior: "allow",
          updatedInput: mergeInput(pending.input, decision.updatedInput),
        };
      }
      case "deny":
        return { behavior: "deny", message: decision.message ?? DEFAULT_DENY_MESSAGE };
      case "mode": {
        this.mode = decision.mode;
        this.deps.onModeChange?.(decision.mode);
        // Choosing a mode is itself the resolving action — the same
        // generalization of Happy's ExitPlanMode-only "approve + switch
        // mode" flow to every permission request (see file header).
        return { behavior: "allow", updatedInput: pending.input };
      }
    }
  }

  private allowForSession(toolName: string, input: Record<string, unknown>): void {
    if (toolName === "Bash") {
      const command = typeof input.command === "string" ? input.command : undefined;
      if (command) this.allowedBashLiterals.add(command);
      return;
    }
    this.allowedTools.add(toolName);
  }

  private completeRequest(
    reqId: string,
    decision: PermDecision,
    status: AgentStateCompletedRequest["status"],
  ): void {
    const request = this.requests[reqId];
    if (!request) return;
    delete this.requests[reqId];
    this.completedRequests[reqId] = {
      ...request,
      completedAt: Date.now(),
      status,
      decision,
    };
    this.publishAgentState();
  }

  private publishAgentState(): void {
    this.deps.onAgentStateChange?.({
      requests: { ...this.requests },
      completedRequests: { ...this.completedRequests },
    });
  }
}
