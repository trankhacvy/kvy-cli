const KEY = "kvy:pwa-install-banner-dismissed";

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getInstallBannerDismissed(): boolean {
  if (!hasLocalStorage()) return false;
  return window.localStorage.getItem(KEY) === "1";
}

export function dismissInstallBanner(): void {
  if (!hasLocalStorage()) return;
  window.localStorage.setItem(KEY, "1");
}

export type InstallBannerMode = "install" | "how-to" | "hidden";

/**
 * The banner's own inputs collapsed into a single render mode, kept pure so
 * the branching is directly unit-testable without mounting the component
 * (same precedent as `features/settings/devices-revoke-state.ts`).
 */
export function getInstallBannerMode(input: {
  isInstalled: boolean;
  dismissed: boolean;
  canInstall: boolean;
  isIos: boolean;
}): InstallBannerMode {
  if (input.isInstalled || input.dismissed) return "hidden";
  if (input.canInstall) return "install";
  if (input.isIos) return "how-to";
  return "hidden";
}
