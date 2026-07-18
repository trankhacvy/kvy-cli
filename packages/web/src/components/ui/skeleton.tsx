import type * as React from "react";

import { cn } from "@/lib/utils";

/** Standard shadcn skeleton primitive — a pulsing placeholder block used for
 * Home/timeline initial-load states (plan-v2.md W4.2 "skeletons for Home/
 * timeline initial loads"). Purely presentational: callers compose it into
 * whatever shape (rows, lines, avatars) the loading screen needs. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  );
}

export { Skeleton };
