"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DirectoryStep } from "./components/directory-step";
import { ImportStep } from "./components/import-step";
import { MachineStep } from "./components/machine-step";
import { OptionsStep } from "./components/options-step";
import { useMockNewSessionActions, useMockNewSessionMachines } from "./mock-source";
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
  | { phase: "pending-approval"; directory: string }
  | { phase: "success"; sessionId: string }
  | { phase: "error"; message: string };

/**
 * The New Session screen (falcon-system-design.md §9.2 "New session" row,
 * falcon-prd.md FR-7.5/UC5): machine → directory picker → provider/mode/
 * model → (optional branch/worktree) → spawn.
 *
 * `useMachines`/`useActions` are the injectable seams (mirrors
 * `features/session-list`'s `UseSessionListSnapshot` /
 * `features/session-control`'s `UseSessionControl`) — mock by default, a
 * real machine-list snapshot + `machineRpcToActions(createMachineRpcClient(
 * {...}))` (`live-actions.ts`) once a screen has a live `apiSocket` + a
 * crypto client holding the chosen machine's unwrapped DEK.
 */
export function NewSessionScreen({
  useMachines = useMockNewSessionMachines,
  useActions = useMockNewSessionActions,
}: {
  useMachines?: UseNewSessionMachines;
  useActions?: UseNewSessionActions;
}) {
  const machines = useMachines();
  const [step, setStep] = useState<WizardStep>("machine");
  const [form, setForm] = useState<NewSessionForm>(INITIAL_FORM);
  const [spawnState, setSpawnState] = useState<SpawnState>({ phase: "idle" });
  const approvalDecision = useRef<((approved: boolean) => void) | null>(null);

  const actions = useActions(form.machineId ?? "");

  function patchForm(patch: Partial<NewSessionForm>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function resolveApproval(approved: boolean) {
    approvalDecision.current?.(approved);
    approvalDecision.current = null;
  }

  async function handleCreateSession() {
    setSpawnState({ phase: "spawning" });
    try {
      const request = buildSpawnRequest(form);
      const result = await runSpawnFlow(actions, request, (directory) => {
        setSpawnState({ phase: "pending-approval", directory });
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
          {step === "options" && <OptionsStep form={form} onChange={patchForm} />}
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
              {form.branchEnabled && (
                <p>
                  <span className="text-muted-foreground">Branch:</span> {form.branchName.trim()}
                  {form.createWorktree ? " (new worktree)" : ""}
                </p>
              )}

              {spawnState.phase === "pending-approval" && (
                <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                  <p>
                    <code className="rounded bg-muted px-1 py-0.5">{spawnState.directory}</code>{" "}
                    doesn&apos;t exist yet. Create it?
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => resolveApproval(true)}>
                      Create directory
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
