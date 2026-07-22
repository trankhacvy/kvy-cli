import type { CheckRun } from "@falcon/wire";
import { CheckCircle2, Circle, Clock, ExternalLink, XCircle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

/** Tone + icon per `status`/`conclusion` — `conclusion` only exists once `status === "completed"`, so it's the tie-breaker there; every other status has one fixed icon regardless of conclusion. */
function CheckIcon({ status, conclusion }: Pick<CheckRun, "status" | "conclusion">) {
  if (status === "queued") return <Clock className="size-4 shrink-0 text-muted-foreground" />;
  if (status === "in_progress") return <Spinner className="size-4 shrink-0 text-amber-500" />;

  // completed
  switch (conclusion) {
    case "success":
      return <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />;
    case "failure":
    case "timed_out":
      return <XCircle className="size-4 shrink-0 text-destructive" />;
    case "cancelled":
    case "action_required":
    case "stale":
      return <XCircle className="size-4 shrink-0 text-muted-foreground" />;
    default:
      // "neutral" | "skipped" | undefined (a completed run GitHub reports
      // with no conclusion at all — rare, but the schema allows it).
      return <Circle className="size-4 shrink-0 text-muted-foreground" />;
  }
}

function formatDuration(startedAt?: number, completedAt?: number): string | null {
  if (startedAt === undefined) return null;
  const endedAt = completedAt ?? Date.now() / 1000;
  const seconds = Math.max(0, Math.round(endedAt - startedAt));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/** One CI check-run row (falcon-system-design.md §4.4 `github.checks`, docs/features/github-pr-ci.md Phase 4): status/conclusion icon, name, relative duration, and an external link to the check's own details page when one is provided. */
export function CheckRunRow({ check }: { check: CheckRun }) {
  const duration = formatDuration(check.startedAt, check.completedAt);

  return (
    <li className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
      <CheckIcon status={check.status} conclusion={check.conclusion} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{check.name}</p>
        <p className="text-muted-foreground">
          {check.status === "queued" && "Queued"}
          {check.status === "in_progress" && "Running…"}
          {check.status === "completed" && (check.conclusion ?? "completed")}
          {duration && ` · ${duration}`}
        </p>
      </div>
      {check.detailsUrl && (
        <a
          href={check.detailsUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`View ${check.name} details`}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </li>
  );
}
