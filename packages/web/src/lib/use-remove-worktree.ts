"use client";

import type { WorktreeRemoveResult } from "@kvy/wire";
import { useMachineCrypto } from "@/lib/use-machine-crypto";
import { apiSocket, createMachineRpcClient } from "@/sync";

/**
 * Phase C (new-session-from-web redesign, see `worktreeRemove.ts`'s own
 * doc comment): drives the `worktree.remove` machine RPC through the SAME
 * live per-machine crypto + machine-RPC path `use-restart-session.ts`
 * already uses — this hook is a near-structural clone of that one, same
 * "gated on `useMachineCrypto`, honest 'not ready yet' rejection" shape.
 */
export interface RemoveWorktreeState {
  /** `true` while the target machine's crypto key is still unwrapping. */
  pending: boolean;
  /** Calls `worktree.remove`. Rejects immediately (no RPC round-trip) with a visible message if the machine key isn't unwrapped yet. */
  removeWorktree: (options?: {
    force?: boolean;
    deleteBranch?: boolean;
  }) => Promise<WorktreeRemoveResult>;
}

export function useRemoveWorktree(machineId: string, worktree: string): RemoveWorktreeState {
  const crypto = useMachineCrypto(machineId);

  return {
    pending: crypto === null,
    removeWorktree: async (options = {}) => {
      if (!crypto) {
        throw new Error("Machine key isn't unwrapped yet. Try again in a moment.");
      }
      return createMachineRpcClient({ socket: apiSocket, crypto, machineId }).call(
        "worktree.remove",
        {
          idempotencyKey: randomIdempotencyKey(),
          worktree,
          force: options.force,
          deleteBranch: options.deleteBranch,
        },
      );
    },
  };
}

/** `crypto.randomUUID()` — same idempotency-key minting convention every other caller-retriable machine RPC uses (`live-actions.ts`'s own doc comment). Named to avoid clashing with the `crypto` (bridge client) binding above — that's the crypto-bridge instance, this is the global Web Crypto API. */
function randomIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}
