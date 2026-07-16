import { Search } from "lucide-react";
import { parseGrepGlobArgs } from "@/lib/tool-args";
import type { ToolItem } from "@/sync/reducer";
import { JsonBlock } from "../JsonBlock";
import { ToolCardShell } from "./ToolCardShell";

export function GrepGlobCard({ item }: { item: ToolItem }) {
  const args = parseGrepGlobArgs(item.args);
  const matches = Array.isArray(item.output) ? item.output : undefined;

  return (
    <ToolCardShell item={item} icon={<Search className="size-4 text-muted-foreground" />}>
      <p className="truncate font-mono text-xs">
        {args.pattern ?? "(no pattern)"}
        {args.path ? <span className="text-muted-foreground"> in {args.path}</span> : null}
        {args.glob ? <span className="text-muted-foreground"> ({args.glob})</span> : null}
      </p>
      {matches ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {matches.length} match{matches.length === 1 ? "" : "es"}
        </p>
      ) : (
        item.output !== undefined && <JsonBlock value={item.output} className="mt-1.5" />
      )}
    </ToolCardShell>
  );
}
