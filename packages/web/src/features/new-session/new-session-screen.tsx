"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { generateBranchName } from "./auto-branch";
import { DirectoryStep } from "./components/directory-step";
import { ImportStep } from "./components/import-step";
import { MachineStep } from "./components/machine-step";
import { OptionsStep } from "./components/options-step";
import { applyFavoriteDefaults, getFavoriteMachineId } from "./favorites";
import { getDefaultBranchMode } from "./git-defaults";
import { useLiveNewSessionActions, useLiveNewSessionMachines } from "./live-source";
import { PROVIDER_META } from "./provider-meta";
import { runSpawnFlow } from "./spawn-flow";
import type { UseNewSessionActions, UseNewSessionMachines } from "./types";
import {
  buildSpawnRequest,
  canAdvance,
  INITIAL_FORM,
  type NewSessionForm,
  nextStep,
  previousStep,
  WIZARD_STEPS,
  type WizardStep,
} from "./wizard-state";

/** Renders the review step's "Branch:" summary line for `form`'s current `branchMode` (docs/features/worktree-isolation.md Phase 4). */
function branchSummary(form: NewSessionForm): string {
  switch (form.branchMode) {
    case "repo-root":
      return "Repo root";
    case "new-branch":
      return `New branch ${form.branchName.trim()}${form.createWorktree ? " (worktree)" : ""}`;
    case "existing-branch":
      return `Existing branch ${form.branchName.trim()} (worktree)`;
  }
}

const STEP_LABEL: Record<WizardStep, string> = {
  machine: "Machine",
  directory: "Directory",
  import: "Continue session",
  options: "Options",
  review: "Review",
};

type SpawnState =
  | { phase: "idle" }
  | { phase: "spawning" }
  | {
      phase: "pending-approval";
      directory: string;
      action: "create-directory" | "register-workspace";
    }
  | { phase: "success"; sessionId: string }
  | { phase: "error"; message: string };

/**
 * The New Session screen (falcon-system-design.md §9.2 "New session" row,
 * falcon-prd.md FR-7.5/UC5): machine → directory picker → provider/mode/
 * model → (optional branch/worktree) → spawn.
 *
 * `useMachines`/`useActions` are the injectable seams (mirrors
 * `features/session-list`'s `UseSessionListSnapshot` /
 * `features/session-control`'s `UseSessionControl`) — default to the real
 * live machine-list snapshot + `machineRpcToActions(createMachineRpcClient(
 * {...}))` (`live-source.ts`), gated on the chosen machine's unwrapped DEK
 * (`@/lib/use-machine-crypto.ts`); `mock-source.ts`'s fakes stay exported
 * for tests/standalone review, same precedent as `SessionTimelineScreen`'s
 * `useMockSessionControl`.
 */
export function NewSessionScreen({
  useMachines = useLiveNewSessionMachines,
  useActions = useLiveNewSessionActions,
  activeDirectories = [],
}: {
  useMachines?: UseNewSessionMachines;
  useActions?: UseNewSessionActions;
  /**
   * Best-effort set of directories with an already-live session, across
   * whichever machines the caller cares to check (plan.md §16 "Flow 3 —
   * spawn-directory-dedup" item 4) — sourced from the synced session list's
   * `workspaceId` field (`packages/wire/src/rows.ts`'s `SessionRow.
   * workspaceId`, filtered to non-ended sessions), same "a workspaceId IS a
   * directory path" convention `live-actions.ts` already documents. Purely
   * a non-blocking UX hint in `DirectoryStep` — racy across devices, so the
   * daemon's own `spawn`-time dedup guard remains the authoritative check.
   * Defaults to none, matching this screen's other seams (`useMachines`/
   * `useActions`) that aren't wired to a live data source yet either.
   */
  activeDirectories?: string[];
}) {
  const machines = useMachines();
  const [step, setStep] = useState<WizardStep>("machine");
  // Seeded from this device's starred provider/model (docs/competitive-notes-omnara.md
  // #22 "Favorite/star a default machine, provider, and model") — the
  // starred *machine* can't be resolved here since `machines` hasn't loaded
  // yet on first render; see the effect below for that half.
  const [form, setForm] = useState<NewSessionForm>(() => {
    // Settings → Git's per-device default (docs/features/worktree-isolation.md
    // Phase 5) — "new-branch" gets a pre-filled auto-generated name up
    // front so the options step opens ready to go, not with an empty
    // required field.
    const branchMode = getDefaultBranchMode();
    return {
      ...INITIAL_FORM,
      ...applyFavoriteDefaults(INITIAL_FORM),
      branchMode,
      branchName: branchMode === "new-branch" ? generateBranchName() : INITIAL_FORM.branchName,
    };
  });
  const [spawnState, setSpawnState] = useState<SpawnState>({ phase: "idle" });
  const approvalDecision = useRef<((approved: boolean) => void) | null>(null);

  const actions = useActions(form.machineId ?? "");

  function patchForm(patch: Partial<NewSessionForm>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  // Pre-select this device's starred machine once the (async) machine list
  // loads, same "favorite a default" feature as above — only while nothing's
  // been picked yet, and only when the starred machine is actually online
  // (an offline favorite is no more selectable here than any other offline
  // machine).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-check when `machines` changes — reading `form.machineId` here is just this effect's own "already picked" guard, not something it should re-run for.
  useEffect(() => {
    if (form.machineId !== null) return;
    const favoriteId = getFavoriteMachineId();
    if (favoriteId === null) return;
    if (machines.some((m) => m.id === favoriteId && m.online)) {
      patchForm({ machineId: favoriteId });
    }
  }, [machines]);

  function resolveApproval(approved: boolean) {
    approvalDecision.current?.(approved);
    approvalDecision.current = null;
  }

  async function handleCreateSession() {
    setSpawnState({ phase: "spawning" });
    try {
      const request = buildSpawnRequest(form);
      const result = await runSpawnFlow(actions, request, (directory, action) => {
        setSpawnState({ phase: "pending-approval", directory, action });
        return new Promise<boolean>((resolve) => {
          approvalDecision.current = resolve;
        });
      });
      setSpawnState(
        result.outcome === "spawned"
          ? { phase: "success", sessionId: result.sessionId }
          : { phase: "idle" },
      );
    } catch (err) {
      setSpawnState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (spawnState.phase === "success") {
    return (
      <main className="mx-auto flex w-full max-w-md flex-col items-center gap-4 p-8 text-center">
        <p className="text-lg font-semibold">Session started</p>
        <Button asChild>
          <Link href={`/session/${spawnState.sessionId}/`}>Open session</Link>
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold tracking-tight">New session</h1>
        <nav className="flex gap-1 text-xs text-muted-foreground">
          {WIZARD_STEPS.map((s, i) => (
            <span key={s} className={cn(s === step && "font-semibold text-foreground")}>
              {i > 0 && " › "}
              {STEP_LABEL[s]}
            </span>
          ))}
        </nav>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{STEP_LABEL[step]}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {step === "machine" && (
            <MachineStep
              machines={machines}
              selectedId={form.machineId}
              onSelect={(machineId) => patchForm({ machineId, directory: null })}
            />
          )}
          {step === "directory" && form.machineId && (
            <DirectoryStep
              actions={actions}
              directory={form.directory}
              onSelect={(directory) => patchForm({ directory, importCandidate: null })}
              liveDirectories={activeDirectories}
            />
          )}
          {step === "import" && form.directory && (
            <ImportStep
              actions={actions}
              directory={form.directory}
              selected={form.importCandidate}
              onSelect={(importCandidate) => patchForm({ importCandidate })}
            />
          )}
          {step === "options" && form.directory && (
            <OptionsStep
              form={form}
              onChange={patchForm}
              listBranches={actions.listBranches}
              directory={form.directory}
            />
          )}
          {step === "review" && (
            <div className="flex flex-col gap-2 text-sm">
              <p>
                <span className="text-muted-foreground">Machine:</span>{" "}
                {machines.find((m) => m.id === form.machineId)?.name}
              </p>
              <p>
                <span className="text-muted-foreground">Directory:</span> {form.directory}
              </p>
              <p>
                <span className="text-muted-foreground">Continuing from:</span>{" "}
                {form.importCandidate
                  ? form.importCandidate.title?.trim() || form.importCandidate.providerSessionId
                  : "Starting fresh"}
              </p>
              <p className="flex items-center gap-2">
                <span className="text-muted-foreground">Provider:</span>{" "}
                {PROVIDER_META[form.provider].label}
                {PROVIDER_META[form.provider].beta && <Badge variant="warning">Beta</Badge>}
              </p>
              <p>
                <span className="text-muted-foreground">Permission mode:</span>{" "}
                {form.permissionMode}
              </p>
              {form.model.trim() !== "" && (
                <p>
                  <span className="text-muted-foreground">Model:</span> {form.model.trim()}
                </p>
              )}
              <p>
                <span className="text-muted-foreground">Branch:</span> {branchSummary(form)}
              </p>

              {spawnState.phase === "pending-approval" && (
                <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                  <p>
                    <code className="rounded bg-muted px-1 py-0.5">{spawnState.directory}</code>{" "}
                    {spawnState.action === "register-workspace"
                      ? "isn't a Falcon workspace yet. Add it as one?"
                      : "doesn't exist yet. Create it?"}
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => resolveApproval(true)}>
                      {spawnState.action === "register-workspace"
                        ? "Add workspace"
                        : "Create directory"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => resolveApproval(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              {spawnState.phase === "error" && (
                <p className="text-destructive">{spawnState.message}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={() => setStep(previousStep(step))}
          disabled={step === "machine" || spawnState.phase === "spawning"}
        >
          Back
        </Button>
        {step === "review" ? (
          <Button
            onClick={handleCreateSession}
            disabled={spawnState.phase === "spawning" || spawnState.phase === "pending-approval"}
          >
            {spawnState.phase === "spawning" ? "Starting…" : "Create session"}
          </Button>
        ) : (
          <Button onClick={() => setStep(nextStep(step))} disabled={!canAdvance(step, form)}>
            Next
          </Button>
        )}
      </div>
    </main>
  );
}
