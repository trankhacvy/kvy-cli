"use client";

import { useQuery } from "@tanstack/react-query";
import type { SlashCommand, SlashCommandsActions } from "./types";

/**
 * Fetches `worktree`'s custom slash commands once per worktree — plain
 * `useQuery`, same
 * "point-in-time RPC snapshot, no server push channel" reasoning as
 * `features/git-diff/use-git-panel.ts`. A failed fetch (or `worktree` not
 * being known yet) degrades to an empty list rather than surfacing an error
 * in the composer — the "/" autocomplete is a convenience, not something
 * that should block sending a message.
 */
export function useSlashCommands(
  actions: SlashCommandsActions,
  worktree: string | null,
): SlashCommand[] {
  const query = useQuery({
    queryKey: ["slash-commands", worktree],
    queryFn: () => actions.listCommands(worktree as string),
    enabled: worktree !== null,
    staleTime: 60_000,
    retry: false,
  });
  return query.data ?? [];
}
