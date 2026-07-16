import type { RenderItem } from "@/sync/reducer";
import { FileAttachment } from "./FileAttachment";
import { MessageText } from "./MessageText";
import { OrphanToolEnd } from "./OrphanToolEnd";
import { PermPlaceholder } from "./PermPlaceholder";
import { ServiceLine } from "./ServiceLine";
import { SubagentGroup } from "./SubagentGroup";
import { ToolCard } from "./tool-cards/registry";

/** Dispatches a single `RenderItem` to its component, by `kind` (the
 * reducer's discriminated union — falcon-system-design.md §9.1). Every kind
 * has a branch; the `never` check below is a compile-time guarantee that a
 * future `RenderItem` variant can't silently render nothing. */
export function TimelineRow({ item }: { item: RenderItem }) {
  switch (item.kind) {
    case "text":
      return <MessageText item={item} />;

    case "service":
      return <ServiceLine label={item.text} tone="muted" />;

    case "file":
      return <FileAttachment item={item} />;

    case "turn-start":
      return <ServiceLine label="Turn started" tone="hairline" />;

    case "turn-end":
      return (
        <ServiceLine
          label={
            item.status === "completed"
              ? "Turn completed"
              : item.status === "failed"
                ? "Turn failed"
                : "Turn cancelled"
          }
          tone={
            item.status === "completed" ? "muted" : item.status === "failed" ? "error" : "warning"
          }
        />
      );

    case "mode-switch":
      return (
        <ServiceLine label={`Switched to ${item.control} mode (by ${item.by})`} tone="muted" />
      );

    case "sub-start":
      return <ServiceLine label="Subagent started" tone="hairline" />;

    case "sub-stop":
      return <ServiceLine label="Subagent finished" tone="hairline" />;

    case "perm-placeholder":
      return <PermPlaceholder item={item} />;

    case "tool":
      return <ToolCard item={item} />;

    case "orphan-tool-end":
      return <OrphanToolEnd item={item} />;

    case "subagent-group":
      return <SubagentGroup id={item.subagentId} items={item.items} />;

    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}
