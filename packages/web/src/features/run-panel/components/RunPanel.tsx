"use client";

import { Play, RefreshCw, Square } from "lucide-react";
import { MachineOfflineNotice } from "@/components/machine-offline-notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useMachineOnline } from "@/lib/use-machine-online";
import type { RunConfig, RunStatusSnapshot, UseRunPanelActions } from "../types";
import { useLiveRunPanelActions } from "../use-live-run-panel-actions";
import { useRunPanel } from "../use-run-panel";

const RUN_STATE_BADGE: Record<
  RunStatusSnapshot["run"]["state"],
  { label: string; variant: "success" | "secondary" | "outline" }
> = {
  running: { label: "Running", variant: "success" },
  stopped: { label: "Stopped", variant: "secondary" },
  none: { label: "Not started", variant: "outline" },
};

const SETUP_STATE_BADGE: Record<
  RunStatusSnapshot["setup"]["state"],
  { label: string; variant: "success" | "secondary" | "outline" | "destructive" }
> = {
  running: { label: "Running", variant: "secondary" },
  succeeded: { label: "Succeeded", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  "not-run": { label: "Not run", variant: "outline" },
};

function LogTail({ label, text }: { label: string; text: string | undefined }) {
  if (!text) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}

/**
 * `RunPanelBody`'s props — split out from `RunPanel` (mirroring
 * `ChecksPanel.tsx`'s `ChecksBody` extraction) so every rendered state has a
 * direct render test with plain props, no live query/mutation graph
 * required.
 */
export interface RunPanelBodyProps {
  config: RunConfig | undefined;
  isConfigLoading: boolean;
  status: RunStatusSnapshot | undefined;
  isStatusLoading: boolean;
  statusError: string | null;
  onStart: () => void;
  isStartPending: boolean;
  startError: string | null;
  onStop: () => void;
  isStopPending: boolean;
  stopError: string | null;
  onSetup: () => void;
  isSetupPending: boolean;
  setupError: string | null;
  /** Feature 2 (docs/web-ux-improvements-plan.md): `true` once the owning machine is confidently offline/needs-reauth — `||`d into every button's existing disabled expression. */
  machineUnavailable?: boolean;
}

/**
 * Renders the Setup/Run tab's body from already-resolved state
 * (docs/features/setup-run-scripts.md Phase 5): a play/stop button (play
 * disabled with a hint when no `runScript` is configured), a run-state
 * badge + log tail while a run process is (or was) active, and a setup
 * section (state badge, exit code on failure, "Re-run setup" button + its
 * own log tail).
 */
export function RunPanelBody({
  config,
  isConfigLoading,
  status,
  isStatusLoading,
  statusError,
  onStart,
  isStartPending,
  startError,
  onStop,
  isStopPending,
  stopError,
  onSetup,
  isSetupPending,
  setupError,
  machineUnavailable = false,
}: RunPanelBodyProps) {
  if (isConfigLoading || isStatusLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading run panel…</p>;
  }

  if (statusError) {
    return <p className="p-4 text-sm text-destructive">Could not load run status: {statusError}</p>;
  }

  const runState = status?.run.state ?? "none";
  const runBadge = RUN_STATE_BADGE[runState];
  const setupState = status?.setup.state ?? "not-run";
  const setupBadge = SETUP_STATE_BADGE[setupState];
  const hasRunScript = Boolean(config?.runScript);
  const hasSetupScript = Boolean(config?.setupScript);
  const isRunning = runState === "running";

  return (
    <div className="flex flex-col gap-4 p-3">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Run</span>
            <Badge variant={runBadge.variant}>{runBadge.label}</Badge>
          </div>
          {isRunning ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onStop}
              disabled={isStopPending || machineUnavailable}
            >
              <Square className="size-3.5" />
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={onStart}
              disabled={!hasRunScript || isStartPending || machineUnavailable}
              title={
                hasRunScript
                  ? undefined
                  : 'No run script configured. Set one from a terminal: kvy workspace config --run-script "npm run dev"'
              }
            >
              <Play className="size-3.5" />
              Play
            </Button>
          )}
        </div>
        {!hasRunScript && (
          <p className="text-xs text-muted-foreground">
            No run script configured. Set one from a terminal:{" "}
            <code className="rounded bg-muted px-1 py-0.5">
              kvy workspace config --run-script &quot;npm run dev&quot;
            </code>
          </p>
        )}
        {startError && <p className="text-xs text-destructive">{startError}</p>}
        {stopError && <p className="text-xs text-destructive">{stopError}</p>}
        <LogTail label="Run log" text={status?.run.logTail} />
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Setup</span>
            <Badge variant={setupBadge.variant}>{setupBadge.label}</Badge>
            {status?.setup.state === "failed" && status.setup.exitCode !== undefined && (
              <span className="text-xs text-muted-foreground">
                (exit code {status.setup.exitCode})
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={onSetup}
            disabled={
              !hasSetupScript ||
              isSetupPending ||
              status?.setup.state === "running" ||
              machineUnavailable
            }
            title={
              hasSetupScript
                ? undefined
                : 'No setup script configured. Set one from a terminal: kvy workspace config --setup-script "npm install"'
            }
          >
            <RefreshCw className="size-3.5" />
            Re-run setup
          </Button>
        </div>
        {!hasSetupScript && (
          <p className="text-xs text-muted-foreground">
            No setup script configured. Set one from a terminal:{" "}
            <code className="rounded bg-muted px-1 py-0.5">
              kvy workspace config --setup-script &quot;npm install&quot;
            </code>
          </p>
        )}
        {setupError && <p className="text-xs text-destructive">{setupError}</p>}
        <LogTail label="Setup log" text={status?.setup.logTail} />
      </section>
    </div>
  );
}

/**
 * The "Setup / Run" tab (docs/features/setup-run-scripts.md, plan.md §16
 * "17."): play/stop the workspace's configured run script and re-run its
 * setup script, both defined CLI-only (`kvy workspace config
 * --setup-script/--run-script`).
 *
 * `useActions` is the injectable seam — mirrors `GitDiffPanel`/`ChecksPanel`'s
 * own `useActions` prop. Defaults to the real `useLiveRunPanelActions`
 * (gated on the target machine's unwrapped DEK) — `mock-source.ts`'s
 * `useMockRunPanelActions` stays exported for tests/standalone review.
 */
export function RunPanel({
  machineId,
  worktree,
  useActions = useLiveRunPanelActions,
}: {
  machineId: string;
  worktree: string;
  useActions?: UseRunPanelActions;
}) {
  const actions = useActions(machineId);
  const machine = useMachineOnline(machineId);
  const panel = useRunPanel(actions, worktree, !machine.isKnownUnavailable);

  return (
    <>
      <MachineOfflineNotice state={machine} />
      <RunPanelBody
        config={panel.config}
        isConfigLoading={panel.isConfigLoading}
        status={panel.status}
        isStatusLoading={panel.isStatusLoading}
        statusError={panel.statusError}
        onStart={panel.start}
        isStartPending={panel.isStartPending}
        startError={panel.startError}
        onStop={panel.stop}
        isStopPending={panel.isStopPending}
        stopError={panel.stopError}
        onSetup={panel.setup}
        isSetupPending={panel.isSetupPending}
        setupError={panel.setupError}
        machineUnavailable={machine.isKnownUnavailable}
      />
    </>
  );
}
