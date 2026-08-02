import type { RenderItem } from "@/sync/reducer";
import { FileAttachment } from "./FileAttachment";
import { MessageText } from "./MessageText";
import { OrphanToolEnd } from "./OrphanToolEnd";
import { PermPlaceholder } from "./PermPlaceholder";
import { PlanChecklist } from "./PlanChecklist";
import { ServiceLine } from "./ServiceLine";
import { SubagentGroup } from "./SubagentGroup";
import { ToolCard } from "./tool-cards/registry";
import { UsageChip } from "./UsageChip";

/** Dispatches a single `RenderItem` to its component by `kind`. The `never` default is a
 * compile-time guarantee that a future variant can't silently render nothing. */
export function TimelineRow({ item }: { item: RenderItem }) {
  switch (item.kind) {
    case "text":
      return <MessageText item={item} />;

    case "service":
      return <ServiceLine label={item.text} tone="muted" />;

    case "file":
      return <FileAttachment item={item} />;

    case "turn-start":
      return <ServiceLine label={null} />;

    case "turn-end":
      return item.status === "completed" ? (
        <ServiceLine label={null} />
      ) : (
        <ServiceLine
          label={item.status === "failed" ? "Turn failed" : "Turn cancelled"}
          tone={item.status === "failed" ? "error" : "warning"}
        />
      );

    case "mode-switch":
      return (
        <ServiceLine label={`Switched to ${item.control} mode (by ${item.by})`} tone="muted" />
      );

    case "permission-mode":
      return <ServiceLine label={`Permission mode: ${item.mode} (${item.source})`} tone="muted" />;

    case "sub-start":
      return <ServiceLine label={null} />;

    case "sub-stop":
      return <ServiceLine label={null} />;

    case "usage":
      return <UsageChip item={item} />;

    case "plan":
      return <PlanChecklist item={item} />;

    case "perm-placeholder":
      return <PermPlaceholder item={item} />;

    case "tool":
      return <ToolCard item={item} />;

    case "orphan-tool-end":
      return <OrphanToolEnd item={item} />;

    case "subagent-group":
      // Dispatched one `RenderItem` at a time with no sibling context, so
      // (unlike `RenderItemGroups`, the actual caller for this kind — see
      // `Timeline.tsx`) there's no ordinal to compute here. Falls back to a
      // generic label rather than fabricating a number or leaking the
      // internal `subagentId` (Issue #8 — docs/bug-fix-plan.md #8).
      return <SubagentGroup label="Subagent" items={item.items} />;

    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}
