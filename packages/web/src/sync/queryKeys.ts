/**
 * request-shaped state — messages pagination, sync snapshot"). The sync
 * engine's `setQueryData`/`invalidateQueries` calls and whatever hook
 * eventually owns the matching `useQuery`/`useInfiniteQuery` must agree on
 * the exact key shape — centralizing it here is the only guarantee of that.
 */

/** `GET /v1/sync` account snapshot (headerSeq, sessions, machines, unmanagedSessions). */
export const syncQueryKey = ["sync"] as const;

/** `GET /v1/sessions/:id/messages`, paginated by `before` cursor. */
export function messagesQueryKey(sessionId: string): readonly [string, string] {
  return ["messages", sessionId] as const;
}

/** Type guard mirroring `syncQueryKey`'s shape — used by the engine's Query
 * cache subscription to recognize the sync snapshot without importing
 * TanStack's `QueryKey` machinery into this tiny module. */
export function isSyncQueryKey(key: readonly unknown[]): boolean {
  return key.length === 1 && key[0] === "sync";
}

/** Extracts the session id from a query key shaped like `messagesQueryKey`,
 * or `null` if the key belongs to some other query. */
export function messagesSessionIdFromKey(key: readonly unknown[]): string | null {
  if (key.length === 2 && key[0] === "messages" && typeof key[1] === "string") {
    return key[1];
  }
  return null;
}
