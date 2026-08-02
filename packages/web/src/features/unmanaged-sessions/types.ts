import type { SessionListMachine } from "@/features/session-list";

export interface UnmanagedSessionItem {
  id: string;
  machineId: string;
  workspaceId: string;
  /** The provider's own session id - distinct from `id` (Kvy-side row id).
   * Every `adopt.*` RPC call addresses the provider session directly. */
  providerRef: string;
  title: string;
  lastActivityAt: number;
  /** Best-effort liveness from the daemon's process scan. */
  running: boolean;
  /** When this upsert last landed - distinct from `lastActivityAt` (a fact about the transcript). */
  updatedAt: number;
}

export interface UnmanagedSessionsSnapshot {
  machines: SessionListMachine[];
  sessions: UnmanagedSessionItem[];
}

/** Injectable data source for the unmanaged-session section — mirrors
 * `features/session-list`'s `UseSessionListSnapshot` seam. */
export type UseUnmanagedSessionsSnapshot = () => UnmanagedSessionsSnapshot;

/** One chunk of a transcript mirror read. */
export interface MirrorChunk {
  chunk: string;
  nextCursor: number | null;
  done: boolean;
}

export type AdoptMode = "takeover" | "fork";

/** Mirrors `@kvy/wire`'s `AdoptTakeResult`. */
export interface AdoptTakeOutcome {
  sessionId: string;
  warning?: string;
}

/** RPC surface for the mirror view and Take Over dialog. Mock by default; swap for
 * `machineRpcToUnmanagedActions(createMachineRpcClient({...}))` once wired up. */
export interface UnmanagedActions {
  mirror(providerSessionId: string, cursor?: number): Promise<MirrorChunk>;
  take(providerSessionId: string, mode: AdoptMode): Promise<AdoptTakeOutcome>;
}

export type UseUnmanagedActions = (machineId: string) => UnmanagedActions;
