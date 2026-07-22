import { useMemo } from "react";
import type { SlashCommand, SlashCommandsActions, UseSlashCommandsActions } from "./types";

/**
 * The composer autocomplete's default data source — mirrors
 * `features/git-diff/mock-source.ts`'s role: used for standalone
 * review/tests (`Composer.test.tsx`, the demo fixture) wherever a live
 * `commands.list` machine RPC hasn't been wired into a screen.
 */

const LATENCY_MS = 150;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MOCK_COMMANDS: SlashCommand[] = [
  { name: "compact", description: "Compact the conversation history" },
  { name: "review", description: "Review the current diff", argumentHint: "[pr-number]" },
  { name: "git:commit", description: "Create a commit from the staged changes" },
  { name: "git:pr", description: "Open a pull request for the current branch" },
];

export function createMockSlashCommandsActions(_machineId: string): SlashCommandsActions {
  return {
    async listCommands(_worktree) {
      await delay(LATENCY_MS);
      return MOCK_COMMANDS;
    },
  };
}

/** `useMemo`'d on `machineId` — same reasoning as `useMockGitDiffActions`: a
 * real hook backed by a live client shouldn't reseal/reconnect every
 * render, so this stays call-compatible with that eventual swap. */
export const useMockSlashCommandsActions: UseSlashCommandsActions = (machineId) =>
  useMemo(() => createMockSlashCommandsActions(machineId), [machineId]);
