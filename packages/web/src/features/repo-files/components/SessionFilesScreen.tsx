"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { RepoFilesPanel } from "./RepoFilesPanel";

/**
 * The Repo Files panel's session-scoped entry point (`/dashboard/session/[id]/files/`,
 * docs/competitive-notes-omnara.md #5 "Full repo file browser") — mirrors
 * `SessionGitScreen`'s role exactly: a "screen" component that owns
 * resolving real ids off the live sync snapshot, so the route itself
 * (`app/session/[id]/files/page.tsx`) stays a thin static-export shell.
 *
 * `machineId`/`worktree` come straight off the session's own row
 * (`SessionRow.machineId`/`.workspaceId`, `@falcon/wire`'s `rows.ts` —
 * plaintext fields the server is allowed to see, design §5.3), same
 * source `SessionGitScreen` reads from — no decrypt needed, only the
 * `['sync']` snapshot to have synced the row at all.
 */
export function SessionFilesScreen({ sessionId }: { sessionId: string }) {
  const query = useSyncSnapshotQuery();
  const session = query.data?.sessions.find((s) => s.id === sessionId);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-medium">Session {sessionId} — Repo files</p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/dashboard/session/${sessionId}/`}>Back to session</Link>
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading session…</p>
        ) : !session ? (
          <p className="p-4 text-sm text-destructive">
            Could not find session {sessionId} — it may not have synced to this device yet.
          </p>
        ) : !session.machineId || !session.workspaceId ? (
          <p className="p-4 text-sm text-destructive">
            This session has no machine/workspace recorded yet — the repo file browser needs both to
            know where to run.
          </p>
        ) : (
          <RepoFilesPanel machineId={session.machineId} worktree={session.workspaceId} />
        )}
      </div>
    </div>
  );
}
