import type { RenderItem } from "@/sync/reducer";
import { TimelineRow } from "./TimelineRow";

/** Non-virtualized inner list — reused for a `ToolItem.subagent` scope and
 * for a standalone `subagent-group`. These scopes are bounded (one
 * subagent's activity), unlike the root timeline, so virtualizing them
 * would add complexity for no real benefit. */
export function NestedItems({ items }: { items: RenderItem[] }) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">No activity recorded.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <TimelineRow key={`${item.id}:${item.kind}`} item={item} />
      ))}
    </div>
  );
}
