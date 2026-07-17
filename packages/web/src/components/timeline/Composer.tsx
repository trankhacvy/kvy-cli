"use client";

import { Paperclip } from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Follow-up message input (falcon-prd.md FR-7.3; plan.md §16 "2.4 Web
 * control surface"). Purely presentational — the mutation, optimistic
 * insert, and reconciliation live in `useComposerState`
 * (`@/features/session-control`) so `Timeline` and this component can share
 * the same merged item list without threading it through props twice.
 *
 * The attach button (plan.md §16 "4.3 Distribution & self-host": "encrypted
 * attachment path in the web composer") is a plain hidden `<input
 * type="file">` triggered by the paperclip button — `onAttach` does the
 * actual encrypt+upload+send, this component just hands it the raw `File`.
 */
export function Composer({
  onSend,
  onAttach,
  isSending,
  isQueued,
  error,
  notice,
}: {
  onSend: (text: string) => void;
  onAttach: (file: File) => void;
  isSending: boolean;
  isQueued: boolean;
  error: string | null;
  /** Non-blocking `outcome-unknown` delivery notice (design §7.10) — shown
   * alongside, never instead of, the composer's normal controls. */
  notice: string | null;
}) {
  const [text, setText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function submit() {
    if (text.trim().length === 0) return;
    onSend(text);
    setText("");
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file consecutively
    if (file) onAttach(file);
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
      {isQueued && (
        <Badge variant="warning" className="w-fit">
          Queued — the agent is finishing its current turn
        </Badge>
      )}
      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileChange}
          aria-hidden
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={isSending}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach a file"
        >
          <Paperclip className="size-4" />
        </Button>
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
