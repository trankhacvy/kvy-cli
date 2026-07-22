import type { SlashCommandInfo } from "@falcon/wire";

/**
 * View-model types for "/" slash-command autocomplete
 * (docs/competitive-notes-omnara.md #18; falcon-system-design.md §4.4
 * `commands.list`). Surfaces the project's *actual custom* Claude Code
 * slash commands, read live from `.claude/commands/` in the session's
 * worktree — not a fixed built-in list.
 *
 * `SlashCommand` is re-exported straight off `@falcon/wire` rather than
 * redeclared — same precedent as `features/git-diff/types.ts`'s
 * `GitStatusSnapshot`: the RPC result is already exactly what the
 * autocomplete menu wants to render.
 */
export type SlashCommand = SlashCommandInfo;

/**
 * The RPC surface the composer's autocomplete needs, seamed off from *how*
 * that call reaches the daemon — mirrors `features/git-diff`'s
 * `GitDiffActions` / `features/session-control`'s `SessionControlActions`
 * pattern. Mock by default (`mock-source.ts`), swapped for
 * `machineRpcToSlashCommandsActions(createMachineRpcClient({...}))`
 * (`live-actions.ts`) once a screen has a live `apiSocket` + a crypto
 * client holding the target machine's unwrapped DEK
 * (`use-live-slash-commands-actions.ts`).
 */
export interface SlashCommandsActions {
  /** Lists `worktree`'s custom slash commands. Throws on failure (unreachable machine, ...) — callers should treat a rejected call as "no commands available right now" rather than block the composer on it. */
  listCommands(worktree: string): Promise<SlashCommand[]>;
}

/** One slash-commands actions client per chosen machine — mirrors `UseGitDiffActions = (machineId) => GitDiffActions`. */
export type UseSlashCommandsActions = (machineId: string) => SlashCommandsActions;
