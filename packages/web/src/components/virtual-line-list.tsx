"use client";

import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * The house windowing primitive for long, fixed-row-height lists — the
 * file viewer's lines and the diff viewer's hunk lines (Feature 3, docs/
 * web-ux-improvements-plan.md Phase 3).
 *
 * `@tanstack/react-virtual` (not a hand-rolled windowing pass) for the same
 * reason `@tanstack/react-query` owns caching here: it is headless, it has
 * no styling opinions to fight with Tailwind, and one well-tested primitive
 * beats several near-identical hand-rolled ones. Rows are a FIXED height on
 * purpose — every consumer renders `font-mono text-xs leading-5` (20px), so
 * `estimateSize` is exact and no dynamic measurement is needed.
 *
 * Fixed-height rows mean lines must NOT wrap — consumers use
 * `whitespace-pre` + horizontal scroll instead of the old
 * `whitespace-pre-wrap break-all`, a real, visible behaviour change accepted
 * as the price of this primitive (see the plan's own rollout notes).
 *
 * `visibleRange` is exposed so a caller can restrict expensive per-row work
 * (shiki tokenization) to only the rows actually on screen (Feature 3 Phase
 * 2's cheaper interim to a dedicated worker — see `use-viewport-tokens.ts`).
 */
export function VirtualLineList({
  count,
  rowHeight = 20,
  overscan = 24,
  renderRow,
  onVisibleRangeChange,
  className,
}: {
  count: number;
  rowHeight?: number;
  overscan?: number;
  renderRow: (index: number) => ReactNode;
  /** Called with the currently-rendered (including overscan) index range after every virtualizer recompute — `null` when `count` is 0. */
  onVisibleRangeChange?: (range: { start: number; end: number } | null) => void;
  className?: string;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  const items: VirtualItem[] = virtualizer.getVirtualItems();
  const first = items[0];
  const last = items[items.length - 1];
  const rangeStart = first?.index;
  const rangeEnd = last?.index;

  useEffect(() => {
    if (!onVisibleRangeChange) return;
    onVisibleRangeChange(
      rangeStart !== undefined && rangeEnd !== undefined
        ? { start: rangeStart, end: rangeEnd }
        : null,
    );
  }, [onVisibleRangeChange, rangeStart, rangeEnd]);

  return (
    <div ref={parentRef} className={className} style={{ overflow: "auto" }}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
        {items.map((item) => (
          <div
            key={item.key}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: `${item.size}px`,
              transform: `translateY(${item.start}px)`,
            }}
          >
            {renderRow(item.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
