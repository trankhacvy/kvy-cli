"use client";

import { useQuery } from "@tanstack/react-query";
import type { GithubChecksActions } from "./types";

export function useCheckSteps(
  actions: GithubChecksActions,
  worktree: string,
  checkName: string | null,
) {
  const query = useQuery({
    queryKey: ["github-check-steps", worktree, checkName],
    queryFn: () => actions.fetchCheckSteps(worktree, checkName as string),
    enabled: checkName !== null,
    networkMode: "always",
  });
  return { steps: query.data, isLoading: query.isLoading, error: query.error };
}
