import { Pin } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { deriveFallbackTitle } from "../derive-fallback-title";
import { formatRelativeTime } from "../format-relative-time";
import { deriveSessionStatus, SESSION_STATUS_META } from "../status";
import type { SessionListMachine, SessionListSession } from "../types";
import { AgentIcon } from "./agent-icon";
import { SessionCardActions } from "./session-card-actions";
import { SessionStatusDot } from "./status-dot";

/** `use-decrypted-titles.ts`'s resolved-no-title sentinel — duplicated here
 * rather than imported since that module doesn't export it (same precedent
 * as `unmanaged-sessions/live-source.ts`'s own local copy). */
const UNTITLED_SESSION = "(untitled session)";

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
  const fallbackTitle =
    session.title === UNTITLED_SESSION ? deriveFallbackTitle(session.items ?? []) : null;
  const displayTitle = fallbackTitle ?? session.title;

  return (
    // `SessionCardActions` is a sibling of the navigating `Link`, not nested
    // inside it — its `<button>`s would otherwise be interactive elements
    // nested inside an `<a>`, which is both invalid HTML and would need a
    // stopPropagation dance to keep a click from also navigating.
    <div className="group relative">
      <Link href={`/dashboard/session/${session.id}/`} className="block">
        <Card className="transition-colors hover:bg-accent/50">
          <CardHeader className="flex flex-row items-baseline gap-2 pr-10!">
            <CardTitle className="min-w-0 flex-1 line-clamp-2">
              {session.title === null ? <Skeleton className="h-4 w-32" /> : displayTitle}
            </CardTitle>
          </CardHeader>
          <CardContent className="w-full flex items-center gap-2">
            <AgentIcon provider={session.provider} />
            <SessionStatusDot status={status} />
            <span className="text-xs text-muted-foreground">{meta.label}</span>
            <div className="flex items-center gap-2 ml-auto shrink-0">
              {session.pinned && (
                <Pin
                  className="size-3 shrink-0 rotate-45 fill-current text-muted-foreground"
                  aria-label="Pinned"
                />
              )}
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(session.updatedAt)}
              </span>
            </div>
          </CardContent>
        </Card>
      </Link>
      <div className="absolute right-2 top-2 flex items-center gap-1">
        <SessionCardActions
          sessionId={session.id}
          title={displayTitle ?? "this session"}
          pinned={session.pinned}
          status={session.status}
          machineId={session.machineId}
          workspaceId={session.path}
        />
      </div>
    </div>
  );
}
