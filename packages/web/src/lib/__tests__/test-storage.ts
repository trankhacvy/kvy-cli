/**
 * Minimal `Storage`-shaped in-memory stand-in for `window.localStorage` /
 * `window.sessionStorage` — this package's vitest config runs under
 * `environment: "node"` (no jsdom, see `packages/web/vitest.config.ts`), so
 * `window` doesn't exist at all by default. `session.ts`, `pending-pair.ts`,
 * and `oauth.ts` all guard/branch on `window`/`window.localStorage` existing,
 * so tests for their "browser present" branches need *some* stand-in — this
 * is the smallest one that satisfies the `Storage` interface those modules
 * actually call (`getItem`/`setItem`/`removeItem`).
 */
export function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}
