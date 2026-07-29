"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveWorkspaceSettingsActions } from "../use-live-workspace-settings-actions.js";
import { useWorkspaceSettings } from "../use-workspace-settings.js";

const CURRENT_BRANCH_VALUE = "__current__";
// The `workspaces` table stores git config inside an encrypted blob (the
// server never decrypts it), so a SQL-level column default isn't possible —
// this is the equivalent default applied where the value is actually read,
// for a workspace that has never been configured.
const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_REMOTE = "origin";

/**
 * Workspace Settings → Git: base branch (a `<Select>` populated from
 * `git.branches`, the same live source `BaseBranchPicker` uses for the New
 * Session wizard) and remote name (a `<Select>` populated from
 * `git.remotes`, auto-filled when the repo has exactly one configured
 * remote — the common single-`origin` case). Saving writes to the daemon's
 * local config AND, best-effort, the server-synced `workspaces` row (see
 * `use-workspace-settings.ts`).
 */
export function WorkspaceGitSection({
  workspacePath,
  machineId,
}: {
  workspacePath: string;
  machineId: string | null;
}) {
  const baseBranchLabelId = useId();
  const remoteLabelId = useId();
  const actions = useLiveWorkspaceSettingsActions(machineId ?? "");
  const { config, isConfigLoading, configError, branches, remotes, save, isSavePending } =
    useWorkspaceSettings(actions, workspacePath);

  const [baseBranch, setBaseBranch] = useState("");
  const [remote, setRemote] = useState("");

  // Seed the editable fields from the loaded config once, and again whenever a
  // fresh workspace is loaded (workspacePath changes) — never overwrites an
  // in-progress edit on every background refetch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-seeds only on workspacePath/config-arrival, not on every `config` identity change from a background refetch.
  useEffect(() => {
    if (!config) return;
    setBaseBranch(config.baseRef ?? DEFAULT_BASE_BRANCH);
    setRemote(
      config.remote ??
        (remotes?.length === 1 ? (remotes[0]?.name ?? DEFAULT_REMOTE) : DEFAULT_REMOTE),
    );
  }, [workspacePath, config === undefined]);

  if (!machineId) {
    return (
      <p className="text-sm text-muted-foreground">
        No machine associated with this workspace yet — start a session here first.
      </p>
    );
  }

  if (isConfigLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (configError) {
    return (
      <p className="text-sm text-destructive">
        Could not load this workspace's config: {configError}
      </p>
    );
  }

  function handleSave() {
    save({ baseRef: baseBranch, remote });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span id={baseBranchLabelId} className="text-sm font-semibold">
          Base branch
        </span>
        <p className="text-sm text-muted-foreground">
          The base branch for worktrees and checkpoints
        </p>
        <Select
          value={baseBranch || CURRENT_BRANCH_VALUE}
          onValueChange={(value) => setBaseBranch(value === CURRENT_BRANCH_VALUE ? "" : value)}
        >
          <SelectTrigger aria-labelledby={baseBranchLabelId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={CURRENT_BRANCH_VALUE}>Current branch (default)</SelectItem>
            {branches?.map((branch) => (
              <SelectItem key={branch.name} value={branch.name}>
                {branch.name}
                {branch.isCurrent ? " (current)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <span id={remoteLabelId} className="text-sm font-semibold">
          Remote
        </span>
        <p className="text-sm text-muted-foreground">The git remote for push/pull operations</p>
        <Select value={remote} onValueChange={setRemote}>
          <SelectTrigger aria-labelledby={remoteLabelId} className="w-full">
            <SelectValue placeholder="Select a remote" />
          </SelectTrigger>
          <SelectContent>
            {remotes?.map((r) => (
              <SelectItem key={r.name} value={r.name}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button type="button" disabled={isSavePending} onClick={handleSave} className="self-start">
        {isSavePending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
