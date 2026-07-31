"use client";

import type { MachineRow, SessionRow } from "@falcon/wire";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  getSelectedMachineId,
  setSelectedMachineId as persistSelectedMachineId,
} from "@/components/machine-switcher-state";
import { useDedicatedCryptoBridge } from "@/lib/use-crypto-bridge";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { type DecryptedTitles, useDecryptedTitles } from "./use-decrypted-titles";

interface WorkspaceIndexValue {
  sessionRows: SessionRow[];
  machineRows: MachineRow[];
  titles: DecryptedTitles;
  isLoading: boolean;
  /** The sidebar `MachineSwitcher`'s persisted choice, or `null` if the user
   * has never picked one this device — resolve against a real machine list
   * (`resolveSelectedMachine`, `machine-switcher-state.ts`) before using it,
   * never compare directly against a machine id. */
  selectedMachineId: string | null;
  selectMachine: (id: string) => void;
}

const WorkspaceIndexContext = createContext<WorkspaceIndexValue | null>(null);

const EMPTY_SESSIONS: SessionRow[] = [];
const EMPTY_MACHINES: MachineRow[] = [];

export function WorkspaceIndexProvider({ children }: { children: React.ReactNode }) {
  const titlesBridge = useDedicatedCryptoBridge();
  const query = useSyncSnapshotQuery();
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(() =>
    getSelectedMachineId(),
  );

  const sessionRows = query.data?.sessions ?? EMPTY_SESSIONS;
  const machineRows = query.data?.machines ?? EMPTY_MACHINES;
  const titles = useDecryptedTitles(sessionRows, machineRows, titlesBridge);

  const selectMachine = useCallback((id: string) => {
    setSelectedMachineId(id);
    persistSelectedMachineId(id);
  }, []);

  const value = useMemo<WorkspaceIndexValue>(
    () => ({
      sessionRows,
      machineRows,
      titles,
      isLoading: query.isLoading,
      selectedMachineId,
      selectMachine,
    }),
    [sessionRows, machineRows, titles, query.isLoading, selectedMachineId, selectMachine],
  );

  return <WorkspaceIndexContext.Provider value={value}>{children}</WorkspaceIndexContext.Provider>;
}

export function useWorkspaceIndexContext(): WorkspaceIndexValue {
  const ctx = useContext(WorkspaceIndexContext);
  if (!ctx) {
    throw new Error("useWorkspaceIndexContext must be used within a WorkspaceIndexProvider");
  }
  return ctx;
}
