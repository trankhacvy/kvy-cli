export type InstallPromptOutcome = "accepted" | "dismissed";

export interface BeforeInstallPromptEventLike extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{ outcome: InstallPromptOutcome; platform: string }>;
  prompt(): Promise<void>;
}

type Listener = () => void;

interface InstallState {
  deferred: BeforeInstallPromptEventLike | null;
  installed: boolean;
  listening: boolean;
}

const state: InstallState = {
  deferred: null,
  installed: false,
  listening: false,
};

const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

function onBeforeInstallPrompt(event: Event): void {
  event.preventDefault();
  state.deferred = event as BeforeInstallPromptEventLike;
  notify();
}

function onAppInstalled(): void {
  state.installed = true;
  state.deferred = null;
  notify();
}

export function ensureInstallListeners(): void {
  if (typeof window === "undefined" || state.listening) return;
  state.listening = true;
  window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  window.addEventListener("appinstalled", onAppInstalled);
  if (isStandaloneDisplay()) {
    state.installed = true;
  }
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

let cachedSnapshot: { canInstall: boolean; isInstalled: boolean } = {
  canInstall: false,
  isInstalled: false,
};

/** Returns the SAME object reference across calls whenever the derived
 * values haven't changed - `useSyncExternalStore` compares snapshots by
 * reference, so a getter that allocates a new object every call looks like
 * a change on every render and loops forever. */
export function getInstallSnapshot(): {
  canInstall: boolean;
  isInstalled: boolean;
} {
  const canInstall = state.deferred !== null && !state.installed;
  const isInstalled = state.installed;
  if (cachedSnapshot.canInstall !== canInstall || cachedSnapshot.isInstalled !== isInstalled) {
    cachedSnapshot = { canInstall, isInstalled };
  }
  return cachedSnapshot;
}

export function subscribeToInstall(listener: Listener): () => void {
  ensureInstallListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function promptInstall(): Promise<InstallPromptOutcome | "unavailable"> {
  ensureInstallListeners();
  if (!state.deferred) return "unavailable";
  const event = state.deferred;
  state.deferred = null;
  notify();
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === "accepted") {
    state.installed = true;
  }
  notify();
  return outcome;
}

/** Test-only reset for module listeners/state. */
export function __resetInstallStateForTests(): void {
  if (typeof window !== "undefined" && state.listening) {
    window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.removeEventListener("appinstalled", onAppInstalled);
  }
  state.deferred = null;
  state.installed = false;
  state.listening = false;
  listeners.clear();
}
