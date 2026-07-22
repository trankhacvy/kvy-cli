"use client";

import {
  CheckCircle2,
  ChevronDown,
  File as FileIcon,
  GitBranch,
  GitCompareArrows,
  Pencil,
  RefreshCw,
  Search,
} from "lucide-react";
import { useState } from "react";
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";
import { Button } from "@/components/ui/button";
import { ChecksPanel } from "@/features/github-checks";
import { cn } from "@/lib/utils";

type PanelTab = "changes" | "files" | "checks";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "files", label: "Repo Files" },
  { id: "checks", label: "Checks" },
];

/** Dummy changed-file rows (placeholder UI — no git backend wired here yet;
 * the real diff view lives at `/session/[id]/git`). */
const DUMMY_CHANGES: { path: string; status: "M" | "U" | "A" }[] = [
  { path: ".agents/skills/migrate-radix-to-base/class-mapping.md", status: "U" },
  { path: ".agents/skills/migrate-radix-to-base/consumer-props.md", status: "U" },
  { path: ".agents/skills/migrate-radix-to-base/disclosure.md", status: "U" },
  { path: ".agents/skills/migrate-radix-to-base/SKILL.md", status: "U" },
  { path: "packages/web/src/components/timeline/Composer.tsx", status: "M" },
  { path: "packages/web/src/components/timeline/Timeline.tsx", status: "M" },
  { path: "packages/web/src/components/ui/message-scroller.tsx", status: "A" },
];

const STATUS_TONE: Record<string, string> = {
  M: "text-amber-500",
  U: "text-emerald-500",
  A: "text-emerald-500",
};

function ChangesTab() {
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <GitCompareArrows className="size-3.5" />
        Compare against:
        <span className="font-medium text-foreground">origin/main</span>
        <ChevronDown className="size-3.5" />
      </div>
      <ul className="flex flex-col">
        {DUMMY_CHANGES.map((file) => (
          <li
            key={file.path}
            className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50"
          >
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{file.path}</span>
            <span className={cn("font-mono font-medium", STATUS_TONE[file.status])}>
              {file.status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RepoFilesTab() {
  return (
    <div className="p-3">
      <FileTree defaultExpanded={new Set(["packages", "packages/web", "packages/web/src"])}>
        <FileTreeFolder path="packages" name="packages">
          <FileTreeFolder path="packages/web" name="web">
            <FileTreeFolder path="packages/web/src" name="src">
              <FileTreeFolder path="packages/web/src/components" name="components">
                <FileTreeFile path="packages/web/src/components/timeline" name="timeline/" />
                <FileTreeFile path="packages/web/src/components/ui" name="ui/" />
              </FileTreeFolder>
              <FileTreeFile path="packages/web/src/app" name="app/" />
              <FileTreeFile path="packages/web/src/sync" name="sync/" />
            </FileTreeFolder>
          </FileTreeFolder>
          <FileTreeFolder path="packages/server" name="server">
            <FileTreeFile path="packages/server/src" name="src/" />
          </FileTreeFolder>
          <FileTreeFolder path="packages/cli" name="cli">
            <FileTreeFile path="packages/cli/src" name="src/" />
          </FileTreeFolder>
        </FileTreeFolder>
        <FileTreeFile path="plan.md" name="plan.md" />
        <FileTreeFile path="falcon-system-design.md" name="falcon-system-design.md" />
      </FileTree>
    </div>
  );
}

/**
 * Real once `machineId`/`worktree` are both threaded in (`SessionTimelineScreen.tsx`
 * — both already resolved there off the session row's own plaintext
 * `machineId`/`workspaceId` fields, design §5.3): renders the live
 * `github.checks`-backed `ChecksPanel` (docs/features/github-pr-ci.md).
 * Falls back to the original placeholder — two dummy check cards, an
 * explicit "not connected yet" caption — when either is absent, e.g. a
 * standalone render with no session context.
 */
function ChecksTab({ machineId, worktree }: { machineId?: string; worktree?: string }) {
  if (machineId && worktree) {
    return <ChecksPanel machineId={machineId} worktree={worktree} />;
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
        <CheckCircle2 className="size-4 text-emerald-500" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">build</p>
          <p className="text-muted-foreground">Passed in 42s</p>
        </div>
      </div>
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
        <CheckCircle2 className="size-4 text-emerald-500" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">typecheck</p>
          <p className="text-muted-foreground">Passed in 18s</p>
        </div>
      </div>
      <p className="px-1 text-[11px] text-muted-foreground">
        Placeholder checks — CI wiring isn't connected to this panel yet.
      </p>
    </div>
  );
}

/**
 * The session screen's right-side workspace panel (Changes / Repo Files /
 * Checks tabs + branch header + "Commit & Push"), à la the Cursor agent
 * layout. **Mostly still placeholder UI**: Changes/Repo Files render dummy
 * data and none of the header buttons perform work — the real changed-files
 * view remains the `/session/[id]/git` route. The Checks tab is the one
 * exception (docs/features/github-pr-ci.md): once both `machineId` and
 * `worktree` are threaded in (`SessionTimelineScreen.tsx`), it renders the
 * live `github.checks`-backed panel instead of its own placeholder cards —
 * see `ChecksTab`'s own doc comment. `defaultTab` lets the header chips
 * deep-link a tab (e.g. "Repo root" opens the file tree).
 */
export function SessionSidePanel({
  defaultTab = "changes",
  machineId,
  worktree,
}: {
  defaultTab?: PanelTab;
  /** The session's owning machine (`SessionRow.machineId`) — with `worktree`, gates the Checks tab's live `ChecksPanel` instead of its placeholder. */
  machineId?: string;
  /** The session's workspace path (`SessionRow.workspaceId`) — same gating as `machineId` above. */
  worktree?: string;
}) {
  const [tab, setTab] = useState<PanelTab>(defaultTab);

  return (
    <aside className="hidden h-full w-[360px] shrink-0 flex-col border-l border-border lg:flex">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">v2-pty-injection</span>
          <Pencil className="size-3 shrink-0 text-muted-foreground" />
        </div>
        <div className="flex shrink-0 items-center">
          <Button size="sm" disabled title="Commit & Push isn't wired up yet">
            Commit &amp; Push
          </Button>
          <Button size="icon-sm" variant="ghost" disabled aria-label="More commit actions">
            <ChevronDown className="size-4" />
          </Button>
        </div>
      </header>
      <div className="flex items-center gap-1 border-b border-border px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "border-b-2 px-2 py-2 text-xs font-medium transition-colors",
              tab === t.id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            disabled
            aria-label="Refresh"
            title="Refresh isn't wired up yet"
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled
            aria-label="Search"
            title="Search isn't wired up yet"
          >
            <Search className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "changes" && <ChangesTab />}
        {tab === "files" && <RepoFilesTab />}
        {tab === "checks" && <ChecksTab machineId={machineId} worktree={worktree} />}
      </div>
    </aside>
  );
}
