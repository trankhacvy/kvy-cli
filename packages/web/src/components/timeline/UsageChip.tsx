import { ArrowDown, ArrowUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatTokenCount } from "@/lib/format";
import type { UsageItem } from "@/sync/reducer";

/**
 * Per-turn token-usage chip. `costUsd` renders alongside when a future
 * adapter supplies it; no provider does yet, so it's normally absent.
 */
export function UsageChip({ item }: { item: UsageItem }) {
  return (
    <div className="flex items-center justify-center py-1">
      <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
        <ArrowUp className="size-3" />
        {formatTokenCount(item.inputTokens)}
        <ArrowDown className="size-3" />
        {formatTokenCount(item.outputTokens)}
        {item.costUsd !== undefined ? <span>· ${item.costUsd.toFixed(4)}</span> : null}
      </Badge>
    </div>
  );
}
