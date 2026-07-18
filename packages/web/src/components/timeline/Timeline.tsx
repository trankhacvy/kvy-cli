"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import { formatFullTimestamp, formatHourDividerLabel, shouldShowHourDivider } from "@/lib/format";
import type { RenderItem } from "@/sync/reducer";
import { HourDivider } from "./HourDivider";
import { TimelineRow } from "./TimelineRow";

/** Stick-to-bottom threshold (the AI Elements `Conversation` pattern):
 * scrolling more than half a viewport away from the bottom pauses
 * following; coming back within that band resumes it. Exported as a pure
 * function — no DOM/React involved — so it's unit-testable without a jsdom
 * component-render harness (this package's vitest config runs `.test.ts`
 * files under `environment: "node"` only; see `ThinkingBlock.tsx`'s
 * `thinkingBlockLabel` for the same extraction pattern). */
export function isNearBottom(distanceFromBottom: number, viewportHeight: number): boolean {
  return distanceFromBottom < viewportHeight * 0.5;
}

/** Whether the in-timeline "Working…" activity row (W1.8) should render.
 * Suppressed when the last item is itself a running tool card — that card
 * already carries its own in-progress affordance, so a second "Working…"
 * row directly under it would be redundant. */
export function shouldShowActivityRow(working: boolean, items: RenderItem[]): boolean {
  if (!working || items.length === 0) return false;
  const last = items[items.length - 1];
  if (last && last.kind === "tool" && last.status === "running") return false;
  return true;
}

/** Virtualized session timeline root (falcon-system-design.md §9.2 "Session"
 * row: "`Timeline` (virtualized)"). Takes the reducer's `RenderItem[]`
 * output directly — read-only, no composer/permission-actions/control bar
 * (those are Phase 2, plan.md §8.4).
 *
 * Items vary a lot in height (a one-line service marker vs. a Bash card
 * with megabytes of stdout), so this uses `@tanstack/react-virtual`'s
 * dynamic-size mode (`measureElement`) rather than a fixed row height.
 *
 * `working` (plan.md W1.6/W1.8) drives two things: auto-follow keeps the
 * tail visible while new items land, and a pulsing "Working…" row renders
 * below the list while a turn is in flight.
 *
 * `hasMore`/`isLoadingMore`/`onLoadEarlier` (plan-v2.md W4.2 "'Load earlier'
 * pagination") back a plain button pinned above the virtualized list, not a
 * scroll-triggered infinite-load — `useLiveRenderItems`'s
 * `hasMore`/`loadEarlier` pass `useInfiniteQuery`'s own
 * `hasNextPage`/`fetchNextPage` straight through. All three default to the
 * no-pagination case so every existing caller (tests, the demo fixture)
 * keeps working unchanged. */
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
  const parentRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 96,
    overscan: 8,
    getItemKey: (index) => {
      const item = items[index];
      return item ? `${item.id}:${item.kind}` : index;
    },
  });

  // Follow the tail while the user is at the bottom. `scrollToIndex(last,
  // {align:"end"})` can land slightly short on rows whose real height isn't
  // measured yet (a known react-virtual dynamic-measurement quirk — see
  // plan-v2.md's risk register #3); re-run it on the next frame to correct
  // for any measurement that resolved in between.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `virtualizer` is intentionally omitted — useVirtualizer returns a fresh object every render, so including it would re-fire this effect (and re-call scrollToIndex) on every parent re-render instead of only on real item-count/following changes. The effect still reads the latest `virtualizer` via closure.
  useEffect(() => {
    if (following && items.length > 0) {
      virtualizer.scrollToIndex(items.length - 1, { align: "end" });
      const raf = requestAnimationFrame(() => {
        virtualizer.scrollToIndex(items.length - 1, { align: "end" });
      });
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [items.length, following]);

  // Leaving the bottom (by >half a viewport) pauses following; returning resumes it.
  const onScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFollowing(isNearBottom(distanceFromBottom, el.clientHeight));
  };

  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        No messages yet.
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={parentRef} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-4">
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
        <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index];
            if (!item) return null;
            const previous = items[virtualRow.index - 1];

            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="pb-3"
                title={formatFullTimestamp(item.time)}
              >
                {shouldShowHourDivider(previous?.time, item.time) && (
                  <HourDivider label={formatHourDividerLabel(item.time)} />
                )}
                <TimelineRow item={item} />
              </div>
            );
          })}
        </div>
        {shouldShowActivityRow(working, items) && (
          <div className="flex items-center gap-2 px-1 pt-1 text-xs text-muted-foreground">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
            Working…
          </div>
        )}
      </div>
      {!following && (
        <button
          type="button"
          onClick={() => {
            setFollowing(true);
            virtualizer.scrollToIndex(items.length - 1, { align: "end" });
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs shadow-md hover:bg-muted"
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}
