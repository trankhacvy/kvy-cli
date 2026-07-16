import { Badge } from "@/components/ui/badge";
import type { OrphanToolEndItem } from "@/sync/reducer";
import { JsonBlock } from "./JsonBlock";

/** A `tool-end` whose `tool-start` fell outside this scope (truncated
 * history / adoption boundary) — surfaced, not dropped. */
export function OrphanToolEnd({ item }: { item: OrphanToolEndItem }) {
  return (
    <div className="max-w-[85%] rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
      <div className="flex items-center justify-between gap-2">
        <span>Result for an earlier tool call ({item.call})</span>
        <Badge variant={item.ok ? "success" : "destructive"}>{item.ok ? "ok" : "failed"}</Badge>
      </div>
      {item.output !== undefined && <JsonBlock value={item.output} className="mt-1.5" />}
    </div>
  );
}
