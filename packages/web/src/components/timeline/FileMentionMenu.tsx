"use client";

import { FileIcon } from "lucide-react";
import type { FileMentionEntry } from "@/features/file-mentions";
import { cn } from "@/lib/utils";

/**
 * The "@" mention picker's popover list (docs/competitive-notes-omnara.md
 * #17) — purely presentational, anchored by its caller (`Composer.tsx`)
 * inside a `relative` wrapper positioned right above the textarea.
 * Keyboard nav (`ArrowUp`/`ArrowDown`/`Enter`/`Tab`/`Escape`) lives in
 * `Composer.tsx`'s own `onKeyDown` handler on the textarea — a plain
 * `<textarea>` can't hand keyboard focus to a separate listbox the way a
 * real `<select>` can, so this component only renders the *result* of that
 * state (`highlightedIndex`) and reports hover/clicks back up via
 * callbacks, mirroring `features/new-session/components/directory-step.tsx`'s
 * hand-rolled (non-cmdk) list style.
 */
export function FileMentionMenu({
  query,
  entries,
  highlightedIndex,
  onHighlight,
  onSelect,
}: {
  query: string;
  entries: FileMentionEntry[];
  highlightedIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (entry: FileMentionEntry) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Mention a file"
      className="absolute bottom-full left-0 z-20 mb-2 max-h-64 w-80 max-w-[90vw] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {entries.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">
          {query.length === 0 ? "No files to suggest" : `No files match "${query}"`}
        </p>
      ) : (
        entries.map((entry, index) => (
          <button
            key={entry.path}
            type="button"
            role="option"
            aria-selected={index === highlightedIndex}
            // Prevent the textarea from ever blurring when an option is
            // clicked — a `mousedown`-triggered blur would fire before
            // `onClick`, closing this menu (via the trigger losing its
            // cursor context) before the selection is applied.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHighlight(index)}
            onClick={() => onSelect(entry)}
            title={entry.path}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
              index === highlightedIndex
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/60",
            )}
          >
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{entry.path}</span>
          </button>
        ))
      )}
    </div>
  );
}
