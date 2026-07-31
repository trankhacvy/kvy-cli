"use client";

import { useEffect, useRef } from "react";

/**
 * Runs `onTurnEnd` exactly on the `working` true -> false transition — never
 * on mount, never while the session stays idle or stays working the whole
 * time. Shared by the Git panel (`use-git-panel.ts`) and Repo Files panel
 * (`use-repo-files.ts`) hooks: neither has a server-side push channel of its
 * own (`use-git-panel.ts`'s own doc comment — a point-in-time RPC snapshot,
 * refreshed only by re-selecting, mutating, or an explicit machine-recovery
 * refetch), so an agent's own file-writing tool calls (Write/Edit/Bash)
 * never invalidated them — a file the agent just created stayed invisible
 * in the Changes/All Files tabs until some unrelated action (a commit, a
 * tab remount) happened to refetch. "The agent just finished a turn" is the
 * cheapest honest signal that something on disk might have changed.
 */
export function useRefetchOnTurnEnd(working: boolean, onTurnEnd: () => void): void {
  const wasWorking = useRef(false);
  const onTurnEndRef = useRef(onTurnEnd);
  onTurnEndRef.current = onTurnEnd;

  useEffect(() => {
    if (working) {
      wasWorking.current = true;
      return;
    }
    if (!wasWorking.current) return;
    wasWorking.current = false;
    onTurnEndRef.current();
  }, [working]);
}
