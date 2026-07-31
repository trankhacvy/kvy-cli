"use client";

import { useMemo } from "react";
import { resolveSelectedMachine } from "@/components/machine-switcher-state";
import type { RenderItem } from "@/sync/reducer";
import { groupSessionsByWorkspace, UNGROUPED_WORKSPACE_ID, type WorkspaceGroup } from "./group";
import { buildSnapshot } from "./live-source";
import type { AttentionKind, SessionListMachine } from "./types";
import type { MachinePresence } from "./use-machine-presence";
import { useWorkspaceIndexContext } from "./workspace-index-context";

const EMPTY_PRESENCE = new Map<string, MachinePresence>();
const EMPTY_ITEMS = new Map<string, RenderItem[]>();
const EMPTY_ATTENTION = new Map<string, AttentionKind>();

export function useWorkspaceNavGroups(): {
  groups: WorkspaceGroup[];
  machinesById: Map<string, SessionListMachine>;
  isLoading: boolean;
} {
  const { sessionRows, machineRows, titles, isLoading, selectedMachineId } =
    useWorkspaceIndexContext();

  const snapshot = useMemo(
    () =>
      buildSnapshot(sessionRows, machineRows, titles, EMPTY_PRESENCE, EMPTY_ITEMS, EMPTY_ATTENTION),
    [sessionRows, machineRows, titles],
  );

  // Same current-machine resolution the sidebar `MachineSwitcher` displays
  // (`resolveSelectedMachine`) — keeps this nav scoped to whichever machine
  // is highlighted there, mirroring `live-source.ts`'s Home-screen filter.
  const currentMachine = useMemo(
    () => resolveSelectedMachine(snapshot.machines, selectedMachineId),
    [snapshot.machines, selectedMachineId],
  );

  const activeSessions = useMemo(
    () =>
      snapshot.sessions.filter(
        (s) => s.status !== "archived" && (!currentMachine || s.machineId === currentMachine.id),
      ),
    [snapshot, currentMachine],
  );

  const groups = useMemo(
    () =>
      groupSessionsByWorkspace({ ...snapshot, sessions: activeSessions }).filter(
        (g) => g.workspace.id !== UNGROUPED_WORKSPACE_ID,
      ),
    [snapshot, activeSessions],
  );

  const machinesById = useMemo(() => new Map(snapshot.machines.map((m) => [m.id, m])), [snapshot]);

  return { groups, machinesById, isLoading };
}
