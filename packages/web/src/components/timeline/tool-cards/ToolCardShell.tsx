import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { ToolItem } from "@/sync/reducer";
import { NestedItems } from "../NestedItems";
import { PermissionBadge } from "../PermissionBadge";

/** Common chrome for every `ToolCard` registry entry: header (icon, name,
 * status, read-only permission badge), a body slot for the tool-specific
 * content, and — generically, since the reducer can link a subagent scope
 * onto *any* tool call, not just `Task` — nested subagent activity. */
export function ToolCardShell({
  item,
  icon,
  children,
}: {
  item: ToolItem;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="w-full max-w-[90%] rounded-lg border border-border bg-card text-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2">
        {icon}
        <span className="font-medium">{item.title ?? item.name}</span>
        {item.status === "running" ? (
          <Badge variant="secondary">running</Badge>
        ) : (
          <Badge variant={item.ok === false ? "destructive" : "success"}>
            {item.ok === false ? "failed" : "done"}
          </Badge>
        )}
        {item.permission && <PermissionBadge permission={item.permission} />}
      </div>
      <div className="px-3 py-2">{children}</div>
      {item.subagent && item.subagent.length > 0 && (
        <div className="border-t border-border/70 px-3 py-2">
          <NestedItems items={item.subagent} />
        </div>
      )}
    </div>
  );
}
