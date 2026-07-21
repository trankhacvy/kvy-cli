import type { RenderItem, TextItem } from "@/sync/reducer";

function hasVisibleTextContent(item: TextItem): boolean {
  return item.md.trim().length > 0;
}

function isHiddenTimelineItem(item: RenderItem): boolean {
  return (
    item.kind === "service" ||
    item.kind === "turn-start" ||
    item.kind === "turn-end" ||
    item.kind === "mode-switch" ||
    item.kind === "permission-mode" ||
    item.kind === "sub-start" ||
    item.kind === "sub-stop" ||
    item.kind === "usage"
  );
}

export function getVisibleTranscriptItems(items: RenderItem[]): RenderItem[] {
  const visibleItems: RenderItem[] = [];

  for (const item of items) {
    if (isHiddenTimelineItem(item)) continue;

    if (item.kind === "text" && !hasVisibleTextContent(item)) continue;

    if (item.kind === "subagent-group") {
      const nestedItems = getVisibleTranscriptItems(item.items);
      if (nestedItems.length === 0) continue;
      visibleItems.push({ ...item, items: nestedItems });
      continue;
    }

    visibleItems.push(item);
  }

  return visibleItems;
}

function hasVisibleAgentReplyAfterLatestUser(items: RenderItem[]): boolean {
  let lastUserIndex = -1;

  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.role === "user") {
      lastUserIndex = index;
    }
  }

  const candidateItems = lastUserIndex >= 0 ? items.slice(lastUserIndex + 1) : items;
  return candidateItems.some((item) => item.role === "agent");
}

export function shouldShowTranscriptWorking(working: boolean, items: RenderItem[]): boolean {
  if (!working) return false;

  const visibleItems = getVisibleTranscriptItems(items);
  if (visibleItems.length === 0) return false;

  return !hasVisibleAgentReplyAfterLatestUser(visibleItems);
}

export function hasVisibleTranscriptItems(items: RenderItem[]): boolean {
  return getVisibleTranscriptItems(items).length > 0;
}
