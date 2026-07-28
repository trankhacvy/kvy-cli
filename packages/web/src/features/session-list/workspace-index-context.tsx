"use client";

import type { MachineRow, SessionRow } from "@falcon/wire";
import { createContext, useContext, useMemo } from "react";
import { useDedicatedCryptoBridge } from "@/lib/use-crypto-bridge";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { type DecryptedTitles, useDecryptedTitles } from "./use-decrypted-titles";

interface WorkspaceIndexValue {
  sessionRows: SessionRow[];
  machineRows: MachineRow[];
  titles: DecryptedTitles;
  isLoading: boolean;
}

const WorkspaceIndexContext = createContext<WorkspaceIndexValue | null>(null);

const EMPTY_SESSIONS: SessionRow[] = [];
const EMPTY_MACHINES: MachineRow[] = [];

export function WorkspaceIndexProvider({ children }: { children: React.ReactNode }) {
  const titlesBridge = useDedicatedCryptoBridge();
  const query = useSyncSnapshotQuery();

  const sessionRows = query.data?.sessions ?? EMPTY_SESSIONS;
  const machineRows = query.data?.machines ?? EMPTY_MACHINES;
  const titles = useDecryptedTitles(sessionRows, machineRows, titlesBridge);

  const value = useMemo<WorkspaceIndexValue>(
    () => ({ sessionRows, machineRows, titles, isLoading: query.isLoading }),
    [sessionRows, machineRows, titles, query.isLoading],
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
