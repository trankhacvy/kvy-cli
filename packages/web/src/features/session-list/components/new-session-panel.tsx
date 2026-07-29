"use client";

import { ChevronRight, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

  // Eagerly fetches this workspace's local branches once a target machine is
  // known, so the base-branch field can default to something real ("the
  // workspace's configured base ref if resolvable, else 'main'" —
  // `deriveDefaultBaseBranch`'s own doc comment) instead of starting blank.
  // Deliberately eager here (unlike `BaseBranchPicker`'s own lazy-on-open
  // fetch): base branch is this panel's primary field, not a step nested
  // three levels deep in an Options screen, so showing a real value up front
  // is worth one extra `git.branches` read (a cheap, no-idempotency-cache
  // RPC by design — `machineRpc.ts`'s own doc comment).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-fetch when the machine/workspace actually changes, not on every `actions` identity change (a fresh `NewSessionActions` object every render would otherwise refetch in a loop).
  useEffect(() => {
    if (!machineId) return;
    let cancelled = false;
    actions
      .listBranches(group.workspace.id)
      .then((result) => {
        if (cancelled) return;
        setBranches(result);
      })
      .catch(() => {
        // Best-effort only — `BaseBranchPicker`'s own retry UI covers a real
        // failure once the user opens it; this prefetch silently falls back
        // to the "main" default instead of surfacing a duplicate error.
      });
    actions
      .getConfig(group.workspace.id)
      .then((result) => {
        if (cancelled) return;
        setConfiguredBaseRef(result.baseRef);
      })
      .catch(() => {
        // Best-effort only, same reasoning as the `listBranches` fetch above —
        // silently falls back to `deriveDefaultBaseBranch`'s next fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [machineId, group.workspace.id]);

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
    let cancelled = false;
    actions
      .listBranches(group.workspace.id)
      .then((result) => {
        if (cancelled) return;
        setBranches(result);
      })
      .catch(() => {});
    actions
      .getConfig(group.workspace.id)
      .then((result) => {
        if (cancelled) return;
        setConfiguredBaseRef(result.baseRef);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [actions]);

  // Only ever seeds the default once branches first load — not a dependency
  // loop, since `baseBranchTouched` flips true the moment the user picks
  // anything (including re-picking the same default) and the guard above
  // then short-circuits every later run. Uses `setForm` directly (not the
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
  const canStart = machineId !== null && canStartInlineSpawn(form) && !spawning;

  function handleStart() {
    if (machineId === null) return;
    spawn.start(group.workspace.id, form);
  }

  return (
    <div className="flex flex-col gap-3">
      {needsChoice && (
        <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="new-session-machine">
          Machine
          <Select value={machineId ?? undefined} onValueChange={(v) => setMachineId(v)}>
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
          directory={group.workspace.id}
          listBranches={actions.listBranches}
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
            directory={group.workspace.id}
            selected={form.continueFrom}
            onSelect={(continueFrom) => patchForm({ continueFrom })}
          />
        </CollapsibleContent>
      </Collapsible>

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
