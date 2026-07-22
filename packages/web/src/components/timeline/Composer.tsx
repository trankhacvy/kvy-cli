"use client";

import { Mic, Paperclip, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Badge } from "@/components/ui/badge";
import { loadDraft, saveDraft } from "@/features/session-control";
import type { SlashCommand } from "@/features/slash-commands";
import { formatBytes } from "@/lib/format";
import { SlashCommandMenu } from "./SlashCommandMenu";
import {
  applySlashCommandSelection,
  clampSlashSelection,
  detectSlashQuery,
  filterSlashCommands,
  moveSlashSelection,
} from "./slash-command-state";

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
 * The shell is AI Elements' `PromptInput` (two-row chat composer: input row
 * + footer row of chips/buttons, à la the Cursor/ChatGPT layout). Our
 * behaviors stay ours:
 *  - **Draft persistence**: `sessionStorage`-backed per-`sessionId` draft
 *    (`composer-draft.ts`) — loaded once on mount/session-switch, saved on
 *    every keystroke, cleared right after a successful send.
 *  - **Direct-attach flow**: selecting a file immediately encrypts+uploads
 *    +sends it (one `onAttach` call per file), tracked by the transient
 *    preview strip below — NOT PromptInput's own accumulate-then-send
 *    attachment model, which would change semantics.
 *  - **Queue-aware send**: sending while the agent is working queues the
 *    follow-up rather than blocking, so the submit button never morphs into
 *    a stop button. Interrupt is a separate stop button shown only while
 *    `working` (it would otherwise steal the queue path).
 *  - **"/" slash-command autocomplete** (docs/competitive-notes-omnara.md
 *    #18): while the *entire* current text is one bare leading-slash token
 *    (`detectSlashQuery`, `slash-command-state.ts`), a `SlashCommandMenu`
 *    popover lists the project's own custom commands (`slashCommands` prop
 *    — fetched by the caller via `commands.list`, read live from the
 *    session's `.claude/commands/`, never a fixed built-in list) filtered
 *    to the typed query. Arrow keys move the selection, Enter/Tab accepts
 *    it (replacing the whole textarea with `/name `), Escape dismisses the
 *    menu for that query. All keyboard handling runs in this component's own
 *    `onKeyDown` — `preventDefault()` there stops `PromptInputTextarea`'s
 *    own Enter-submits-the-form handling from also firing (see that
 *    component's own "if the external handler prevented default" doc
 *    comment).
 *
 * `footerControls` is a render slot for session-scoped chips (model, mode
 * selector, take-control) that need `SessionControlProvider` context — this
 * component intentionally stays provider-free so it can render standalone
 * in tests (`Composer.test.tsx`) and in the demo fixture.
 *
 * `disabled` (plan-v2.md W1.4+B15): true once the session's own row status
 * says the underlying CLI process is gone (`ended`/`failed`).
 */
export function Composer({
  sessionId,
  onSend,
  onAttach,
  isSending,
  isQueued,
  cryptoReady,
  disabled = false,
  error,
  notice,
  working = false,
  onStop,
  footerControls,
  slashCommands = [],
}: {
  sessionId: string;
  onSend: (text: string) => void;
  onAttach: (file: File) => void;
  isSending: boolean;
  isQueued: boolean;
  cryptoReady: boolean;
  disabled?: boolean;
  error: string | null;
  /** Non-blocking `outcome-unknown` delivery notice (design §7.10) — shown
   * alongside, never instead of, the composer's normal controls. */
  notice: string | null;
  /** True while a turn is in flight — shows the interrupt (stop) button. */
  working?: boolean;
  /** Interrupt the current turn (session RPC `interrupt`). */
  onStop?: () => void;
  /** Left-side footer chips (model / mode / take-control), rendered by the
   * caller inside its session-control context. */
  footerControls?: React.ReactNode;
  /** The project's own custom slash commands (docs/competitive-notes-omnara.md
   * #18), already fetched by the caller (`use-slash-commands.ts`'s
   * `commands.list` machine RPC) — this component stays provider-free (see
   * this file's own doc comment), so it takes the list as data rather than
   * fetching it itself. Defaults to `[]` (no autocomplete) for every
   * existing call site/test that doesn't pass one. */
  slashCommands?: SlashCommand[];
}) {
  const [text, setText] = useState(() => loadDraft(sessionId));
  const [previews, setPreviews] = useState<AttachmentPreview[]>([]);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const slashQuery = detectSlashQuery(text);
  const filteredSlashCommands =
    slashQuery !== null ? filterSlashCommands(slashCommands, slashQuery) : [];
  const slashMenuOpen =
    slashQuery !== null && slashQuery !== dismissedSlashQuery && filteredSlashCommands.length > 0;
  const clampedSlashIndex = clampSlashSelection(slashSelectedIndex, filteredSlashCommands.length);

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
    setSlashSelectedIndex(0);
  }

  function handleSubmit() {
    if (disabled || text.trim().length === 0) return;
    onSend(text);
    setText("");
    saveDraft(sessionId, "");
  }

  function handleSlashCommandSelect(command: SlashCommand) {
    const next = applySlashCommandSelection(command);
    setText(next);
    saveDraft(sessionId, next);
    setSlashSelectedIndex(0);
  }

  function handleTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!slashMenuOpen) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSlashSelectedIndex((i) => moveSlashSelection(i, filteredSlashCommands.length, 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setSlashSelectedIndex((i) => moveSlashSelection(i, filteredSlashCommands.length, -1));
        return;
      case "Enter":
      case "Tab": {
        const command = filteredSlashCommands[clampedSlashIndex];
        if (!command) return;
        e.preventDefault();
        handleSlashCommandSelect(command);
        return;
      }
      case "Escape":
        e.preventDefault();
        setDismissedSlashQuery(slashQuery);
        return;
      default:
        return;
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-selecting the same file(s) consecutively
    if (files.length === 0 || disabled) return;

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
    <div className="shrink-0 flex flex-col gap-1.5 px-4 py-3">
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
      <div className="relative">
        {slashMenuOpen && (
          <SlashCommandMenu
            commands={filteredSlashCommands}
            selectedIndex={clampedSlashIndex}
            onHover={setSlashSelectedIndex}
            onSelect={handleSlashCommandSelect}
          />
        )}
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              className="max-h-[32vh] overflow-y-auto"
              value={text}
              disabled={disabled}
              onChange={(e) => handleTextChange(e.currentTarget.value)}
              onKeyDown={handleTextareaKeyDown}
              placeholder={disabled ? "This session has ended." : "Send a follow-up…"}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>{footerControls}</PromptInputTools>
            <PromptInputTools>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileChange}
                aria-hidden
              />
              <PromptInputButton
                disabled={disabled || isSending || !cryptoReady}
                tooltip={
                  cryptoReady
                    ? "Attach a file"
                    : "Session key isn't ready yet — try again in a moment."
                }
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach a file"
              >
                <Paperclip className="size-4" />
              </PromptInputButton>
              <PromptInputButton
                disabled
                tooltip="Voice input isn't available yet"
                aria-label="Voice input"
              >
                <Mic className="size-4" />
              </PromptInputButton>
              {working && (
                <PromptInputButton
                  variant="destructive"
                  tooltip="Interrupt the current turn"
                  onClick={onStop}
                  aria-label="Interrupt"
                >
                  <Square className="size-3.5" />
                </PromptInputButton>
              )}
              <PromptInputSubmit
                className="rounded-full"
                disabled={disabled || isSending || text.trim().length === 0}
              />
            </PromptInputTools>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
