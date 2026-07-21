import { Users } from "lucide-react";
import type { RenderItem } from "@/sync/reducer";
import { NestedItems } from "./NestedItems";

/** A subagent scope that never linked to a parent `Task`-like tool call
 * (design principle: no silent data loss — the reducer still surfaces its
 * content, as its own group, at the time of its first envelope). */
export function SubagentGroup({
  id,
  items,
  compact = false,
}: {
  id: string;
  items: RenderItem[];
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact
          ? "w-full rounded-xl border border-border/70 bg-muted/10 p-3"
          : "w-full rounded-2xl border border-border/70 bg-muted/10 p-4"
      }
    >
      <p className="mb-3 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <Users className="size-3.5" />
        Subagent {id}
      </p>
      <NestedItems items={items} />
    </div>
  );
}
