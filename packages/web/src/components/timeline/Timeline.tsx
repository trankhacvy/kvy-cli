"use client";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import type { RenderItem } from "@/sync/reducer";
import { MessagesSquare } from "lucide-react";
import { RenderItemGroups } from "./RenderItemGroups";
import {
  getVisibleTranscriptItems,
  shouldShowTranscriptWorking,
} from "./transcript-view";

/** Stick-to-bottom threshold: scrolling more than half a viewport away from
 * the bottom pauses following; coming back within that band resumes it. */
export function isNearBottom(
  distanceFromBottom: number,
  viewportHeight: number,
): boolean {
  return distanceFromBottom < viewportHeight * 0.5;
}

/** Whether the in-timeline "Working…" activity row should render.
 * Suppressed when the last item is itself a running tool card — that card
 * already carries its own in-progress affordance. */
export function shouldShowActivityRow(
  working: boolean,
  items: RenderItem[],
): boolean {
  return shouldShowTranscriptWorking(working, items);
}

function isAnchorItem(item: RenderItem): boolean {
  return item.kind === "text" && !item.thinking && item.role === "user";
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
  const visibleItems = getVisibleTranscriptItems(items);

  if (visibleItems.length === 0) {
    return (
      <Conversation>
        <ConversationContent className="size-full">
          <ConversationEmptyState
            title="No messages yet"
            description="Messages from the CLI and the web composer appear here."
            icon={<MessagesSquare className="size-5" aria-hidden="true" />}
          />
        </ConversationContent>
      </Conversation>
    );
  }

  return (
    <Conversation
      className="min-h-0 flex-1 px-4"
      initial={
        isAnchorItem(items[items.length - 1] ?? items[0]!)
          ? "smooth"
          : "instant"
      }
    >
      <ConversationContent className="gap-6 px-0 py-5 sm:px-2">
        {hasMore && (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onLoadEarlier}
              disabled={isLoadingMore}
            >
              {isLoadingMore ? "Loading earlier messages…" : "Load earlier"}
            </Button>
          </div>
        )}
        <RenderItemGroups items={visibleItems} />
        {shouldShowActivityRow(working, visibleItems) && (
          <div className="pl-1 text-sm text-muted-foreground">
            <Shimmer duration={1.4}>Working…</Shimmer>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
