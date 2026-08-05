import type { CheckRun } from "@kvy/wire";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  ExternalLink,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { GithubChecksActions } from "../types";
import { useCheckSteps } from "../use-check-steps";

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

export function CheckRunRow({
  check,
  onFixWithAgent,
  actions,
  worktree,
}: {
  check: CheckRun;
  onFixWithAgent?: (check: CheckRun) => void;
  actions: GithubChecksActions;
  worktree: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { steps } = useCheckSteps(actions, worktree, expanded ? check.name : null);
  const duration = formatDuration(check.startedAt, check.completedAt);
  const failed =
    check.status === "completed" &&
    (check.conclusion === "failure" || check.conclusion === "timed_out");
  const hasSteps = check.provider === "github-actions";

  return (
    <>
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
        {hasSteps && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? `Hide ${check.name} steps` : `Show ${check.name} steps`}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        )}
        {failed && onFixWithAgent && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={() => onFixWithAgent(check)}
          >
            Fix with agent
          </Button>
        )}
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
      {failed && check.summary && (
        <li className="rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 font-mono text-[11px] text-destructive/90">
          {check.summary}
        </li>
      )}
      {expanded && steps && (
        <li>
          <ul className="ml-6 flex flex-col gap-1 border-l border-border pl-3">
            {steps.map((step) => (
              <li
                key={step.number}
                className="flex items-center gap-2 text-[11px] text-muted-foreground"
              >
                <CheckIcon status={step.status} conclusion={step.conclusion} />
                {step.name}
              </li>
            ))}
          </ul>
        </li>
      )}
    </>
  );
}
