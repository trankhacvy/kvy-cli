"use client";

import {
  MachineBadge,
  type SessionListMachine,
  useLiveSessionListSnapshot,
} from "@/features/session-list";
import type { UseMachineSettingsActions } from "../types";
import { useLiveMachineSettingsActions } from "../use-live-machine-settings-actions";
import { SleepInhibitCard } from "./SleepInhibitCard";

/**
 * Settings → Machines (docs/features/sleep-inhibit.md, docs/
 * competitive-notes-omnara.md #12 "Sleep-inhibit control"): one section per
 * known machine, each with a Sleep Inhibit card. Structural clone of
 * `features/provider-accounts/components/ProvidersSettingsScreen.tsx` —
 * reuses `features/session-list`'s `useLiveSessionListSnapshot` for the
 * machine list (id/decrypted name/online) rather than re-deriving it, same
 * "one place owns this" reasoning.
 *
 * Rendered inside the settings dialog's content pane
 * (`components/settings-dialog.tsx`) since the `/settings/machines/` route
 * was removed — the pane supplies the section heading, so this component is
 * content-only (no page chrome of its own).
 *
 * `useSnapshot`/`useActions` are the injectable seams (mirrors
 * `ProvidersSettingsScreen`'s own props) — defaulting to the real
 * `useLiveSessionListSnapshot`/`useLiveMachineSettingsActions`, with
 * `mock-source.ts`'s mock kept available for tests/standalone review.
 */
export function MachinesSettingsScreen({
  useSnapshot = useLiveSessionListSnapshot,
  useActions = useLiveMachineSettingsActions,
}: {
  useSnapshot?: typeof useLiveSessionListSnapshot;
  useActions?: UseMachineSettingsActions;
}) {
  const snapshot = useSnapshot();

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Per-machine settings — sleep inhibit keeps a Mac from sleeping mid-session.
      </p>

      {snapshot.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading machines…</p>
      ) : snapshot.machines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No machines registered yet — start a session from a machine to see its settings here.
        </p>
      ) : (
        <div className="flex flex-col gap-8">
          {snapshot.machines.map((machine) => (
            <MachineSettingsSection key={machine.id} machine={machine} useActions={useActions} />
          ))}
        </div>
      )}
    </div>
  );
}

function MachineSettingsSection({
  machine,
  useActions,
}: {
  machine: SessionListMachine;
  useActions: UseMachineSettingsActions;
}) {
  const actions = useActions(machine.id);

  return (
    <section className="flex flex-col gap-3">
      <MachineBadge machine={machine} />
      <SleepInhibitCard machineId={machine.id} actions={actions} />
    </section>
  );
}
