"use client";

import {
  Message,
  MessageContent,
  MessageResponse,
  MessageToolbar,
} from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import type {
  FileItem,
  OrphanToolEndItem,
  PermPlaceholderItem,
  RenderItem,
  TextItem,
  ToolItem,
} from "@/sync/reducer";
import { CopyButton } from "./CopyButton";
import { FileAttachment } from "./FileAttachment";
import { OrphanToolEnd } from "./OrphanToolEnd";
import { PermPlaceholder } from "./PermPlaceholder";
import { SubagentGroup } from "./SubagentGroup";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCard } from "./tool-cards/registry";
import { getVisibleTranscriptItems } from "./transcript-view";

type MessageGroupItem =
  | TextItem
  | FileItem
  | PermPlaceholderItem
  | ToolItem
  | OrphanToolEndItem;
type StandaloneGroupItem = Extract<RenderItem, { kind: "subagent-group" }>;

export interface MessageRenderGroup {
  kind: "message";
  id: string;
  time: number;
  role: RenderItem["role"];
  turn?: string;
  items: MessageGroupItem[];
}

export interface StandaloneRenderGroup {
  kind: "standalone";
  id: string;
  time: number;
  item: StandaloneGroupItem;
}

export type RenderGroup = MessageRenderGroup | StandaloneRenderGroup;

function isMessageGroupItem(item: RenderItem): item is MessageGroupItem {
  return (
    item.kind === "text" ||
    item.kind === "file" ||
    item.kind === "perm-placeholder" ||
    item.kind === "tool" ||
    item.kind === "orphan-tool-end"
  );
}

function isStandaloneGroupItem(item: RenderItem): item is StandaloneGroupItem {
  return item.kind === "subagent-group";
}

function canAppendToMessageGroup(
  group: MessageRenderGroup,
  item: MessageGroupItem,
): boolean {
  if (group.role !== item.role) return false;
  if (group.role === "user") return group.turn === item.turn;
  if (group.turn !== undefined || item.turn !== undefined)
    return group.turn === item.turn;
  return true;
}

export function groupRenderItems(items: RenderItem[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  const visibleItems = getVisibleTranscriptItems(items);

  for (const item of visibleItems) {
    if (!isMessageGroupItem(item)) {
      if (!isStandaloneGroupItem(item)) continue;
      groups.push({
        kind: "standalone",
        id: `${item.id}:${item.kind}`,
        time: item.time,
        item,
      });
      continue;
    }

    const previous = groups[groups.length - 1];
    if (
      previous?.kind === "message" &&
      canAppendToMessageGroup(previous, item)
    ) {
      previous.items.push(item);
      continue;
    }

    groups.push({
      kind: "message",
      id: `${item.id}:${item.kind}`,
      time: item.time,
      role: item.role,
      turn: item.turn,
      items: [item],
    });
  }

  return groups;
}

function getMessageCopyText(items: MessageGroupItem[]): string {
  return items
    .filter((item): item is TextItem => item.kind === "text" && !item.thinking)
    .map((item) => item.md.trim())
    .filter((item) => item.length > 0)
    .join("\n\n");
}

function MessageGroupView({
  group,
  compact = false,
}: {
  group: MessageRenderGroup;
  compact?: boolean;
}) {
  const from = group.role === "user" ? "user" : "assistant";
  const copyText =
    group.role === "agent" ? getMessageCopyText(group.items) : "";

  return (
    <Message from={from} className={cn("max-w-full gap-3", compact && "gap-2")}>
      <MessageContent
        className={cn(
          "w-full gap-3",
          group.role === "agent" ? "max-w-3xl" : "max-w-[min(85%,42rem)]",
          compact && "gap-2 text-[13px]",
        )}
      >
        {group.items.map((item) => (
          <MessageGroupPart
            key={`${item.id}:${item.kind}`}
            item={item}
            compact={compact}
          />
        ))}
      </MessageContent>
      {copyText.length > 0 && (
        <MessageToolbar
          className={cn("mt-0 w-fit justify-start", compact && "text-xs")}
        >
          <CopyButton getText={() => copyText} />
        </MessageToolbar>
      )}
    </Message>
  );
}

function MessageGroupPart({
  item,
  compact = false,
}: {
  item: MessageGroupItem;
  compact?: boolean;
}) {
  switch (item.kind) {
    case "text":
      return item.thinking ? (
        <ThinkingBlock md={item.md} compact={compact} />
      ) : (
        <MessageResponse
          className={cn("wrap-break-word", compact && "text-[13px]")}
        >
          {item.md}
        </MessageResponse>
      );

    case "file":
      return <FileAttachment item={item} compact={compact} />;

    case "perm-placeholder":
      return <PermPlaceholder item={item} />;

    case "tool":
      return <ToolCard item={item} />;

    case "orphan-tool-end":
      return <OrphanToolEnd item={item} />;
  }
}

export function RenderItemGroups({
  items,
  compact = false,
  emptyLabel = "No activity recorded.",
}: {
  items: RenderItem[];
  compact?: boolean;
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const groups = groupRenderItems(items);

  return (
    <div className={cn("flex flex-col gap-5", compact && "gap-3")}>
      {groups.map((group) =>
        group.kind === "message" ? (
          <MessageGroupView key={group.id} group={group} compact={compact} />
        ) : (
          <SubagentGroup
            key={group.id}
            id={group.item.subagentId}
            items={group.item.items}
            compact={compact}
          />
        ),
      )}
    </div>
  );
}
