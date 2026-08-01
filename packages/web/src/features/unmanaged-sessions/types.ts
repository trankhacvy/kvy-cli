import type { SessionListMachine } from "@/features/session-list";

/**
 * View-model types for the unmanaged-session section (kvy-system-design.md
 * §9.2 "Home" row: `UnmanagedSection`; §11/§10.4 UC9 "Session adoption").
 * `UnmanagedSessionItem` mirrors `@kvy/wire`'s `UnmanagedSessionRow` with
 * its `summary` `EncryptedBox` already decrypted — same convention as
 * `features/session-list/types.ts`'s `SessionListSession` (decrypted
 * upstream of these screens, a separate not-yet-wired crypto-bridge
 * concern, design §5.3).
 */
export interface UnmanagedSessionItem {
  id: string;
  machineId: string;
  workspaceId: string;
  /** The provider's own session id (`AdoptTakeParams`/`AdoptMirrorParams`'s
   * `providerSessionId`) — distinct from `id` (this row's Kvy-side id) —
   * every `adopt.*` RPC call addresses the provider session directly. */
  providerRef: string;
  /** Decrypted `UnmanagedSessionSummary.title`
   * (`packages/cli/src/daemon/unmanagedSessionClient.ts`). */
  title: string;
  /** Decrypted `UnmanagedSessionSummary.lastActivity`. */
  lastActivityAt: number;
  /** Decrypted `UnmanagedSessionSummary.running` — best-effort liveness from
   * the daemon's process scan (design §8). */
  running: boolean;
  /** Row-level `updatedAt` (design §6.1) — when this upsert last landed,
   * distinct from `lastActivityAt` (a fact *about* the transcript). */
  updatedAt: number;
}

export interface UnmanagedSessionsSnapshot {
  machines: SessionListMachine[];
  sessions: UnmanagedSessionItem[];
}

/** Injectable data source for the unmanaged-session section — mirrors
 * `features/session-list`'s `UseSessionListSnapshot` seam. */
export type UseUnmanagedSessionsSnapshot = () => UnmanagedSessionsSnapshot;

/** One chunk of a transcript mirror read (mirrors `@kvy/wire`'s
 * `AdoptMirrorResult`, minus the not-yet-wired `blobRef` fallback field —
 * this screen only ever exercises the inline-chunk path). */
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

/**
 * The RPC surface the mirror view + Take Over / Fork Instead dialog need,
 * seamed off from *how* those calls reach the daemon — mirrors
 * `features/new-session`'s `NewSessionActions` / `features/session-control`'s
 * `SessionControlActions` pattern. Mock by default (`mock-source.ts`),
 * swapped for `machineRpcToUnmanagedActions(createMachineRpcClient({...}))`
 * (`live-actions.ts`) once a screen has a live `apiSocket` + a crypto client
 * holding the chosen machine's unwrapped DEK.
 */
export interface UnmanagedActions {
  /** Reads one ≤64KB chunk of `providerSessionId`'s transcript starting at
   * `cursor` (byte offset; omitted reads from the start). Throws on failure
   * (unreachable machine, transcript no longer exists, ...). */
  mirror(providerSessionId: string, cursor?: number): Promise<MirrorChunk>;
  /** Takes over (`mode: 'takeover'`, interrupts a still-running process) or
   * forks (`mode: 'fork'`, leaves the original alone) `providerSessionId`
   * into a new managed session. Throws on failure. */
  take(providerSessionId: string, mode: AdoptMode): Promise<AdoptTakeOutcome>;
}

/** One actions client per chosen machine — mirrors
 * `UseNewSessionActions = (machineId) => NewSessionActions`. */
export type UseUnmanagedActions = (machineId: string) => UnmanagedActions;
