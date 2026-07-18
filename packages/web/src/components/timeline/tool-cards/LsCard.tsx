import { FolderTree } from "lucide-react";
import { parseLsArgs } from "@/lib/tool-args";
import type { ToolItem } from "@/sync/reducer";
import { JsonBlock } from "../JsonBlock";
import { ToolCardShell } from "./ToolCardShell";

/** `LS`: path + the directory listing (Claude Code's own tool-result shape,
 * verified against a real transcript, is a plain indented `- entry` text
 * tree — same "show it verbatim" precedent as `BashCard`/`ReadCard` rather
 * than re-parsing individual entries out of it). */
export function LsCard({ item }: { item: ToolItem }) {
  const args = parseLsArgs(item.args);
  const entries = typeof item.output === "string" ? item.output : undefined;

  return (
    <ToolCardShell item={item} icon={<FolderTree className="size-4 text-muted-foreground" />}>
      <p className="truncate font-mono text-xs text-muted-foreground">
        {args.path ?? "(unknown path)"}
      </p>
      {entries !== undefined ? (
        <pre className="mt-1.5 max-h-64 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-xs">
          <code>{entries}</code>
        </pre>
      ) : (
        item.output !== undefined && <JsonBlock value={item.output} className="mt-1.5" />
      )}
    </ToolCardShell>
  );
}
