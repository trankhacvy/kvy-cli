"use client";

import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Chevron } from "./icons";
import { Markdown } from "./Markdown";

/** Collapsed-vs-open label for the trigger. Once rendered, a thinking block
 * is always historical — the reducer only emits complete envelopes, so
 * there's no such thing as a "live" one here — hence the past-tense
 * collapsed label; the *live* "thinking now" signal belongs to the
 * in-timeline activity row (W1.8) instead (W1.7). */
export function thinkingBlockLabel(open: boolean): string {
  return open ? "Hide thinking" : "Thought process";
}

/** Collapsible thinking block (falcon-prd.md FR-7.2 "collapsible thinking").
 * Closed by default — thinking is reasoning detail, not the message. */
export function ThinkingBlock({ md }: { md: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-[85%]">
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <Chevron open={open} />
        <span className="italic">{thinkingBlockLabel(open)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 rounded-lg border border-dashed border-border/70 bg-muted/30 px-3 py-2 text-muted-foreground italic [&_.markdown-body]:text-xs">
        <Markdown md={md} />
      </CollapsibleContent>
    </Collapsible>
  );
}
