import { Plug } from "lucide-react";
import type { ToolItem } from "@/sync/reducer";
import { JsonBlock } from "../JsonBlock";
import { ToolCardShell } from "./ToolCardShell";

/** Fallback card for MCP tools (`mcp__server__tool`) and anything else the
 * registry doesn't have a dedicated card for — always shows the raw
 * args/output (design principle: unknown shapes are shown, never hidden). */
export function McpGenericCard({ item }: { item: ToolItem }) {
  return (
    <ToolCardShell item={item} icon={<Plug className="size-4 text-muted-foreground" />}>
      <p className="font-mono text-xs text-muted-foreground">{item.name}</p>
      {item.args !== undefined && <JsonBlock value={item.args} className="mt-1.5" />}
      {item.output !== undefined && <JsonBlock value={item.output} className="mt-1.5" />}
    </ToolCardShell>
  );
}
