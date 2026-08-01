import { ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanItem } from "@/sync/reducer";

export function PlanChecklist({ item }: { item: PlanItem }) {
  if (item.steps.length === 0) return null;

  return (
    <div className="w-full max-w-full overflow-hidden rounded-md border border-border bg-card/60 p-3 text-sm">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <ListChecks className="size-4" />
        Plan
      </div>
      <ul className="flex flex-col gap-1.5">
        {item.steps.map((step, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps have no stable id and the whole list is replaced wholesale each update (never reordered), same reasoning as RenderItemGroups.tsx's index-suffixed keys.
          <li key={`${index}:${step.text}`} className="flex items-start gap-2">
            <span
              className={cn(
                "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
                step.status === "completed"
                  ? "border-emerald-500 bg-emerald-500/20"
                  : step.status === "in_progress"
                    ? "border-amber-500 bg-amber-500/20"
                    : "border-muted-foreground/40",
              )}
            />
            <span
              className={cn(
                step.status === "completed" && "text-muted-foreground line-through",
                step.status === "in_progress" && "font-medium",
              )}
            >
              {step.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
