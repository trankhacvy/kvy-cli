"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { PreviewPanel } from "./PreviewPanel";

/**
 * The Preview tab's session-scoped entry point (`/session/[id]/preview/`) —
 * verbatim structural copy of `features/git-diff/components/
 * SessionGitScreen.tsx` / `features/github-checks/components/
 * SessionChecksScreen.tsx`: resolves the session's real (plaintext)
 * `machineId` off the live `['sync']` snapshot (`SessionRow.machineId` — the
 * server is allowed to see this, design §5.3) so the route itself stays a
 * thin static-export shell. Unlike the Git/Checks panels, `PreviewPanel`
 * only needs `machineId` (ports/tunnels are machine-scoped, not tied to any
 * one worktree — same `git.*`/`provider.account` precedent), so no
 * `workspaceId` check is needed here.
 */
export function SessionPreviewScreen({ sessionId }: { sessionId: string }) {
  const query = useSyncSnapshotQuery();
  const session = query.data?.sessions.find((s) => s.id === sessionId);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-medium">Session {sessionId} — Preview</p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/session/${sessionId}/`}>Back to session</Link>
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading session…</p>
        ) : !session ? (
          <p className="p-4 text-sm text-destructive">
            Could not find session {sessionId} — it may not have synced to this device yet.
          </p>
        ) : !session.machineId ? (
          <p className="p-4 text-sm text-destructive">
            This session has no machine recorded yet — the Preview tab needs one to know where to
            look for listening ports.
          </p>
        ) : (
          <PreviewPanel machineId={session.machineId} />
        )}
      </div>
    </div>
  );
}
