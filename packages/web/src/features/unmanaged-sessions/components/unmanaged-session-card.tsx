"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelativeTime, MachineBadge, type SessionListMachine } from "@/features/session-list";
import { cn } from "@/lib/utils";
import type { UnmanagedSessionItem, UseUnmanagedActions } from "../types";
import { TakeOverDialog } from "./take-over-dialog";

/**
 * `useActions` is called here rather than by the parent (`UnmanagedSection`)
 * because it's a hook: calling it per card instance satisfies the Rules of
 * Hooks, whereas calling it inside `.map()` in the parent's render body would not.
 */
export function UnmanagedSessionCard({
  session,
  machine,
  useActions,
  actionsDisabled = false,
}: {
  session: UnmanagedSessionItem;
  machine: SessionListMachine | null;
  useActions: UseUnmanagedActions;
  /** True when `useActions` is still mock-backed against real session data -
   * actions are greyed out so a mock silently succeeding against a real
   * daemon-owned row is not possible. Default `false` keeps test call sites interactive. */
  actionsDisabled?: boolean;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const actions = useActions(session.machineId);

  return (
    <Card className="gap-2 py-3 transition-colors hover:bg-accent/50">
      <CardHeader className="flex-row items-center gap-2 px-3">
        <span
          className="relative inline-flex size-2.5 shrink-0"
          title={session.running ? "Running" : "Idle"}
        >
          {session.running && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
          )}
          <span
            className={cn(
              "relative inline-flex size-2.5 rounded-full",
              session.running ? "bg-emerald-500" : "bg-muted-foreground/50",
            )}
          />
        </span>
        <CardTitle className="min-w-0 flex-1 truncate">{session.title}</CardTitle>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatRelativeTime(session.lastActivityAt)}
        </span>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2 px-3">
        <Badge variant="outline" className="font-normal text-muted-foreground">
          Unmanaged
        </Badge>
        {machine && <MachineBadge machine={machine} />}
        <div className="ml-auto flex gap-1.5">
          {actionsDisabled ? (
            <Button size="sm" variant="outline" disabled title="Live viewing isn't wired up yet">
              View
            </Button>
          ) : (
            <Button asChild size="sm" variant="outline">
              <Link href={`/dashboard/session/unmanaged/${session.id}/`}>View</Link>
            </Button>
          )}
          <Button
            size="sm"
            disabled={actionsDisabled}
            title={actionsDisabled ? "Adoption isn't wired up yet" : undefined}
            onClick={() => setDialogOpen(true)}
          >
            Take over
          </Button>
        </div>
      </CardContent>

      {!actionsDisabled && (
        <TakeOverDialog
          session={session}
          actions={actions}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
    </Card>
  );
}
