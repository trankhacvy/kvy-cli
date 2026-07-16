import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** Rotates a chevron open/closed — shared by every collapsible in the timeline. */
export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRight
      className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90", className)}
    />
  );
}
