import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { MACHINE_STATUS_META } from "../status";
import type { SessionListMachine } from "../types";

export function MachineBadge({ machine }: { machine: SessionListMachine }) {
  const meta = MACHINE_STATUS_META[machine.status];
  return (
    <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", meta.dotClassName)} title={meta.label} />
      {machine.name === null ? <Skeleton className="h-3 w-16" /> : machine.name}
    </Badge>
  );
}
