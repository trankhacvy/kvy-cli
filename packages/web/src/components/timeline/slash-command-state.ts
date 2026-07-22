import type { SlashCommand } from "@/features/slash-commands";

/**
 * `Composer`'s "/" slash-command autocomplete state
 * (docs/competitive-notes-omnara.md #18) — kept as a pure module, same
 * precedent as `mode-switch-state.ts`/`stop-session-state.ts`: no
 * jsdom/@testing-library in this package (`vitest.config.ts`), so the
 * trigger-detection/filter/selection logic a real typing + arrow-key
 * sequence would exercise has to be plain functions `Composer.test.ts` can
 * call directly, not a rendered interaction.
 *
 * A command is only ever "in progress" for the composer's *entire* current
 * text being one bare leading-slash token — exactly where a real Claude
 * Code slash command must start (`/foo`, never `hello /foo`) — and only
 * until the first space, at which point the rest of the message is the
 * command's own arguments, not something to keep matching against.
 */

/** Returns the in-progress command query (the text after `/`) when `text`
 * is a bare leading-slash token with no whitespace yet (`""`, `/`, `/comp`,
 * `/git:comm`...), or `null` once anything rules that out — a leading space,
 * a space anywhere in the middle (arguments have started), or no leading
 * `/` at all. */
export function detectSlashQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? (match[1] ?? "") : null;
}

/** Case-insensitive filter + rank: name-prefix matches first (most likely
 * what the user is typing toward), then substring matches elsewhere in the
 * name — both groups keeping the input's own (already-alphabetical) order.
 * An empty `query` (just typed `/`) returns every command, browse-style. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (query === "") return commands;
  const q = query.toLowerCase();
  const startsWith: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) startsWith.push(command);
    else if (name.includes(q)) contains.push(command);
  }
  return [...startsWith, ...contains];
}

/** Wraps `current + delta` around `[0, count)` — `count === 0` always stays
 * at `0` (nothing to select), matching `Timeline`/`ControlBar`'s own
 * "no items, no crash" convention elsewhere in this package. */
export function moveSlashSelection(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return 0;
  return (current + delta + count) % count;
}

/** Clamps a previously-selected index back into range once the filtered
 * list shrinks (e.g. a keystroke narrows the match set past the old
 * selection) — never lets the caller hold onto an out-of-bounds index. */
export function clampSlashSelection(current: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(current, 0), count - 1);
}

/** The composer's next text once `command` is accepted from the menu — the
 * full invocation name plus a trailing space, ready for the user's own
 * arguments. Replaces the *entire* current text since (per `detectSlashQuery`
 * above) the menu is only ever open while the whole composer is one bare
 * `/query` token. */
export function applySlashCommandSelection(command: SlashCommand): string {
  return `/${command.name} `;
}
