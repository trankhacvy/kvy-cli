"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { RenderItem } from "@/sync/reducer";
import { TimelineRow } from "./TimelineRow";

/** Virtualized session timeline root (falcon-system-design.md §9.2 "Session"
 * row: "`Timeline` (virtualized)"). Takes the reducer's `RenderItem[]`
 * output directly — read-only, no composer/permission-actions/control bar
 * (those are Phase 2, plan.md §8.4).
 *
 * Items vary a lot in height (a one-line service marker vs. a Bash card
 * with megabytes of stdout), so this uses `@tanstack/react-virtual`'s
 * dynamic-size mode (`measureElement`) rather than a fixed row height. */
export function Timeline({ items }: { items: RenderItem[] }) {
  const parentRef = useRef<HTMLDivElement>(null);

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

  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        No messages yet.
      </div>
    );
  }

  return (
    <div ref={parentRef} className="relative flex-1 overflow-y-auto px-4 py-4">
      <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          if (!item) return null;

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
            >
              <TimelineRow item={item} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
