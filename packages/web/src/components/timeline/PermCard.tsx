"use client";

import type { PermDecision, PermissionMode } from "@falcon/wire";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  applyAnswerResult,
  fromError,
  type PermCardPhase,
  useSessionControl,
} from "@/features/session-control";
import { parseEditArgs } from "@/lib/tool-args";
import type { PermissionInfo } from "@/sync/reducer";
import { DiffView } from "./DiffView";
import { JsonBlock } from "./JsonBlock";
import { Markdown } from "./Markdown";
import { PermissionBadge } from "./PermissionBadge";

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

/** Claude Code's `ExitPlanMode` tool name, either casing an adapter might
 * use (the ACP `codex-acp`/`claude-agent-acp` adapters normalize tool names
 * differently — plan-v2.md W2.2). */
const EXIT_PLAN_TOOL_NAMES = new Set(["ExitPlanMode", "exit_plan_mode"]);

/** Whether `name` is the plan-approval tool — drives both the markdown plan
 * preview and the approve/keep-planning button relabeling below. */
export function isExitPlanTool(name: string): boolean {
  return EXIT_PLAN_TOOL_NAMES.has(name);
}

/** The plan's markdown body (`perm-request.args.plan`, falcon-prd.md
 * FR-7.4), or `null` if `name` isn't the plan-approval tool or `args` didn't
 * carry a string `plan` field (an adapter contract violation — falls back
 * to the plain `JsonBlock` dump rather than a blank preview). Exported for
 * testing without needing to render the full card (plan-v2.md W2.2). */
export function extractPlanMarkdown(name: string, args: unknown): string | null {
  if (!isExitPlanTool(name)) return null;
  const plan = (args as { plan?: unknown } | undefined)?.plan;
  return typeof plan === "string" ? plan : null;
}

const MODE_LABEL: Record<PermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept edits",
  plan: "Plan",
  bypassPermissions: "Bypass permissions",
};

/**
 * Interactive permission card (falcon-system-design.md §9.2 "Session" row:
 * `PermCard` "Allow/Deny/Allow-session/mode"; plan.md §16 "2.4 Web control
 * surface"). Replaces the read-only `PermissionBadge` at both call sites
 * that carry a `PermissionInfo` (`PermPlaceholder`, `ToolCardShell`):
 *
 *  - `permission.decision` already set (canonical, from the reducer) ->
 *    falls straight through to `PermissionBadge`'s read-only display —
 *    that's always authoritative, regardless of this card's own local phase.
 *  - `decision` undefined -> Allow / Allow-for-session / mode-switch / Deny
 *    buttons, calling the `perm.answer` session RPC (design §4.4/§7.6).
 *
 * `showPreview` controls the edit-preview diff (falcon-prd.md FR-7.4: "for
 * edits, the proposed change preview") — `PermPlaceholder` has no other
 * body rendering `args`, so it wants the preview; a `ToolItem` inside
 * `ToolCardShell` already has its own dedicated body (e.g. `EditCard`'s
 * diff), so it passes `showPreview={false}` to avoid rendering it twice.
 * `showHeader` similarly suppresses the "Permission requested — <name>" /
 * "Pending" line when the caller's own chrome already names the tool and
 * shows a permission badge (`ToolCardShell`).
 */
export function PermCard({
  name,
  args,
  permission,
  showPreview = true,
  showHeader = true,
}: {
  name: string;
  args: unknown;
  permission: PermissionInfo;
  showPreview?: boolean;
  showHeader?: boolean;
}) {
  const { actions } = useSessionControl();
  const [phase, setPhase] = useState<PermCardPhase>({ kind: "idle" });

  const mutation = useMutation({
    mutationFn: (vars: { reqId: string; decision: PermDecision }) =>
      actions.answerPermission(vars.reqId, vars.decision),
  });

  // The reducer's `permission.decision` is canonical once it exists (a
  // `perm-resolve` envelope landed) — it always wins over this card's own
  // optimistic phase, whichever device answered.
  if (permission.decision) {
    return <PermissionBadge permission={permission} />;
  }

  if (phase.kind === "answered") {
    return <PermissionBadge permission={{ ...permission, decision: phase.decision }} />;
  }

  if (phase.kind === "lost-race") {
    return (
      <div className="flex flex-col gap-1.5">
        <Badge variant="secondary">Answered on another device</Badge>
        <PermissionBadge permission={{ ...permission, decision: phase.decision }} />
      </div>
    );
  }

  const submitting = phase.kind === "submitting" || mutation.isPending;

  function submit(decision: PermDecision) {
    setPhase({ kind: "submitting", decision });
    mutation.mutate(
      { reqId: permission.reqId, decision },
      {
        onSuccess: (result) => setPhase(applyAnswerResult(decision, result)),
        onError: (error) => setPhase(fromError(error)),
      },
    );
  }

  const isEdit = EDIT_TOOLS.has(name);
  const editArgs = isEdit ? parseEditArgs(args) : null;
  const isExitPlan = isExitPlanTool(name);
  const planMd = extractPlanMarkdown(name, args);

  return (
    <div
      className={
        showHeader
          ? "flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
          : "flex flex-col gap-2"
      }
    >
      {showHeader && (
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">Permission requested — {name}</span>
          <Badge variant="warning">Pending</Badge>
        </div>
      )}

      {showPreview &&
        (editArgs ? (
          <div className="flex flex-col gap-2">
            {editArgs.filePath && (
              <p className="truncate font-mono text-xs text-muted-foreground">
                {editArgs.filePath}
              </p>
            )}
            {(editArgs.edits && editArgs.edits.length > 0
              ? editArgs.edits
              : [
                  {
                    oldString: editArgs.oldString,
                    newString: editArgs.newString ?? editArgs.content,
                  },
                ]
            ).map((edit) => (
              <DiffView
                key={`${edit.oldString ?? ""}::${edit.newString ?? ""}`}
                oldText={edit.oldString}
                newText={edit.newString}
              />
            ))}
          </div>
        ) : planMd ? (
          <div className="max-h-96 overflow-y-auto rounded-md border border-border/60 bg-muted/20 px-3 py-2">
            <Markdown md={planMd} />
          </div>
        ) : (
          args !== undefined && <JsonBlock value={args} />
        ))}

      {phase.kind === "error" && <p className="text-xs text-destructive">{phase.message}</p>}

      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          disabled={submitting}
          onClick={() => submit({ kind: "allow", scope: "once" })}
        >
          {isExitPlan ? "Approve plan" : "Allow"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={submitting}
          onClick={() => submit({ kind: "allow", scope: "session" })}
        >
          Allow for session
        </Button>
        {permission.modes.map((mode) => (
          <Button
            key={mode}
            size="sm"
            variant="outline"
            disabled={submitting}
            onClick={() => submit({ kind: "mode", mode })}
          >
            {isExitPlan ? `Approve & ${MODE_LABEL[mode]}` : `Switch to ${mode}`}
          </Button>
        ))}
        <Button
          size="sm"
          variant="destructive"
          disabled={submitting}
          onClick={() => submit({ kind: "deny" })}
        >
          {isExitPlan ? "Keep planning" : "Deny"}
        </Button>
      </div>
    </div>
  );
}
