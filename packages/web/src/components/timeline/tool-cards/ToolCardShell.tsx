import type { ReactNode } from "react";
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";
import { isAskUserQuestion } from "@/lib/tool-args";
import type { ToolItem } from "@/sync/reducer";
import { AskUserQuestionCard } from "../AskUserQuestionCard";
import { NestedItems } from "../NestedItems";
import { PermCard } from "../PermCard";
import { PermissionBadge } from "../PermissionBadge";
import { hasVisibleTranscriptItems } from "../transcript-view";

function getToolState(item: ToolItem): Parameters<typeof ToolHeader>[0]["state"] {
  if (item.permission && item.permission.decision === undefined) return "approval-requested";
  if (item.permission?.decision?.kind === "deny") return "output-denied";
  if (item.status === "running") return "input-available";
  return item.ok === false ? "output-error" : "output-available";
}

/** Common chrome for every `ToolCard` registry entry: header (icon, name,
 * status, permission badge — read-only, same compact spot regardless of
 * decided/pending), a body slot for the tool-specific content, an
 * interactive `PermCard` action row while a decision is still pending
 * (plan.md §16 "2.4 Web control surface" — `showPreview={false}` since the
 * tool's own body, e.g. `EditCard`'s diff, already renders `args`), and —
 * generically, since the reducer can link a subagent scope onto *any* tool
 * call, not just `Task` — nested subagent activity. */
export function ToolCardShell({
  item,
  icon,
  children,
  statusLabel,
  statusVariant,
  toolStateOverride,
}: {
  item: ToolItem;
  icon?: ReactNode;
  children: ReactNode;
  statusLabel?: string;
  statusVariant?: "secondary" | "success" | "destructive";
  toolStateOverride?: Parameters<typeof ToolHeader>[0]["state"];
}) {
  const showPermissionActions = item.permission && item.permission.decision === undefined;
  const showSubagentActivity = item.subagent ? hasVisibleTranscriptItems(item.subagent) : false;
  const resolvedToolState = toolStateOverride ?? getToolState(item);
  const resolvedStatusLabel =
    statusLabel ?? (item.status === "running" ? "running" : item.ok === false ? "failed" : "done");
  const resolvedStatusVariant =
    statusVariant ??
    (item.status === "running" ? "secondary" : item.ok === false ? "destructive" : "success");

  return (
    <Tool
      defaultOpen={item.status === "running" || item.ok === false || showPermissionActions}
      className="w-full max-w-full overflow-hidden border-border bg-card text-sm"
    >
      <ToolHeader
        type="dynamic-tool"
        toolName={item.name}
        title={item.title ?? item.name}
        state={resolvedToolState}
      />
      <ToolContent className="space-y-3 border-t border-border/70 bg-card/60 p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {icon}
          <span className="font-medium text-foreground">{item.name}</span>
          <Badge variant={resolvedStatusVariant}>{resolvedStatusLabel}</Badge>
          {item.permission && <PermissionBadge permission={item.permission} />}
        </div>
        <div>{children}</div>
        {showPermissionActions && item.permission && (
          <div className="border-t border-border/70 pt-3">
            {isAskUserQuestion(item.name) ? (
              <AskUserQuestionCard args={item.args} permission={item.permission} />
            ) : (
              <PermCard
                name={item.name}
                args={item.args}
                permission={item.permission}
                showPreview={false}
                showHeader={false}
              />
            )}
          </div>
        )}
        {showSubagentActivity && item.subagent && (
          <div className="border-t border-border/70 pt-3">
            <NestedItems items={item.subagent} />
          </div>
        )}
      </ToolContent>
    </Tool>
  );
}
