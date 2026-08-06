"use client";

import { ChevronRight, CloudOff, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { InlineCommandText } from "@/components/inline-command-text";
import { MachineOfflineNotice } from "@/components/machine-offline-notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BaseBranchPicker,
  type BranchItem,
  ModelPicker,
  PermissionModePicker,
  ProviderPicker,
  useLiveNewSessionActions,
} from "@/features/new-session";
import { generateBranchName } from "@/features/new-session/auto-branch";
import { applyFavoriteDefaults, getFavoriteModel } from "@/features/new-session/favorites";
import { UNAVAILABLE_COPY } from "@/lib/use-machine-online";
import { cn } from "@/lib/utils";
import type { WorkspaceGroup } from "../group";
import {
  canStartInlineSpawn,
  deriveDefaultBaseBranch,
  type InlineSpawnForm,
} from "../inline-spawn";
import { deriveDefaultTargetMachineId, deriveWorkspaceTargetMachines } from "../target-machine";
import type { SessionListMachine } from "../types";
import { useElapsedSeconds } from "../use-elapsed-seconds";
import { useInlineSpawn } from "../use-inline-spawn";
import { ContinueSessionPicker } from "./continue-session-picker";
import { InlineSpawnStatus } from "./inline-spawn-status";

/**
 * The `+` "start a new session here" trigger for one workspace row (B2,
 * new-session-from-web redesign — see the task's own header comment).
 * Rendered by `WorkspaceSection` next to its `<h2>`, and by the sidebar's
 * `WorkspaceNav` next to its own workspace row — a `Dialog` rather than an
 * inline expansion is what lets both call sites share it unmodified, since
 * the sidebar rail is too narrow for an inline form.
 *
 * Disabled (a `Tooltip` explaining why, no `Dialog`) when every machine
 * this workspace's sessions have run on is known-unavailable — spawning
 * would be a dead end the form can't resolve, so the button itself says so
 * up front. Only known-unavailable states gate: a target machine missing
 * from `machinesById` (unknown) never disables, and a single online target
 * keeps the button live for the multi-machine case. A workspace with no
 * targetable machine at all (every session machine-less) is disabled too —
 * the same dead end, just with nothing to check.
 */
export function NewSessionTrigger({
  group,
  machinesById,
  defaultOpen = false,
  defaultAdvancedOpen = false,
}: {
  group: WorkspaceGroup;
  machinesById: Map<string, SessionListMachine>;
  /** Test-only escape hatch — lets a render test assert the dialog's open
   * state without simulating a click (this package has no jsdom/RTL). */
  defaultOpen?: boolean;
  defaultAdvancedOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const label = `Start a new session in ${group.workspace.name}`;

  const targetMachines = deriveWorkspaceTargetMachines(group);
  const targets = targetMachines
    .map((t) => machinesById.get(t.machineId))
    .filter((m): m is SessionListMachine => m !== undefined);
  const noTargets = targetMachines.length === 0;
  const allUnavailable =
    noTargets ||
    (targets.length === targetMachines.length &&
      targets.every((m) => m.status === "offline" || m.status === "needs-reauth"));
  const unavailableReason = allUnavailable
    ? noTargets
      ? "No machine is connected to this workspace yet. Run `kvy` here once to start sessions."
      : targets.every((m) => m.status === "needs-reauth")
        ? UNAVAILABLE_COPY["needs-reauth"]
        : UNAVAILABLE_COPY.offline
    : null;

  if (unavailableReason !== null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              disabled
              aria-label={label}
            >
              <Plus className="size-3.5" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="block">
          <InlineCommandText text={unavailableReason} />
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={label}>
              <Plus className="size-3.5" />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New session in {group.workspace.name}</DialogTitle>
        </DialogHeader>
        <NewSessionForm
          group={group}
          machinesById={machinesById}
          defaultAdvancedOpen={defaultAdvancedOpen}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function initialForm(): InlineSpawnForm {
  const { provider } = applyFavoriteDefaults({ provider: "claude-code", model: "" });
  return {
    provider,
    permissionMode: "default",
    model: getFavoriteModel(provider) ?? "",
    baseBranch: "",
    branchName: generateBranchName(),
    continueFrom: null,
  };
}

export function NewSessionForm({
  group,
  machinesById,
  defaultAdvancedOpen = false,
  onClose,
}: {
  group: WorkspaceGroup;
  machinesById: Map<string, SessionListMachine>;
  defaultAdvancedOpen?: boolean;
  onClose: () => void;
}) {
  const targetMachines = deriveWorkspaceTargetMachines(group);
  const needsChoice = targetMachines.length > 1;
  const [machineId, setMachineId] = useState<string | null>(() =>
    deriveDefaultTargetMachineId(group),
  );

  const [form, setForm] = useState<InlineSpawnForm>(initialForm);
  const [advancedOpen, setAdvancedOpen] = useState(defaultAdvancedOpen);
  const [branches, setBranches] = useState<BranchItem[] | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [configuredBaseRef, setConfiguredBaseRef] = useState<string | undefined>(undefined);
  const [baseBranchTouched, setBaseBranchTouched] = useState(false);

  const actions = useLiveNewSessionActions(machineId ?? "");
  const spawn = useInlineSpawn(machineId ?? "");
  const elapsedSeconds = useElapsedSeconds(
    spawn.state.phase === "spawning",
    spawn.state.phase === "spawning" ? spawn.state.startedAt : null,
  );

  function patchForm(patch: Partial<InlineSpawnForm>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  // One fetch owns the branch list for both the picker and the default-base
  // derivation; a generation counter drops the response of any stale or
  // superseded fetch (machine switch, actions swap) instead of letting it
  // overwrite newer data.
  const branchesGeneration = useRef(0);
  function loadBranches() {
    const worktree = group.workspace.path;
    if (!worktree) return;
    const generation = ++branchesGeneration.current;
    setBranchesLoading(true);
    setBranchesError(null);
    actions
      .listBranches(worktree)
      .then((result) => {
        if (branchesGeneration.current !== generation) return;
        setBranches(result);
      })
      .catch((err) => {
        if (branchesGeneration.current !== generation) return;
        setBranchesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (branchesGeneration.current === generation) setBranchesLoading(false);
      });
    actions
      .getConfig(worktree)
      .then((result) => {
        if (branchesGeneration.current !== generation) return;
        setConfiguredBaseRef(result.baseRef);
      })
      .catch(() => {});
  }

  // Eagerly fetches this workspace's local branches + configured base ref
  // once a target machine is known, so the base-branch field can default to
  // something real ("the workspace's configured base ref if resolvable, else
  // 'main'" — `deriveDefaultBaseBranch`'s own doc comment) instead of
  // starting blank. `BaseBranchPicker` is presentational and renders this
  // state directly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-fetch when the machine/workspace actually changes, not on every `actions` identity change (a fresh `NewSessionActions` object every render would otherwise refetch in a loop).
  useEffect(() => {
    if (!machineId) return;
    loadBranches();
  }, [machineId, group.workspace.path]);

  // `actions` starts out as a permanently-rejecting stub until the chosen
  // machine's crypto key finishes unwrapping (`useLiveNewSessionActions`) —
  // the prefetch above can race that and settle before the real client is
  // ready, then never retry once it is. Re-run the same prefetch the moment
  // `actions`'s identity changes after mount (exactly when the stub is
  // swapped for the real client) — kept as its own effect, deliberately not
  // folded into the one above, since that one's narrower dependency list is
  // there on purpose (re-fetch on machine/workspace change only).
  const isFirstActionsRender = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed only on `actions` — see use-git-panel.ts's identical effect.
  useEffect(() => {
    if (isFirstActionsRender.current) {
      isFirstActionsRender.current = false;
      return;
    }
    if (!machineId) return;
    loadBranches();
  }, [actions]);

  // Seeds the base-branch default whenever a fresh branch list arrives and
  // the user hasn't picked one (a machine switch resets `baseBranchTouched`,
  // so the new machine's default re-seeds there) — not a dependency loop,
  // since `baseBranchTouched` flips true the moment the user picks anything
  // (including re-picking the same default) and the guard above then
  // short-circuits every later run. Uses `setForm` directly (not the
  // `patchForm` closure, whose identity changes every render) so this only
  // needs `branches`/`baseBranchTouched` in its dependency list.
  useEffect(() => {
    if (baseBranchTouched || branches === null) return;
    setForm((prev) => ({
      ...prev,
      baseBranch: deriveDefaultBaseBranch(branches, configuredBaseRef),
    }));
  }, [branches, configuredBaseRef, baseBranchTouched]);

  const spawning = spawn.state.phase === "spawning";
  const selectedMachine = machineId ? machinesById.get(machineId) : undefined;
  // every other machine-RPC surface, this one IS safe to hard-disable — the
  // picker already renders a live online dot per machine (below), so a
  // disabled Start button here is legible rather than mysterious.
  const machineUnavailable = selectedMachine !== undefined && selectedMachine.status !== "online";
  const canStart =
    machineId !== null &&
    group.workspace.path !== null &&
    canStartInlineSpawn(form) &&
    !spawning &&
    !machineUnavailable;

  function handleStart() {
    if (machineId === null || group.workspace.path === null) return;
    spawn.start(group.workspace.path, form);
  }

  function handleMachineChange(nextMachineId: string) {
    setMachineId(nextMachineId);
    setBaseBranchTouched(false);
    patchForm({ baseBranch: "", continueFrom: null });
  }

  return (
    <div className="flex flex-col gap-3">
      {needsChoice && (
        <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="new-session-machine">
          Machine
          <Select value={machineId ?? undefined} onValueChange={handleMachineChange}>
            <SelectTrigger id="new-session-machine" className="w-full">
              <SelectValue placeholder="Choose a machine" />
            </SelectTrigger>
            <SelectContent>
              {targetMachines.map((m) => {
                const machine = machinesById.get(m.machineId);
                return (
                  <SelectItem key={m.machineId} value={m.machineId}>
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          machine?.online ? "bg-emerald-500" : "bg-muted-foreground/40",
                        )}
                      />
                      {machine?.name ?? m.machineId}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </label>
      )}

      <label
        className="flex flex-col gap-1.5 text-sm font-medium"
        htmlFor="new-session-branch-name"
      >
        Branch
        <input
          id="new-session-branch-name"
          value={form.branchName}
          onChange={(e) => patchForm({ branchName: e.target.value })}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      <div className="flex flex-col gap-1.5 text-sm font-medium">
        <span id="new-session-base-branch-label">From</span>
        <BaseBranchPicker
          branches={branches}
          loading={branchesLoading}
          error={branchesError}
          onRetry={() => {
            if (machineId) loadBranches();
          }}
          selected={form.baseBranch}
          onSelect={(name) => {
            setBaseBranchTouched(true);
            patchForm({ baseBranch: name });
          }}
          labelledBy="new-session-base-branch-label"
        />
      </div>

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
            value={form.provider}
            onChange={(provider) =>
              patchForm({ provider, model: getFavoriteModel(provider) ?? "" })
            }
          />
          <PermissionModePicker
            value={form.permissionMode}
            onChange={(permissionMode) => patchForm({ permissionMode })}
          />
          <ModelPicker
            key={form.provider}
            provider={form.provider}
            value={form.model}
            onChange={(model) => patchForm({ model })}
          />
          <ContinueSessionPicker
            listImportCandidates={actions.listImportCandidates}
            directory={group.workspace.path ?? ""}
            selected={form.continueFrom}
            onSelect={(continueFrom) => patchForm({ continueFrom })}
          />
        </CollapsibleContent>
      </Collapsible>

      {machineId === null && !needsChoice && (
        <div
          className="flex items-center gap-2 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <CloudOff className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            No machine is connected to this workspace yet. Run kvy in this workspace once to start
            sessions from here.
          </span>
        </div>
      )}

      {selectedMachine && (
        <MachineOfflineNotice
          state={{
            availability: selectedMachine.status,
            isKnownUnavailable: machineUnavailable,
            reason:
              selectedMachine.status === "online" ? null : UNAVAILABLE_COPY[selectedMachine.status],
          }}
        />
      )}

      <InlineSpawnStatus state={spawn.state} elapsedSeconds={elapsedSeconds} />

      {spawn.state.phase === "success" ? (
        <Button type="button" size="sm" onClick={onClose}>
          Done
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" disabled={!canStart} onClick={handleStart}>
            {spawning ? "Starting…" : "Start session"}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={spawning} onClick={onClose}>
            Cancel
          </Button>
          {needsChoice && machineId === null && (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              Choose a machine first
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}
