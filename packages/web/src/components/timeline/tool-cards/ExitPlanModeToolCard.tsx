import { ClipboardList } from "lucide-react";
import { parseExitPlanModeArgs } from "@/lib/tool-args";
import type { ToolItem } from "@/sync/reducer";
import { Markdown } from "../Markdown";
import { ToolCardShell } from "./ToolCardShell";

/** `ExitPlanMode` presents a plan for approval — render its markdown body
 * nicely instead of falling to the generic JSON fallback. `ToolCardShell`
 * already renders the pending-decision Allow/Deny row
 * generically whenever `item.permission.decision` is undefined, so this
 * card only needs to supply the plan body. */
export function ExitPlanModeToolCard({ item }: { item: ToolItem }) {
  const { plan } = parseExitPlanModeArgs(item.args);

  return (
    <ToolCardShell item={item} icon={<ClipboardList className="size-4 text-muted-foreground" />}>
      {plan ? (
        <Markdown md={plan} />
      ) : (
        <p className="text-xs text-muted-foreground">No plan text recorded.</p>
      )}
    </ToolCardShell>
  );
}
