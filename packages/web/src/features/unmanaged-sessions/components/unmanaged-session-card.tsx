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

/** One unmanaged (plain claude/codex) session row (falcon-system-design.md
 * §9.2 "Home" row: `UnmanagedSection`; §11/§10.4 UC9). Mirrors
 * `features/session-list`'s `SessionCard` layout/spacing so both sections
 * read as one family of cards, distinguished by the "Unmanaged" badge and
 * the mirror/take-over actions in place of a status dot (there's no reduced
 * transcript to derive one from — this session was never Falcon-managed).
 *
 * `useActions` is called here, not by the caller (`UnmanagedSection`),
 * because it's a hook: each card is its own component instance, so calling
 * it once at this component's top level — one instance per rendered card —
 * satisfies the Rules of Hooks, where calling it from inside `.map()` in
 * the parent's own render body would not. */
export function UnmanagedSessionCard({
  session,
  machine,
  useActions,
}: {
  session: UnmanagedSessionItem;
  machine: SessionListMachine | null;
  useActions: UseUnmanagedActions;
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
          <Button asChild size="sm" variant="outline">
            <Link href={`/session/unmanaged/${session.id}/`}>View</Link>
          </Button>
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            Take over
          </Button>
        </div>
      </CardContent>

      <TakeOverDialog
        session={session}
        actions={actions}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </Card>
  );
}
