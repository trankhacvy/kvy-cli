"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Follow-up message input (falcon-prd.md FR-7.3; plan.md §16 "2.4 Web
 * control surface"). Purely presentational — the mutation, optimistic
 * insert, and reconciliation live in `useComposerState`
 * (`@/features/session-control`) so `Timeline` and this component can share
 * the same merged item list without threading it through props twice.
 */
export function Composer({
  onSend,
  isSending,
  isQueued,
  error,
}: {
  onSend: (text: string) => void;
  isSending: boolean;
  isQueued: boolean;
  error: string | null;
}) {
  const [text, setText] = useState("");

  function submit() {
    if (text.trim().length === 0) return;
    onSend(text);
    setText("");
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
      {isQueued && (
        <Badge variant="warning" className="w-fit">
          Queued — the agent is finishing its current turn
        </Badge>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Send a follow-up…"
          rows={1}
          className="min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button onClick={submit} disabled={isSending || text.trim().length === 0}>
          Send
        </Button>
      </div>
    </div>
  );
}
