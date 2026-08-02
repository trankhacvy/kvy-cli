"use client";

import { Mic, Paperclip, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  applyMentionSelection,
  type FileMentionActions,
  type FileMentionEntry,
  findMentionTrigger,
  type MentionTrigger,
  mockFileMentionActions,
} from "@/features/file-mentions";
import { loadDraft, saveDraft } from "@/features/session-control";
import type { SlashCommand } from "@/features/slash-commands";
import { formatBytes } from "@/lib/format";
import { appendTranscript, describeSpeechError } from "@/lib/speech-input";
import { useSpeechInput } from "@/lib/use-speech-input";
import { FileMentionMenu } from "./FileMentionMenu";
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
 * Follow-up message input. Purely presentational — mutation, optimistic insert, and
 * reconciliation live in `useComposerState` (`@/features/session-control`) so `Timeline`
 * and this component can share the same merged item list without threading it twice.
 *
 * Shell is AI Elements' `PromptInput`. Behaviors:
 *  - **Draft persistence**: `sessionStorage`-backed per-`sessionId` draft, saved on every
 *    keystroke, cleared after a successful send.
 *  - **Direct-attach**: selecting a file immediately encrypts+uploads+sends it — NOT
 *    PromptInput's accumulate-then-send model.
 *  - **Queue-aware send**: while the agent is working, sends queue rather than block, so
 *    the submit button never morphs into a stop button.
 *  - **Voice input**: mic button drives `useSpeechInput`; finalized phrases append to the
 *    draft, interim speech shows as an italic preview so it never fights user typing.
 *  - **"/" slash-command autocomplete**: while the entire text is a bare `/`-token,
 *    `SlashCommandMenu` lists custom commands. Arrow keys move selection, Enter/Tab
 *    accepts, Escape dismisses. `preventDefault()` in `onKeyDown` stops
 *    `PromptInputTextarea`'s own Enter-submits-form from also firing.
 *  - **"@" file-mention autocomplete**: "@" opens a searchable popover over repo files.
 *    Trigger detection/insertion is pure logic (`mention-trigger.ts`); `ArrowUp`/
 *    `ArrowDown`/`Enter`/`Tab`/`Escape` are intercepted before PromptInputTextarea's own
 *    Enter-submits handler via the external `onKeyDown` contract.
 *
 * `footerControls` is a render slot for session-scoped chips that need
 * `SessionControlProvider` context — this component stays provider-free to render
 * standalone in tests.
 *
 * `disabled`: true once the session's CLI process is gone (`ended`/`failed`).
 */
export function Composer({
  sessionId,
  onSend,
  onAttach,
  isSending,
  isQueued,
  cryptoReady,
  disabled = false,
  disabledPlaceholder = "This session has ended.",
  error,
  notice,
  working = false,
  onStop,
  footerControls,
  slashCommands = [],
  fileMentionActions = mockFileMentionActions,
}: {
  sessionId: string;
  onSend: (text: string) => void;
  onAttach: (file: File) => void;
  isSending: boolean;
  isQueued: boolean;
  cryptoReady: boolean;
  disabled?: boolean;
  /** Placeholder shown in place of the normal "Send a follow-up…" once
   * `disabled` — varies by why (ended/failed/archived all disable, but read
   * differently; `SessionTimelineScreen`'s `composerDisabledPlaceholder`
   * picks the right one). */
  disabledPlaceholder?: string;
  error: string | null;
  /** Non-blocking delivery notice for `outcome-unknown` sends — shown alongside, never
   * instead of, the composer's normal controls. */
  notice: string | null;
  /** True while a turn is in flight — shows the interrupt (stop) button. */
  working?: boolean;
  /** Interrupt the current turn (session RPC `interrupt`). */
  onStop?: () => void;
  /** Left-side footer chips (model / mode / take-control), rendered by the
   * caller inside its session-control context. */
  footerControls?: React.ReactNode;
  /** Custom slash commands, already fetched by the caller (`use-slash-commands.ts`'s
   * `commands.list` machine RPC). This component stays provider-free and takes the list as
   * data. Defaults to `[]` (no autocomplete) for call sites that don't pass one. */
  slashCommands?: SlashCommand[];
  /** Data source for the "@" file-mention popover — defaults to a static
   * mock set (`@/features/file-mentions`'s `mockFileMentionActions`) until
   * a caller wires in `createFsFileMentionActions` against a live machine
   * RPC client. */
  fileMentionActions?: FileMentionActions;
}) {
  const [text, setText] = useState(() => loadDraft(sessionId));
  const [previews, setPreviews] = useState<AttachmentPreview[]>([]);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [mentionTrigger, setMentionTrigger] = useState<MentionTrigger | null>(null);
  const [mentionEntries, setMentionEntries] = useState<FileMentionEntry[]>([]);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const mentionRequestRef = useRef(0);

  // A finalized voice-dictation phrase appends to whatever's already in the
  // draft (functional update so a same-tick keystroke and a same-tick
  // dictated phrase can't clobber one another) and persists it exactly like
  // `handleTextChange` below.
  const handleDictatedText = useCallback(
    (transcript: string) => {
      setText((prev) => {
        const next = appendTranscript(prev, transcript);
        saveDraft(sessionId, next);
        return next;
      });
    },
    [sessionId],
  );
  const speech = useSpeechInput(handleDictatedText);

  // The session ending mid-dictation (`disabled` flips true) should close
  // the mic rather than leave it silently listening into a composer that
  // can no longer send.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `speech.stop` is stable (useCallback, no deps) — only re-run when `disabled` itself flips.
  useEffect(() => {
    if (disabled) speech.stop();
  }, [disabled]);

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
    setMentionTrigger(null);
    setMentionEntries([]);
  }, [sessionId]);

  // Re-derives the "@" trigger from the textarea's current text + cursor
  // position on every change and cursor move, kicking off a (possibly
  // async) search when one is active. Guards against out-of-order
  // responses via a monotonic request id — only the most recent call's
  // result is ever applied.
  function refreshMentionTrigger(value: string, cursor: number) {
    const trigger = findMentionTrigger(value, cursor);
    setMentionTrigger(trigger);
    setMentionHighlight(0);
    if (!trigger) {
      setMentionEntries([]);
      return;
    }
    const requestId = ++mentionRequestRef.current;
    fileMentionActions.search(trigger.query).then(
      (results) => {
        if (mentionRequestRef.current === requestId) setMentionEntries(results);
      },
      () => {
        if (mentionRequestRef.current === requestId) setMentionEntries([]);
      },
    );
  }

  function closeMention() {
    setMentionTrigger(null);
    setMentionEntries([]);
  }

  function selectMention(entry: FileMentionEntry) {
    if (!mentionTrigger) return;
    const result = applyMentionSelection(text, mentionTrigger, entry.path);
    handleTextChange(result.text);
    closeMention();
    // The textarea is controlled (`value={text}`) — its DOM value only
    // reflects `result.text` after this render commits, so the caret can
    // only be repositioned on the next frame.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(result.cursor, result.cursor);
      }
    });
  }

  function handleMentionKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!mentionTrigger) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMentionHighlight((i) =>
        mentionEntries.length === 0 ? 0 : (i + 1) % mentionEntries.length,
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMentionHighlight((i) =>
        mentionEntries.length === 0 ? 0 : (i - 1 + mentionEntries.length) % mentionEntries.length,
      );
    } else if (e.key === "Enter" || e.key === "Tab") {
      const chosen = mentionEntries[mentionHighlight];
      if (!chosen) return; // no suggestions yet — let Enter submit / Tab move focus as usual
      e.preventDefault();
      selectMention(chosen);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
    }
  }

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

  // Combines the "/" slash-command menu's keyboard handling with the "@"
  // file-mention menu's — both are keyed off the SAME textarea `onKeyDown`,
  // so each one only acts (and calls `preventDefault()`) while its own menu
  // is actually open (`handleTextareaKeyDown`/`handleMentionKeyDown` both
  // no-op immediately otherwise). The two triggers are mutually exclusive in
  // practice (slash requires the *entire* text to be a bare `/`-token, which
  // can't also contain an "@" mention), but chaining them defensively (skip
  // the mention handler once slash already consumed the keystroke) keeps
  // that invariant from being load-bearing.
  function handleComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    handleTextareaKeyDown(e);
    if (e.defaultPrevented) return;
    handleMentionKeyDown(e);
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
          Queued: the agent is finishing its current turn
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
      {speech.listening && speech.interimText && (
        <p className="text-xs text-muted-foreground italic">{speech.interimText}…</p>
      )}
      {speech.error && speech.error !== "no-speech" && speech.error !== "aborted" && (
        <p className="text-xs text-destructive">{describeSpeechError(speech.error)}</p>
      )}
      <div className="relative">
        {slashMenuOpen && (
          <SlashCommandMenu
            commands={filteredSlashCommands}
            selectedIndex={clampedSlashIndex}
            onHover={setSlashSelectedIndex}
            onSelect={handleSlashCommandSelect}
          />
        )}
        {mentionTrigger && (
          <FileMentionMenu
            query={mentionTrigger.query}
            entries={mentionEntries}
            highlightedIndex={mentionHighlight}
            onHighlight={setMentionHighlight}
            onSelect={selectMention}
          />
        )}
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              ref={textareaRef}
              className="max-h-[32vh] overflow-y-auto"
              value={text}
              disabled={disabled}
              onChange={(e) => {
                const value = e.currentTarget.value;
                const cursor = e.currentTarget.selectionStart ?? value.length;
                handleTextChange(value);
                refreshMentionTrigger(value, cursor);
              }}
              onSelect={(e) => {
                const el = e.currentTarget;
                refreshMentionTrigger(el.value, el.selectionStart ?? el.value.length);
              }}
              onKeyDown={handleComposerKeyDown}
              onBlur={closeMention}
              placeholder={disabled ? disabledPlaceholder : "Send a follow-up…"}
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
                    : "Session key isn't ready yet. Try again in a moment."
                }
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach a file"
              >
                <Paperclip className="size-4" />
              </PromptInputButton>
              <PromptInputButton
                disabled={disabled || !speech.supported}
                variant={speech.listening ? "destructive" : "ghost"}
                tooltip={
                  speech.supported
                    ? speech.listening
                      ? "Stop voice input"
                      : "Voice input"
                    : "Voice input isn't supported in this browser"
                }
                onClick={() => (speech.listening ? speech.stop() : speech.start())}
                aria-label={speech.listening ? "Stop voice input" : "Voice input"}
                aria-pressed={speech.listening}
              >
                <Mic className={speech.listening ? "size-4 animate-pulse" : "size-4"} />
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
