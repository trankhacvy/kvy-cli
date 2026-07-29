"use client";

import { Button } from "@/components/ui/button";
import { CREATE_PR_PROMPT } from "@/lib/agent-prompts";

/**
 * Asks the session's own agent to commit/push/`gh pr create` itself
 * (session-panel-workflow-plan.md §1) — the agent-assisted, secondary
 * action next to the manual "Open PR on GitHub" link. `onSend` is
 * `ComposerState.send`, lifted from the same `useComposerState(items)` call
 * `SessionTimelineBody` already makes, so this routes through the
 * composer's own optimistic-pending/error handling rather than a raw
 * `sendMessage()` call.
 */
export function CreatePrButton({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled}
      onClick={() => onSend(CREATE_PR_PROMPT)}
    >
      Ask agent to open PR
    </Button>
  );
}
