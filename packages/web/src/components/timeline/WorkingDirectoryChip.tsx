import { FolderOpen } from "lucide-react";
import { CopyButton } from "./CopyButton";

/**
 * Friendliest short label for a workspace path shown in the header chip: the
 * path's own basename, falling back to the
 * full path for a bare root like "/" or a value with no separator. Same
 * convention as `features/session-list/live-source.ts`'s
 * `workspaceNameFromId` — that helper isn't exported and lives in a
 * different feature, so this is a small standalone copy scoped to the
 * timeline header rather than a cross-feature import.
 */
export function workingDirectoryBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const base = trimmed.split(/[/\\]/).pop();
  return base && base.length > 0 ? base : path;
}

/**
 * One-click "copy working directory path" affordance in the session header.
 * `path` is the session's registered
 * workspace path (`SessionRow.workspaceId`, which *is* the workspace's real
 * absolute directory path — the same convention `SessionGitScreen`/
 * `live-source.ts` already rely on) — shown as a quiet basename chip with
 * the full path on hover (native `title`, same tooltip convention as the
 * header's other disabled buttons) and copyable via the shared `CopyButton`.
 * The caller hides this entirely when there's no workspace path recorded
 * yet, rather than rendering a misleading empty chip.
 */
export function WorkingDirectoryChip({ path }: { path: string }) {
  return (
    <div
      className="flex min-w-0 shrink items-center gap-1 rounded-md border border-border/70 bg-background/80 px-2 py-1 text-xs text-muted-foreground"
      title={path}
    >
      <FolderOpen className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{workingDirectoryBasename(path)}</span>
      <CopyButton
        getText={() => path}
        label="Copy working directory path"
        className="size-5 shrink-0 border-none bg-transparent hover:bg-muted"
      />
    </div>
  );
}
