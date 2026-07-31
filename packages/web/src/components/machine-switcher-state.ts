import type { SessionListMachine } from "@/features/session-list";

const KEY = "falcon:sidebar-selected-machine";

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getSelectedMachineId(): string | null {
  if (!hasLocalStorage()) return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setSelectedMachineId(id: string): void {
  if (!hasLocalStorage()) return;
  window.localStorage.setItem(KEY, id);
}

/** The machine a machine-scoped screen (the sidebar switcher, Home's session
 * filter) should treat as "current" — the explicitly persisted choice if it
 * still names a real machine, else the first online one, else just the
 * first machine on the account. `null` only when there are no machines at
 * all. Shared by `MachineSwitcher` (what it displays as selected) and
 * `SessionListScreen` (what it filters Home's list to) so the two can never
 * disagree about which machine is "the current one." */
export function resolveSelectedMachine(
  machines: readonly SessionListMachine[],
  selectedId: string | null,
): SessionListMachine | null {
  const stored = selectedId ? machines.find((m) => m.id === selectedId) : undefined;
  if (stored) return stored;
  return machines.find((m) => m.status === "online") ?? machines[0] ?? null;
}
