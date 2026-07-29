import type { GithubChecksResult } from "@falcon/wire";
import { CheckCircle2, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * One row of the Changes tab's status checklist (conductor.build-style "No
 * PR open" / "N uncommitted changes"): an icon, a label, and an optional
 * right-aligned action button — mirrors `ChecksPanel.tsx`'s
 * `PullRequestHeader` visual style.
 */
function ChecklistRow({
  label,
  actionLabel,
  onAction,
  done,
}: {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
  done: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {done ? (
        <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
      ) : (
        <Circle className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
      {!done && actionLabel && onAction && (
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * The PR-status row: `GithubChecksResult`'s five `state` values are a flat
 * object with every field but `state` optional, not a discriminated union
 * narrowed cleanly by `state` alone — `repo`/`branch`/`pr` still need
 * explicit presence checks even inside a matching `case` (mirrors
 * `ChecksBody`'s own per-state handling in `ChecksPanel.tsx`). Every
 * non-`"ok"` state gets its own honest copy rather than collapsing into a
 * single "No PR open" boolean, since a missing GitHub token or an
 * unsupported remote is not the same claim as "you could open a PR right
 * now and don't have one".
 */
function PrChecklistRow({
  checks,
  onCreatePr,
}: {
  checks: GithubChecksResult | undefined;
  onCreatePr: () => void;
}) {
  if (!checks) return <ChecklistRow label="Checking PR status…" done={false} />;
  switch (checks.state) {
    case "no-token":
      return <ChecklistRow label="GitHub not connected on this machine" done={false} />;
    case "unsupported-remote":
      return <ChecklistRow label={checks.message ?? "Remote not supported"} done={false} />;
    case "not-pushed":
      return <ChecklistRow label="Not pushed yet" done={false} />;
    case "no-pr":
      return (
        <ChecklistRow
          label="No PR open"
          actionLabel="Create PR"
          onAction={onCreatePr}
          done={false}
        />
      );
    case "ok":
      return checks.pr ? (
        <ChecklistRow
          label={`PR #${checks.pr.number} ${checks.pr.state}`}
          done={checks.pr.state === "open"}
        />
      ) : (
        <ChecklistRow
          label="No PR open"
          actionLabel="Create PR"
          onAction={onCreatePr}
          done={false}
        />
      );
  }
}

/**
 * Changes tab status checklist (conductor.build-style): PR status plus
 * uncommitted-change count, each with its own action when incomplete.
 */
export function GitStatusChecklist({
  uncommittedCount,
  checks,
  onCommitAndPush,
  onCreatePr,
}: {
  uncommittedCount: number;
  checks: GithubChecksResult | undefined;
  onCommitAndPush: () => void;
  onCreatePr: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
      <PrChecklistRow checks={checks} onCreatePr={onCreatePr} />
      <ChecklistRow
        label={`${uncommittedCount} uncommitted change${uncommittedCount === 1 ? "" : "s"}`}
        actionLabel="Commit and push"
        onAction={onCommitAndPush}
        done={uncommittedCount === 0}
      />
    </div>
  );
}

export { ChecklistRow, PrChecklistRow };
