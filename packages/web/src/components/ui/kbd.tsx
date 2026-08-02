"use client";

import type * as React from "react";
import { cn } from "@/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-fit items-center justify-center gap-0.5 rounded-[calc(var(--radius)-5px)] border border-input bg-muted px-1.5 font-mono text-[0.85em] font-medium text-foreground whitespace-nowrap",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
