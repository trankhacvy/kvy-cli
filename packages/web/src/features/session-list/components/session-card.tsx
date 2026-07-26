import { Pin } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "../format-relative-time";
import { deriveSessionStatus, SESSION_STATUS_META } from "../status";
import type { SessionListMachine, SessionListSession } from "../types";
import { MachineBadge } from "./machine-badge";
import { SessionCardActions } from "./session-card-actions";
import { SessionStatusDot } from "./status-dot";

export function SessionCard({
  session,
  machine,
}: {
  session: SessionListSession;
  machine: SessionListMachine | null;
}) {
  const status = deriveSessionStatus({
    status: session.status,
    machineOnline: machine?.online ?? null,
    items: session.items,
    attention: session.attention,
  });
  const meta = SESSION_STATUS_META[status];

  return (
    // `SessionCardActions` is a sibling of the navigating `Link`, not nested
    // inside it — its `<button>`s would otherwise be interactive elements
    // nested inside an `<a>`, which is both invalid HTML and would need a
    // stopPropagation dance to keep a click from also navigating.
    <div className="group relative">
      <Link href={`/dashboard/session/${session.id}/`} className="block">
        <Card className="gap-2 py-3 pr-10 transition-colors hover:bg-accent/50">
          <CardHeader className="flex-row items-center gap-2 px-3">
            <SessionStatusDot status={status} />
            {session.pinned && (
              <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label="Pinned" />
            )}
            <CardTitle className="min-w-0 flex-1 truncate">
              {session.title === null ? <Skeleton className="h-4 w-32" /> : session.title}
            </CardTitle>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatRelativeTime(session.updatedAt)}
            </span>
          </CardHeader>
          <CardContent className="flex items-center gap-2 px-3">
            <Badge variant="secondary" className="font-normal capitalize">
              {session.provider}
            </Badge>
            <span className="text-xs text-muted-foreground">{meta.label}</span>
            {machine && <MachineBadge machine={machine} />}
          </CardContent>
        </Card>
      </Link>
      <div className="absolute right-3 top-3 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <SessionCardActions
          sessionId={session.id}
          title={session.title ?? "this session"}
          pinned={session.pinned}
          status={session.status}
          machineId={session.machineId}
          machineOnline={machine?.online ?? false}
          machineName={machine?.name ?? null}
        />
      </div>
    </div>
  );
}
