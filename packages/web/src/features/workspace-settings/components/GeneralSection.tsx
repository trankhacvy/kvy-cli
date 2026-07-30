"use client";

import { useMutation } from "@tanstack/react-query";
import { MonitorIcon } from "lucide-react";
import { RemoveWorkspaceControl } from "@/components/remove-workspace-control";
import { TruncatedPath } from "@/components/truncated-path";
import { Badge } from "@/components/ui/badge";
import { useLiveGitDiffActions } from "@/features/git-diff";
import type { SessionListMachine } from "@/features/session-list";

/**
 * Workspace Settings → General: the workspace's path and the machine it's
 * currently associated with (the one resolved from its most recent
 * session — `workspace-nav.tsx`'s `WorkspaceNavItem`), plus the
 * remove-workspace control — deregisters this path from the machine's
 * daemon; no files touched, session history stays exactly as readable as
 * before (`RemoveWorkspaceControl`'s own copy). Path/machine display stays
 * read-only; there's no multi-machine workspace picker yet (`docs`
 * conversation: a workspace's local checkout path is inherently per-machine,
 * not something this dialog can reassign).
 */
export function GeneralSection({
  workspacePath,
  machineId,
  machine,
}: {
  workspacePath: string;
  machineId: string | null;
  machine: SessionListMachine | null;
}) {
  const gitActions = useLiveGitDiffActions(machineId ?? "");
  const removeWorkspaceMutation = useMutation({
    mutationFn: () => gitActions.unregisterWorkspace(workspacePath),
  });

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold">Path</h3>
        <TruncatedPath
          path={workspacePath}
          className="rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm text-muted-foreground"
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold">Machine</h3>
        {machine ? (
          <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border p-3">
            <div className="flex min-w-0 items-center gap-3">
              <MonitorIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm">{machine.name ?? "Unnamed machine"}</span>
            </div>
            <Badge variant={machine.online ? "default" : "outline"} className="shrink-0">
              {machine.online ? "Online" : "Offline"}
            </Badge>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No machine associated with this workspace yet — start a session here first.
          </p>
        )}
      </div>

      {machineId && (
        <div className="flex min-w-0 justify-end border-t border-border pt-6">
          <RemoveWorkspaceControl
            onRemove={() => removeWorkspaceMutation.mutate()}
            isPending={removeWorkspaceMutation.isPending}
            done={removeWorkspaceMutation.isSuccess}
          />
        </div>
      )}
    </div>
  );
}
