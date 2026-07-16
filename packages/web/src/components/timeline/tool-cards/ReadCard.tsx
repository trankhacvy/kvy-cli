import { FileText } from "lucide-react";
import { parseReadArgs } from "@/lib/tool-args";
import type { ToolItem } from "@/sync/reducer";
import { JsonBlock } from "../JsonBlock";
import { ToolCardShell } from "./ToolCardShell";

export function ReadCard({ item }: { item: ToolItem }) {
  const args = parseReadArgs(item.args);
  const content = typeof item.output === "string" ? item.output : undefined;

  return (
    <ToolCardShell item={item} icon={<FileText className="size-4 text-muted-foreground" />}>
      <p className="truncate font-mono text-xs text-muted-foreground">
        {args.filePath ?? "(unknown path)"}
        {args.offset !== undefined ? ` · from line ${args.offset}` : ""}
        {args.limit !== undefined ? ` · ${args.limit} lines` : ""}
      </p>
      {content !== undefined ? (
        <pre className="mt-1.5 max-h-64 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-xs">
          <code>{content}</code>
        </pre>
      ) : (
        item.output !== undefined && <JsonBlock value={item.output} className="mt-1.5" />
      )}
    </ToolCardShell>
  );
}
