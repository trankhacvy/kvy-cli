import { Users } from "lucide-react";
import type { RenderItem } from "@/sync/reducer";
import { NestedItems } from "./NestedItems";

/** A subagent scope that never linked to a parent `Task`-like tool call
 * (design principle: no silent data loss — the reducer still surfaces its
 * content, as its own group, at the time of its first envelope). */
export function SubagentGroup({ id, items }: { id: string; items: RenderItem[] }) {
  return (
    <div className="w-fit max-w-[90%] rounded-lg border border-border bg-muted/10 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <Users className="size-3.5" />
        Subagent {id}
      </p>
      <NestedItems items={items} />
    </div>
  );
}
