import { ListChecks } from "lucide-react";
import { parseTaskCreateArgs, parseTaskUpdateArgs } from "@/lib/tool-args";
import { cn } from "@/lib/utils";
import type { ToolItem } from "@/sync/reducer";
import { ToolCardShell } from "./ToolCardShell";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  deleted: "Deleted",
};

function statusIndicatorClass(status: string | undefined): string {
  switch (status) {
    case "completed":
      return "border-emerald-500 bg-emerald-500/20";
    case "in_progress":
      return "border-amber-500 bg-amber-500/20";
    case "deleted":
      return "border-destructive bg-destructive/20";
    default:
      return "border-muted-foreground/40";
  }
}

function statusLabel(status: string | undefined): string {
  if (!status) return "Updated";
  return STATUS_LABEL[status] ?? status;
}

/**
 * `TaskCreate`/`TaskUpdate` — Claude Code's current task/checklist tool pair
 * (successor to the older `TodoWrite`). Unlike
 * `TodoWrite`, verified against a real captured transcript
 * (`packages/cli/src/claude/__fixtures__/task-create-update-session.jsonl`):
 * each call touches exactly *one* task — `TaskCreate` creates it, `TaskUpdate`
 * patches a subset of its fields by `taskId` (most commonly just `status`).
 * Neither call ever carries the full task list, and a `ToolItem` has no
 * access to sibling tool calls in this session to reconstruct one — so this
 * renders each call as its own standalone entry (subject/description for a
 * create, a status-change line for an update) rather than a cumulative
 * checklist. A web client wanting a persistent live checklist view would need
 * to fold every `TaskCreate`/`TaskUpdate` call across the whole session at
 * the reducer level, not inside a single tool card — out of scope here.
 */
export function TaskEntryCard({ item }: { item: ToolItem }) {
  const isCreate = item.name === "TaskCreate";
  const create = isCreate ? parseTaskCreateArgs(item.args) : undefined;
  const update = !isCreate ? parseTaskUpdateArgs(item.args) : undefined;

  const subject = create?.subject ?? update?.subject;
  const description = create?.description ?? update?.description;
  const status = isCreate ? undefined : update?.status;
  const taskId = update?.taskId;

  const heading = subject ?? (taskId ? `Task #${taskId}` : "(untitled task)");

  return (
    <ToolCardShell item={item} icon={<ListChecks className="size-4 text-muted-foreground" />}>
      <div className="flex items-start gap-2 text-sm">
        <span
          className={cn(
            "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
            statusIndicatorClass(status),
          )}
        />
        <div className="flex flex-col gap-1">
          <span
            className={cn(
              "font-medium",
              status === "completed" && "text-muted-foreground line-through",
            )}
          >
            {heading}
          </span>
          {description && (
            <p className="text-xs whitespace-pre-wrap text-muted-foreground">{description}</p>
          )}
          <span className="text-xs text-muted-foreground">
            {isCreate ? "New task" : `${taskId ? `Task #${taskId}: ` : ""}${statusLabel(status)}`}
          </span>
        </div>
      </div>
    </ToolCardShell>
  );
}
