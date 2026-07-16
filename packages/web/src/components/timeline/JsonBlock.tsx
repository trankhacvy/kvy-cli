"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Pretty-printed fallback viewer for any `args`/`output` value a specific
 * `ToolCard` didn't have a dedicated field for (design principle: unknown
 * shapes are shown raw, never hidden). Long values collapse behind a
 * "Show all" toggle so one giant tool output can't push the rest of the
 * transcript off screen.
 */
export function JsonBlock({
  value,
  className,
  collapsedLines = 8,
}: {
  value: unknown;
  className?: string;
  collapsedLines?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = stringify(value);
  if (text === undefined) return null;

  const lines = text.split("\n");
  const isLong = lines.length > collapsedLines;
  const shown = expanded || !isLong ? text : lines.slice(0, collapsedLines).join("\n");

  return (
    <div className={className}>
      <pre className="overflow-x-auto rounded-md bg-muted/50 px-2.5 py-2 font-mono text-xs text-muted-foreground">
        <code>
          {shown}
          {isLong && !expanded ? "\n…" : ""}
        </code>
      </pre>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn("mt-1 text-xs text-muted-foreground hover:text-foreground hover:underline")}
        >
          {expanded ? "Show less" : `Show all (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
}

function stringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
