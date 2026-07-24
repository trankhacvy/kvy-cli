import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { MACHINE_STATUS_META } from "../status";
import type { SessionListMachine } from "../types";

/** Machine online/offline/needs-reauth indicator (design §9.2 "Home" row:
 * "machine badges"; falcon-prd.md FR-7.1 "machine online/offline
 * indicators"; AH8 "machine-status-reauth", docs/auth-ux-hardening-plan.md
 * item 8 — "Needs re-authentication" renders as its own amber chip, never
 * collapsed into the same grey "Offline" a powered-off machine shows). */
export function MachineBadge({ machine }: { machine: SessionListMachine }) {
  const meta = MACHINE_STATUS_META[machine.status];
  return (
    <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", meta.dotClassName)} title={meta.label} />
      {machine.name === null ? <Skeleton className="h-3 w-16" /> : machine.name}
    </Badge>
  );
}
