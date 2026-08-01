"use client";

import { useState } from "react";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { cn } from "@/lib/utils";
import { Chevron } from "./icons";

/** Collapsed-vs-open label for the trigger. Once rendered, a thinking block
 * is always historical — the reducer only emits complete envelopes, so
 * there's no such thing as a "live" one here — hence the past-tense
 * collapsed label; the *live* "thinking now" signal belongs to the
 * in-timeline activity row (W1.8) instead (W1.7). */
export function thinkingBlockLabel(open: boolean): string {
  return open ? "Hide thinking" : "Thought process";
}

/** Collapsible thinking block (kvy-prd.md FR-7.2 "collapsible thinking").
 * Closed by default — thinking is reasoning detail, not the message. */
export function ThinkingBlock({ md, compact = false }: { md: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <Reasoning
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "mb-0 w-full rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-2",
        compact && "rounded-lg px-2.5 py-2",
      )}
    >
      <ReasoningTrigger className="gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <Chevron open={open} />
        <span className="italic">{thinkingBlockLabel(open)}</span>
      </ReasoningTrigger>
      <ReasoningContent
        className={cn(
          "mt-2 rounded-lg border border-border/60 bg-background/40 px-3 py-2 italic text-muted-foreground",
          compact && "text-xs",
        )}
      >
        {md}
      </ReasoningContent>
    </Reasoning>
  );
}
