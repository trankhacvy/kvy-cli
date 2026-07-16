"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { NewSessionMachine } from "../types";

/** Step 1: pick a paired machine to spawn on (falcon-prd.md UC5 "pick machine"). Offline machines are shown but disabled — a session can't spawn on a daemon that isn't connected. */
export function MachineStep({
  machines,
  selectedId,
  onSelect,
}: {
  machines: NewSessionMachine[];
  selectedId: string | null;
  onSelect: (machineId: string) => void;
}) {
  if (machines.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No paired machines yet. Run <code className="rounded bg-muted px-1 py-0.5">falcon</code> on
        a machine to pair it.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {machines.map((machine) => {
        const selected = machine.id === selectedId;
        return (
          <Card
            key={machine.id}
            role="button"
            tabIndex={machine.online ? 0 : -1}
            aria-disabled={!machine.online}
            onClick={() => machine.online && onSelect(machine.id)}
            onKeyDown={(e) => {
              if (machine.online && (e.key === "Enter" || e.key === " ")) onSelect(machine.id);
            }}
            className={cn(
              "flex-row items-center justify-between px-4 py-3",
              machine.online ? "cursor-pointer hover:bg-accent" : "cursor-not-allowed opacity-50",
              selected && "border-primary ring-1 ring-primary",
            )}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <span
                className={cn(
                  "size-2 rounded-full",
                  machine.online ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
              />
              {machine.name}
            </span>
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {machine.online ? "online" : "offline"}
            </Badge>
          </Card>
        );
      })}
    </div>
  );
}
