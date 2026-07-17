import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelativeTime } from "../format-relative-time";
import { deriveSessionStatus, SESSION_STATUS_META } from "../status";
import type { SessionListMachine, SessionListSession } from "../types";
import { MachineBadge } from "./machine-badge";
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
    <Link href={`/session/${session.id}/`} className="block">
      <Card className="gap-2 py-3 transition-colors hover:bg-accent/50">
        <CardHeader className="flex-row items-center gap-2 px-3">
          <SessionStatusDot status={status} />
          <CardTitle className="min-w-0 flex-1 truncate">{session.title}</CardTitle>
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
  );
}
