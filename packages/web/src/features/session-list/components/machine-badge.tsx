import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { SessionListMachine } from "../types";

/** Machine online/offline indicator (design §9.2 "Home" row: "machine
 * badges"; falcon-prd.md FR-7.1 "machine online/offline indicators"). */
export function MachineBadge({ machine }: { machine: SessionListMachine }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
      <span
        className={cn(
          "size-1.5 rounded-full",
          machine.online ? "bg-emerald-500" : "bg-muted-foreground/40",
        )}
      />
      {machine.name === null ? <Skeleton className="h-3 w-16" /> : machine.name}
    </Badge>
  );
}
