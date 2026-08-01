import { cn } from "@/lib/utils";
import type { GitStatusSnapshot } from "../types";
import { FileStatChange, FileStatusBadge } from "./FileStatusBadge";

/**
 * The changed-files list (kvy-prd.md FR-7.7 "file-level diff list vs
 * configured base ref"): branch + ahead/behind header, one row per changed
 * file with its status chip, `selectedPath === null` meaning "show the
 * combined diff for every file".
 */
export function ChangedFilesList({
  status,
  selectedPath,
  onSelect,
}: {
  status: GitStatusSnapshot;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1 text-sm">
        <span className="font-medium">{status.branch}</span>
        {status.ahead > 0 && <span className="text-xs text-muted-foreground">↑{status.ahead}</span>}
        {status.behind > 0 && (
          <span className="text-xs text-muted-foreground">↓{status.behind}</span>
        )}
      </div>

      {status.files.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">No changes vs the configured base ref.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          <li>
            <button
              type="button"
              onClick={() => onSelect(null)}
              className={cn(
                "w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/60",
                selectedPath === null && "bg-muted font-medium text-foreground",
              )}
            >
              All files ({status.files.length})
            </button>
          </li>
          {status.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => onSelect(file.path)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60",
                  selectedPath === file.path && "bg-muted font-medium",
                )}
              >
                <FileStatusBadge status={file.status} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
                <FileStatChange insertions={file.insertions} deletions={file.deletions} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
