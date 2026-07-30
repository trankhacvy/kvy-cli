"use client";

import type { PermissionMode } from "@falcon/wire";
import { ChevronRight, Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MachineOfflineNotice } from "@/components/machine-offline-notice";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ModelPicker,
  PermissionModePicker,
  ProviderPicker,
  useNewWorkspace,
} from "@/features/new-session";
import { generateBranchName } from "@/features/new-session/auto-branch";
import { applyFavoriteDefaults, getFavoriteModel } from "@/features/new-session/favorites";
import {
  displayWorkspacePath,
  validateWorkspaceName,
  WORKSPACE_NAME_ERROR_COPY,
} from "@/features/new-session/new-workspace";
import { useMachineOnline } from "@/lib/use-machine-online";
import { cn } from "@/lib/utils";
import type { SessionListMachine } from "../types";

/**
 * "New project" — creates a brand-new folder on a machine, registers it as
 * a workspace, and starts the first session in it (Feature 4, docs/
 * web-ux-improvements-plan.md), closing the honest gap
 * `session-list-screen.tsx` documents: an account with machines but zero
 * sessions ever run has no `+` on a `WorkspaceSection` row to click.
 *
 * No filesystem browser: the folder always lands at
 * `~/falcon-workspaces/<name>` (`new-workspace.ts`'s fixed base directory),
 * shown read-only — the user only edits the last path segment.
 */
export function NewWorkspaceTrigger({
  machines,
  defaultOpen = false,
}: {
  machines: SessionListMachine[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Plus className="size-3.5" />
          New project
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <NewWorkspaceForm machines={machines} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function defaultMachineId(machines: SessionListMachine[]): string | null {
  const online = machines.find((m) => m.status === "online");
  return (online ?? machines[0])?.id ?? null;
}

export function NewWorkspaceForm({
  machines,
  onClose,
}: {
  machines: SessionListMachine[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [machineId, setMachineId] = useState<string | null>(() => defaultMachineId(machines));
  const selectedMachine = machineId ? machines.find((m) => m.id === machineId) : undefined;
  const machine = useMachineOnline(machineId);

  const [name, setName] = useState(() => generateBranchName().replace("wf/", ""));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { provider } = applyFavoriteDefaults({ provider: "claude-code", model: "" });
  const [providerValue, setProviderValue] = useState(provider);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [model, setModel] = useState(getFavoriteModel(provider) ?? "");

  const { home, state, create } = useNewWorkspace(machineId ?? "");

  const nameError = validateWorkspaceName(name);
  const canCreate =
    machineId !== null &&
    !machine.isKnownUnavailable &&
    home !== null &&
    nameError === null &&
    state.phase !== "creating";

  function handleCreate() {
    if (!canCreate) return;
    create(name, { provider: providerValue, permissionMode, model: model || undefined });
  }

  if (state.phase === "success") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
          Project created. Session started.
        </p>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            onClose();
            router.push(`/dashboard/session/${state.sessionId}/`);
          }}
        >
          Open session
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {machines.length > 1 && (
        <label
          className="flex flex-col gap-1.5 text-sm font-medium"
          htmlFor="new-workspace-machine"
        >
          Machine
          <Select value={machineId ?? undefined} onValueChange={(v) => setMachineId(v)}>
            <SelectTrigger id="new-workspace-machine" className="w-full">
              <SelectValue placeholder="Choose a machine" />
            </SelectTrigger>
            <SelectContent>
              {machines.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        m.status === "online" ? "bg-emerald-500" : "bg-muted-foreground/40",
                      )}
                    />
                    {m.name ?? m.id}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}

      <MachineOfflineNotice state={machine} />

      <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="new-workspace-name">
        Name
        <Input
          id="new-workspace-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="text-sm"
        />
      </label>
      {nameError && (
        <p className="text-xs text-destructive">{WORKSPACE_NAME_ERROR_COPY[nameError]}</p>
      )}

      <p className="text-xs text-muted-foreground">
        This folder will be created on {selectedMachine?.name ?? "that machine"} at{" "}
        <code className="rounded bg-muted px-1 py-0.5">
          {home !== null ? displayWorkspacePath(name) : "…"}
        </code>
        .
      </p>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", advancedOpen && "rotate-90")}
            />
            Advanced
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 pt-3">
          <ProviderPicker
            value={providerValue}
            onChange={(next) => {
              setProviderValue(next);
              setModel(getFavoriteModel(next) ?? "");
            }}
          />
          <PermissionModePicker value={permissionMode} onChange={setPermissionMode} />
          <ModelPicker
            key={providerValue}
            provider={providerValue}
            value={model}
            onChange={setModel}
          />
        </CollapsibleContent>
      </Collapsible>

      {state.phase === "creating" && (
        <div
          className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
          aria-live="polite"
        >
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          <span>
            {state.step === "folder" && "Creating the folder…"}
            {state.step === "registering" && "Setting it up…"}
            {state.step === "starting" && "Starting your session…"}
          </span>
        </div>
      )}
      {state.phase === "error" && (
        <p className="text-sm text-destructive" role="alert">
          {state.message}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={!canCreate} onClick={handleCreate}>
          {state.phase === "creating" ? "Creating…" : "Create project"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={state.phase === "creating"}
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
      {machineId === null && (
        <p className="text-xs text-muted-foreground">Choose a machine first.</p>
      )}
    </div>
  );
}
