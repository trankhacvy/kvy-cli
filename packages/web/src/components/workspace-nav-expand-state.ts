const KEY = "kvy:sidebar-expanded-workspaces";

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getExpandedWorkspaces(): Set<string> {
  if (!hasLocalStorage()) return new Set();
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

export function setWorkspaceExpanded(id: string, expanded: boolean): void {
  if (!hasLocalStorage()) return;
  const set = getExpandedWorkspaces();
  if (expanded) set.add(id);
  else set.delete(id);
  window.localStorage.setItem(KEY, JSON.stringify([...set]));
}
