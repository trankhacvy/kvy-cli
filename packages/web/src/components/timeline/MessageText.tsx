import { cn } from "@/lib/utils";
import type { TextItem } from "@/sync/reducer";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

/** A `text` render item: either a normal chat bubble or (when `thinking`) a
 * collapsible reasoning block (falcon-prd.md FR-7.2). */
export function MessageText({ item }: { item: TextItem }) {
  if (item.thinking) {
    return <ThinkingBlock md={item.md} />;
  }

  const isUser = item.role === "user";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-4 py-2.5",
          isUser
            ? "bg-primary text-primary-foreground [&_.markdown-body]:text-primary-foreground"
            : "border border-border bg-card",
        )}
      >
        <Markdown md={item.md} />
      </div>
    </div>
  );
}
