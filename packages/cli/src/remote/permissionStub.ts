/**
 * TODO(plan.md §16 "2.3 Permission pipeline", design §7.6): the real remote
 * -mode permission flow — auto-rules per `PermissionMode`, `perm-request`/
 * `perm-resolve` envelopes, the pending-request map with CAS writes into
 * `agentState`, first-wins resolution across devices — is a separate,
 * not-yet-landed task. `claudeRemote.ts` needs *some* `CanUseTool` to hand
 * `@anthropic-ai/claude-agent-sdk`'s `query()` in the meantime, so this stub
 * exists to make that dependency explicit rather than leaving a silent gap:
 * every tool call is denied with a clear message instead of either hanging
 * forever (the SDK's own contract for `canUseTool` is fail-closed — an
 * unanswered request never times out) or silently auto-approving, which
 * would be a real safety regression, not a convenience.
 *
 * Replace this with the permission pipeline's real `canUseTool` once §2.3
 * lands — `startClaudeRemote`'s `canUseTool` option exists precisely so that
 * swap needs no change in `claudeRemote.ts` itself.
 */
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../logger.js";

export const PERMISSION_PIPELINE_NOT_LANDED_MESSAGE =
  "Falcon's remote permission pipeline isn't wired up yet (plan.md §2.3) — every tool call is denied by default in remote mode.";

/** Fail-closed `CanUseTool` stub — logs and denies every call. See file header. */
export function createStubCanUseTool(logger: Logger): CanUseTool {
  return async (toolName) => {
    logger.warn("[claude-remote] canUseTool stub denying tool call — permission pipeline not landed", {
      toolName,
    });
    return {
      behavior: "deny",
      message: PERMISSION_PIPELINE_NOT_LANDED_MESSAGE,
    };
  };
}
