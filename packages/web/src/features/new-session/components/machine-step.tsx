"use client";

import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getFavoriteMachineId, setFavoriteMachineId } from "../favorites";
import type { NewSessionMachine } from "../types";

/**
 * Step 1: pick a paired machine to spawn on (falcon-prd.md UC5 "pick
 * machine"). Offline machines are shown but disabled — a session can't
 * spawn on a daemon that isn't connected.
 *
 * Each row also carries a star toggle (docs/competitive-notes-omnara.md #22
 * "Favorite/star a default machine, provider, and model"): starring a
 * machine here is what `new-session-screen.tsx` reads back
 * (`getFavoriteMachineId`) to pre-select it once the machine list loads on a
 * later visit. Purely a per-device `localStorage` convenience
 * (`../favorites.ts`) — never blocks or reorders the list, so an offline
 * favorite still shows disabled like any other offline machine.
 */
export function MachineStep({
  machines,
  selectedId,
  onSelect,
}: {
  machines: NewSessionMachine[];
  selectedId: string | null;
  onSelect: (machineId: string) => void;
}) {
  // This step is part of the wizard's very first (server-rendered) paint,
  // so the star's initial state can't read `localStorage` synchronously in
  // the `useState` initializer the way `OptionsStep`'s later-mounting stars
  // safely do — Next SSRs this route with no `window`, so an initializer
  // that resolves truthfully on the client immediately diverges from the
  // server-rendered markup ("attributes ... didn't match ... won't be
  // patched up", since React doesn't re-reconcile attribute mismatches from
  // hydration alone). Starting from `null` (matching what the server always
  // renders) and only reading the real value in a post-mount effect avoids
  // the mismatch entirely — same pattern `new-session-screen.tsx`'s own
  // starred-machine preselect effect already uses.
  const [favoriteId, setFavoriteIdState] = useState<string | null>(null);
  useEffect(() => {
    setFavoriteIdState(getFavoriteMachineId());
  }, []);

  function toggleFavorite(machineId: string) {
    const next = favoriteId === machineId ? null : machineId;
    setFavoriteMachineId(next);
    setFavoriteIdState(next);
  }

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
        const favorite = machine.id === favoriteId;
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
            <span className="flex items-center gap-1">
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {machine.online ? "online" : "offline"}
              </Badge>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                title={favorite ? "Unstar as default machine" : "Star as default machine"}
                aria-label={favorite ? "Unstar as default machine" : "Star as default machine"}
                aria-pressed={favorite}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFavorite(machine.id);
                }}
                onKeyDown={(e) => {
                  // Stop Enter/Space from also bubbling to the Card's own
                  // `onKeyDown`, which would select the machine in addition
                  // to toggling the star — same reasoning as this button's
                  // `onClick` stopping propagation to the Card's `onClick`.
                  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
                }}
              >
                <Star
                  className={cn(
                    "size-4",
                    favorite ? "fill-amber-400 text-amber-400" : "text-muted-foreground",
                  )}
                />
              </Button>
            </span>
          </Card>
        );
      })}
    </div>
  );
}
