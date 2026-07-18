"use client";

import { Paperclip } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { loadDraft, saveDraft } from "@/features/session-control";
import { formatBytes } from "@/lib/format";

/** Whether `file` should get an object-URL image thumbnail in the
 * in-flight attachment strip, vs. just a name/size chip. Extracted as a
 * pure predicate (mirrors `Timeline.tsx`'s `isNearBottom` pattern) so it's
 * unit-testable without a `File`/DOM-construction harness — this package's
 * vitest config runs `.test.ts` files under a plain `node` environment. */
export function isImageFile(file: { type: string }): boolean {
  return file.type.startsWith("image/");
}

interface AttachmentPreview {
  key: string;
  name: string;
  size: number;
  /** `URL.createObjectURL(file)` for an image file, `null` otherwise — revoked once the in-flight strip clears (see the component's `isSending` effect below). */
  previewUrl: string | null;
}

/**
 * Follow-up message input (falcon-prd.md FR-7.3; plan.md §16 "2.4 Web
 * control surface"). Purely presentational — the mutation, optimistic
 * insert, and reconciliation live in `useComposerState`
 * (`@/features/session-control`) so `Timeline` and this component can share
 * the same merged item list without threading it through props twice.
 *
 * Three plan-v2.md W4.2 "Composer" polish items live here:
 *  - **Auto-grow**: the textarea uses CSS `field-sizing: content` (+ a
 *    `max-h`, past which it scrolls) instead of a manual `scrollHeight`
 *    effect — no JS needed for a textarea that grows with its content.
 *  - **Draft persistence**: `sessionStorage`-backed per-`sessionId` draft
 *    (`composer-draft.ts`) — loaded once on mount/session-switch, saved on
 *    every keystroke, cleared right after a successful send.
 *  - **Multi-file attach + image thumbnail previews**: the file input takes
 *    `multiple`; each selected file gets an `onAttach` call (one upload per
 *    file — `useComposerState`'s attach mutation already handles one file at
 *    a time) plus a transient preview chip (an `<img>` thumbnail for images,
 *    a name/size chip otherwise) shown until every in-flight attachment call
 *    has settled (`isSending` flips back to `false`).
 *
 * The attach button (plan.md §16 "4.3 Distribution & self-host": "encrypted
 * attachment path in the web composer") is a plain hidden `<input
 * type="file">` triggered by the paperclip button — `onAttach` does the
 * actual encrypt+upload+send, this component just hands it the raw `File`s.
 * It's disabled until `cryptoReady` — this session's crypto bridge hasn't
 * unwrapped its DEK yet, so an attachment can't be encrypted (plan-v2.md
 * W4.2 "disabled-until-crypto-ready attach button"); a text-only send never
 * needs that bridge, so the Send button itself is never gated on it.
 */
export function Composer({
  sessionId,
  onSend,
  onAttach,
  isSending,
  isQueued,
  cryptoReady,
  error,
  notice,
}: {
  sessionId: string;
  onSend: (text: string) => void;
  onAttach: (file: File) => void;
  isSending: boolean;
  isQueued: boolean;
  cryptoReady: boolean;
  error: string | null;
  /** Non-blocking `outcome-unknown` delivery notice (design §7.10) — shown
   * alongside, never instead of, the composer's normal controls. */
  notice: string | null;
}) {
  const [text, setText] = useState(() => loadDraft(sessionId));
  const [previews, setPreviews] = useState<AttachmentPreview[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A session switch remounts this component in practice (`sessionId` is
  // part of the route), but reload explicitly on the id changing too, so a
  // future call site that keeps one Composer instance across sessions still
  // gets the right draft rather than the previous session's leftover text.
  useEffect(() => {
    setText(loadDraft(sessionId));
  }, [sessionId]);

  // Clears the in-flight attachment strip (and revokes its object URLs) once
  // every attach call this render started has settled — not per-file (this
  // component doesn't track individual upload completion), which is an
  // acceptable simplification: a multi-file attach's thumbnails disappear
  // together shortly after the last one finishes, not staggered.
  useEffect(() => {
    if (isSending) return;
    setPreviews((prev) => {
      for (const p of prev) {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      }
      return prev.length === 0 ? prev : [];
    });
  }, [isSending]);

  function handleTextChange(next: string) {
    setText(next);
    saveDraft(sessionId, next);
  }

  function submit() {
    if (text.trim().length === 0) return;
    onSend(text);
    setText("");
    saveDraft(sessionId, "");
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-selecting the same file(s) consecutively
    if (files.length === 0) return;

    const nextPreviews: AttachmentPreview[] = files.map((file, i) => ({
      key: `${Date.now()}-${i}-${file.name}`,
      name: file.name,
      size: file.size,
      previewUrl: isImageFile(file) ? URL.createObjectURL(file) : null,
    }));
    setPreviews((prev) => [...prev, ...nextPreviews]);
    for (const file of files) onAttach(file);
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
      {isQueued && (
        <Badge variant="warning" className="w-fit">
          Queued — the agent is finishing its current turn
        </Badge>
      )}
      {previews.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {previews.map((p) => (
            <div
              key={p.key}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-xs"
            >
              {p.previewUrl ? (
                <img src={p.previewUrl} alt={p.name} className="size-8 rounded object-cover" />
              ) : (
                <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <div className="max-w-40">
                <p className="truncate font-medium">{p.name}</p>
                <p className="text-muted-foreground">{formatBytes(p.size)} · Sending…</p>
              </div>
            </div>
          ))}
        </div>
      )}
      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
          aria-hidden
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={isSending || !cryptoReady}
          title={cryptoReady ? undefined : "Session key isn't ready yet — try again in a moment."}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach a file"
        >
          <Paperclip className="size-4" />
        </Button>
        <textarea
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Send a follow-up…"
          rows={1}
          className="min-h-9 max-h-64 flex-1 resize-none overflow-y-auto rounded-md border border-input bg-background px-3 py-2 text-sm outline-none [field-sizing:content] focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button onClick={submit} disabled={isSending || text.trim().length === 0}>
          Send
        </Button>
      </div>
    </div>
  );
}
