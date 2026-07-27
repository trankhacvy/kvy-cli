const overrides = new Map<string, string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function setTitleOverride(id: string, title: string): void {
  overrides.delete(id);
  overrides.set(id, title);
  notify();
}

export function clearTitleOverride(id: string): void {
  if (overrides.delete(id)) notify();
}

export function getTitleOverrideSnapshot(): string | null {
  if (overrides.size === 0) return null;
  let last: string | null = null;
  for (const value of overrides.values()) last = value;
  return last;
}

export function subscribeToTitle(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
