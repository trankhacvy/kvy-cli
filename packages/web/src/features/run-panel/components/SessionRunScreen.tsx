"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useSessionWorkspacePath } from "@/features/session-list/use-session-workspace-path";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { RunPanel } from "./RunPanel";

/**
 * The Setup/Run tab's session-scoped entry point (`/dashboard/session/[id]/run/`) —
 * verbatim structural copy of `features/git-diff/components/
 * SessionGitScreen.tsx`: resolves the session's real `machineId` off the
 * live `['sync']` snapshot (`SessionRow.machineId` — the server is allowed
 * to see it), and its real working-directory path by decrypting
 * `session.metadata` (never `session.workspaceId`, an opaque id — see
 * `use-session-workspace-path.ts`), so the route itself stays a thin
 * static-export shell.
 */
export function SessionRunScreen({ sessionId }: { sessionId: string }) {
  const query = useSyncSnapshotQuery();
  const session = query.data?.sessions.find((s) => s.id === sessionId);
  const worktree = useSessionWorkspacePath(session);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-medium">Session {sessionId} · Setup / Run</p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/dashboard/session/${sessionId}/`}>Back to session</Link>
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading session…</p>
        ) : !session ? (
          <p className="p-4 text-sm text-destructive">
            Could not find session {sessionId}. It may not have synced to this device yet.
          </p>
        ) : !session.machineId || !worktree ? (
          <p className="p-4 text-sm text-destructive">
            This session has no machine/workspace recorded yet. The Setup/Run tab needs both to know
            where to run.
          </p>
        ) : (
          <RunPanel machineId={session.machineId} worktree={worktree} />
        )}
      </div>
    </div>
  );
}
