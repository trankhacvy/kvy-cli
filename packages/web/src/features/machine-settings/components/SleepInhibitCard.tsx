"use client";

import { TriangleAlertIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { MachineSettingsActions, SleepInhibitMode } from "../types";
import { useMachineSettings } from "../use-machine-settings";

const MODE_LABELS: Record<SleepInhibitMode, string> = {
  off: "Off",
  onPower: "While on Power",
  always: "Always",
};

const MODE_OPTIONS: SleepInhibitMode[] = ["off", "onPower", "always"];

/**
 * Settings → Machines' Sleep Inhibit card (docs/features/sleep-inhibit.md,
 * docs/competitive-notes-omnara.md #12 "Sleep-inhibit control"): a tri-state
 * control (Off / While on Power / Always) driven by `use-machine-settings`.
 * Structural clone of `features/provider-accounts/components/
 * ProviderAccountCard.tsx`'s state-by-state render shape.
 *
 * Gating comes entirely from the `sleepInhibit.get`/`sleepInhibit.set` RPC
 * result (`supported`/`platform`/`mode`/`active`) — never from any machine
 * metadata field, matching the plan's corrected approach (session-list's
 * `SessionListMachine` decrypts no `platform` field to gate on).
 */
export function SleepInhibitCard({
  machineId,
  actions,
}: {
  machineId: string;
  actions: MachineSettingsActions;
}) {
  const { state, error, isLoading, isSaving, saveError, setMode } = useMachineSettings(
    actions,
    machineId,
  );

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Sleep Inhibit</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-48" />
          </div>
        ) : error ? (
          <p className="text-sm text-muted-foreground">
            Machine unreachable — settings live on the machine itself. ({error})
          </p>
        ) : !state ? null : (
          <>
            <Select
              value={state.mode}
              onValueChange={(value) => setMode(value as SleepInhibitMode)}
              disabled={!state.supported || isSaving}
            >
              <SelectTrigger size="sm" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODE_OPTIONS.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {!state.supported ? (
              <p className="text-sm text-muted-foreground">
                Sleep inhibit is only available on macOS (this machine reports {state.platform}).
              </p>
            ) : state.mode !== "off" && !state.active ? (
              <p className="flex items-center gap-1.5 text-sm text-destructive">
                <TriangleAlertIcon className="size-3.5 shrink-0" />
                Not currently holding the assertion — caffeinate may have failed to start.
              </p>
            ) : null}

            {saveError ? <p className="text-sm text-destructive">{saveError}</p> : null}

            <p className="text-xs text-muted-foreground">
              While on Power holds the Mac awake only on AC power. Always also prevents idle sleep
              on battery. Neither can keep a MacBook awake with the lid closed on battery power, and
              Always will drain the battery while the Falcon daemon runs.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
