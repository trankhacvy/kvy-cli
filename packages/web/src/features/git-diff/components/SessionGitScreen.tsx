"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useSessionWorkspacePath } from "@/features/session-list/use-session-workspace-path";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { GitDiffPanel } from "./GitDiffPanel";

/**
 * The Git panel's session-scoped entry point (`/dashboard/session/[id]/git/`) —
 * mirrors `SessionTimelineScreen`'s role: a "screen" component that owns
 * resolving real ids off the live sync snapshot, so the route itself
 * (`app/session/[id]/git/page.tsx`) stays a thin static-export shell.
 *
 * `machineId` comes straight off the session's own row (`SessionRow.machineId`,
 * `@kvy/wire`'s `rows.ts` — unlike `metadata`, the server is allowed to see
 * it). `worktree` is the real path, decrypted from `session.metadata` — never
 * `session.workspaceId`, which is an opaque `workspaces.id` (see
 * `use-session-workspace-path.ts`) — so this also needs the `['sync']`
 * snapshot to have synced the row at all, plus a live crypto bridge.
 */
export function SessionGitScreen({ sessionId }: { sessionId: string }) {
  const query = useSyncSnapshotQuery();
  const session = query.data?.sessions.find((s) => s.id === sessionId);
  const worktree = useSessionWorkspacePath(session);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-medium">Session {sessionId} · Changed files</p>
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
            This session has no machine/workspace recorded yet. The git panel needs both to know
            where to run.
          </p>
        ) : (
          <GitDiffPanel machineId={session.machineId} worktree={worktree} />
        )}
      </div>
    </div>
  );
}
