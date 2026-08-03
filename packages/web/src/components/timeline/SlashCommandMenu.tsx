"use client";

import { TerminalSquare } from "lucide-react";
import type { SlashCommand } from "@/features/slash-commands";
import { cn } from "@/lib/utils";

/**
 * The "/" slash-command autocomplete popover, anchored above `Composer`'s textarea. Selection/keyboard state lives
 * in `Composer` itself (driven by the pure `slash-command-state.ts`
 * helpers) — this component is purely presentational, same "no
 * jsdom/@testing-library, so keep interaction logic out of the rendered
 * tree" reasoning as `mode-switch-state.ts`'s doc comment.
 *
 * Built from the shared shadcn `Command*` primitives (`components/ui/
 * command.tsx`) for visual consistency with the rest of the app, but
 * without `CommandInput` — the actual text being matched lives in the
 * textarea itself, not a second input inside this menu, so cmdk's own
 * built-in filtering/keyboard-nav (which both key off its `CommandInput`)
 * are unused; filtering (`filterSlashCommands`) and keyboard nav
 * (`onKeyDown` on the textarea) are both driven externally by `Composer`.
 */
export function SlashCommandMenu({
  commands,
  selectedIndex,
  onHover,
  onSelect,
}: {
  commands: SlashCommand[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (command: SlashCommand) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 z-10 mb-1 w-full max-w-sm rounded-xl border border-border bg-popover text-popover-foreground shadow-md"
    >
      <div className="max-h-56 overflow-y-auto p-1">
        {commands.map((command, index) => (
          <button
            key={command.name}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            className={cn(
              "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
              index === selectedIndex ? "bg-muted text-foreground" : "text-foreground/90",
            )}
            onMouseEnter={() => onHover(index)}
            // `onMouseDown` (not `onClick`): the textarea's blur-on-mousedown
            // would otherwise fire before a click handler runs, which is
            // harmless here (no focus-dependent logic) but `onMouseDown` plus
            // `preventDefault` keeps focus in the textarea the whole time, so
            // the caret never visibly jumps away mid-selection.
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(command);
            }}
          >
            <TerminalSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">/{command.name}</span>
              {command.description && (
                <span className="truncate text-xs text-muted-foreground">
                  {command.description}
                </span>
              )}
            </span>
            {command.argumentHint && (
              <span className="shrink-0 text-xs text-muted-foreground">{command.argumentHint}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
