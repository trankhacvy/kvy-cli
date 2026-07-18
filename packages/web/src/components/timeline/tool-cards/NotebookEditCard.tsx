import { NotebookPen } from "lucide-react";
import { parseNotebookEditArgs } from "@/lib/tool-args";
import type { ToolItem } from "@/sync/reducer";
import { DiffView } from "../DiffView";
import { ToolCardShell } from "./ToolCardShell";

/** `NotebookEdit`: path + a diff-ish cell view — the tool has no "old cell
 * source" in its own input (only the target `new_source`), so this reuses
 * `EditCard`'s `Write`-style precedent of rendering `newSource` as a pure
 * addition via `DiffView`. */
export function NotebookEditCard({ item }: { item: ToolItem }) {
  const args = parseNotebookEditArgs(item.args);

  return (
    <ToolCardShell item={item} icon={<NotebookPen className="size-4 text-muted-foreground" />}>
      {args.notebookPath && (
        <p className="truncate font-mono text-xs text-muted-foreground">
          {args.notebookPath}
          {args.cellId ? ` · cell ${args.cellId}` : ""}
          {args.cellType ? ` · ${args.cellType}` : ""}
          {args.editMode && args.editMode !== "replace" ? ` · ${args.editMode}` : ""}
        </p>
      )}
      <div className="mt-1.5">
        <DiffView newText={args.newSource} />
      </div>
    </ToolCardShell>
  );
}
