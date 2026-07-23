"use client";

import { useMemo } from "react";
import { useMachineCrypto } from "@/lib/use-machine-crypto";
import { apiSocket, createMachineRpcClient } from "@/sync";
import { machineRpcToMachineSettingsActions } from "./live-actions";
import type { MachineSettingsActions, UseMachineSettingsActions } from "./types";

const NOT_READY_MESSAGE = "Machine key isn't unwrapped yet — try again in a moment.";

/** Rejects with the same message until `useMachineCrypto` resolves. Structurally satisfies `MachineSettingsActions`, mirroring `features/provider-accounts/use-live-provider-account-actions.ts`'s `pendingProviderAccountActions`. */
function pendingMachineSettingsActions(): MachineSettingsActions {
  return {
    fetchSleepInhibit: () => Promise.reject(new Error(NOT_READY_MESSAGE)),
    setSleepInhibit: () => Promise.reject(new Error(NOT_READY_MESSAGE)),
  };
}

/**
 * Settings → Machines' real `UseMachineSettingsActions` — swap-in
 * replacement for `useMockMachineSettingsActions` (`mock-source.ts`) at the
 * Sleep Inhibit card's call site. Gated on the shared per-machine DEK unwrap
 * (`@/lib/use-machine-crypto.ts`), same precedent as `features/
 * provider-accounts/use-live-provider-account-actions.ts`'s
 * `useLiveProviderAccountActions`.
 */
export const useLiveMachineSettingsActions: UseMachineSettingsActions = (machineId) => {
  const crypto = useMachineCrypto(machineId);

  return useMemo(() => {
    if (!crypto) return pendingMachineSettingsActions();
    return machineRpcToMachineSettingsActions(
      createMachineRpcClient({ socket: apiSocket, crypto, machineId }),
    );
  }, [crypto, machineId]);
};
