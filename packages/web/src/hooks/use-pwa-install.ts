"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  ensureInstallListeners,
  getInstallSnapshot,
  type InstallPromptOutcome,
  promptInstall,
  subscribeToInstall,
} from "@/lib/pwa-install";

export function usePwaInstall(): {
  canInstall: boolean;
  isInstalled: boolean;
  install: () => Promise<InstallPromptOutcome | "unavailable">;
} {
  const snapshot = useSyncExternalStore(
    (onStoreChange) => {
      ensureInstallListeners();
      return subscribeToInstall(onStoreChange);
    },
    getInstallSnapshot,
    () => ({ canInstall: false, isInstalled: false }),
  );

  const install = useCallback(() => promptInstall(), []);

  return {
    canInstall: snapshot.canInstall,
    isInstalled: snapshot.isInstalled,
    install,
  };
}
