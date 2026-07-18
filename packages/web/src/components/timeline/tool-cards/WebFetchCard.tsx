import { Globe } from "lucide-react";
import { parseWebFetchArgs } from "@/lib/tool-args";
import type { ToolItem } from "@/sync/reducer";
import { JsonBlock } from "../JsonBlock";
import { ToolCardShell } from "./ToolCardShell";

/** `WebFetch`: url + prompt, then the fetched/summarized result — reuses
 * `JsonBlock`'s own collapse-behind-"Show all" behavior for the (often long)
 * result text rather than a bespoke `Collapsible` (plan-v2.md W3.1's
 * "collapsible result"). */
export function WebFetchCard({ item }: { item: ToolItem }) {
  const args = parseWebFetchArgs(item.args);

  return (
    <ToolCardShell item={item} icon={<Globe className="size-4 text-muted-foreground" />}>
      <p className="truncate font-mono text-xs text-muted-foreground">
        {args.url ?? "(no url captured)"}
      </p>
      {args.prompt && <p className="mt-1 text-xs">{args.prompt}</p>}
      {item.output !== undefined && <JsonBlock value={item.output} className="mt-1.5" />}
    </ToolCardShell>
  );
}
