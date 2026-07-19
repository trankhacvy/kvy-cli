"use client";

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { formatHourDividerLabel, shouldShowHourDivider } from "@/lib/format";
import type { RenderItem } from "@/sync/reducer";
import { HourDivider } from "./HourDivider";
import { TimelineRow } from "./TimelineRow";

/** Stick-to-bottom threshold: scrolling more than half a viewport away from
 * the bottom pauses following; coming back within that band resumes it. */
export function isNearBottom(distanceFromBottom: number, viewportHeight: number): boolean {
  return distanceFromBottom < viewportHeight * 0.5;
}

/** Whether the in-timeline "Working…" activity row should render.
 * Suppressed when the last item is itself a running tool card — that card
 * already carries its own in-progress affordance. */
export function shouldShowActivityRow(working: boolean, items: RenderItem[]): boolean {
  if (!working || items.length === 0) return false;
  const last = items[items.length - 1];
  if (last && last.kind === "tool" && last.status === "running") return false;
  return true;
}

function isAnchorItem(item: RenderItem): boolean {
  return item.kind === "text" && !item.thinking && item.role === "user";
}

function getItemId(item: RenderItem): string {
  return `${item.id}:${item.kind}`;
}

export function Timeline({
  items,
  working = false,
  hasMore = false,
  isLoadingMore = false,
  onLoadEarlier,
}: {
  items: RenderItem[];
  working?: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadEarlier?: () => void;
}) {
  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        No messages yet.
      </div>
    );
  }

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
      <MessageScroller className="flex-1 px-4">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-3">
            {hasMore && (
              <div className="flex justify-center pb-3">
                <button
                  type="button"
                  onClick={onLoadEarlier}
                  disabled={isLoadingMore}
                  className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted disabled:cursor-wait disabled:opacity-70"
                >
                  {isLoadingMore ? "Loading…" : "Load earlier"}
                </button>
              </div>
            )}
            {items.map((item, index) => {
              const previous = items[index - 1];
              return (
                <MessageScrollerItem
                  key={getItemId(item)}
                  messageId={getItemId(item)}
                  scrollAnchor={isAnchorItem(item)}
                >
                  {shouldShowHourDivider(previous?.time, item.time) && (
                    <HourDivider label={formatHourDividerLabel(item.time)} />
                  )}
                  <TimelineRow item={item} />
                </MessageScrollerItem>
              );
            })}
            {shouldShowActivityRow(working, items) && (
              <div className="flex items-center gap-2 px-1 pt-1 text-xs text-muted-foreground">
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
                Working…
              </div>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
