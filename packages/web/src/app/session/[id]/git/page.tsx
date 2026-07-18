import { RequireAuth } from "@/features/auth";
import { GitDiffPanel } from "@/features/git-diff";

// Static export (next.config.ts) prerenders every route at build time (same
// constraint as `/session/[id]/page.tsx`) — no server ever renders user
// content (design §5.3). Real session→worktree/machine resolution comes
// from the sync engine (a separate, in-flight task); until that lands
// there's exactly one prerenderable id, `demo`, which serves
// `GitDiffPanel`'s mock data source.
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default async function SessionGitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequireAuth>
      <div className="flex h-dvh flex-col">
        <header className="border-b border-border px-4 py-3">
          <p className="text-sm font-medium">Session {id} — Changed files</p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <GitDiffPanel machineId={`mach-${id}`} worktree={`/workspace/${id}`} />
        </div>
      </div>
    </RequireAuth>
  );
}
