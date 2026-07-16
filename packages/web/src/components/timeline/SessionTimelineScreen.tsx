"use client";

import { demoRenderItems } from "./demo-items";
import { Timeline } from "./Timeline";

/**
 * Read-only session timeline screen (falcon-system-design.md §9.2 "Session"
 * row, falcon-prd.md FR-7.2). Renders the reducer's `RenderItem[]` output as
 * a structured chat transcript — the composer, permission-approval actions,
 * and control bar (interrupt/mode-selector/take-control) are Phase 2
 * (plan.md §8.4); this screen only displays what already happened.
 *
 * `sessionId` is threaded through today only for the header label. Wiring
 * this screen to *live* per-session data is the sync engine's job (plan.md
 * §8.1, a separate in-flight task) — until it lands, `demoRenderItems`
 * stands in so the screen is reviewable end-to-end. Swapping the data
 * source is the only change that wiring needs to make here.
 */
export function SessionTimelineScreen({ sessionId }: { sessionId: string }) {
  const items = demoRenderItems;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-medium">Session {sessionId}</p>
          <p className="text-xs text-muted-foreground">Read-only timeline</p>
        </div>
      </header>
      <Timeline items={items} />
    </div>
  );
}
