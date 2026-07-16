/**
 * `packages/web/src/sync/` — public surface.
 *
 * Wire the engine up once, after `apiSocket.connect(token)` (design §9.1):
 *
 *   const engine = createSyncEngine(queryClient, apiSocket);
 *   // ... later, on logout/teardown:
 *   engine.dispose();
 *
 * See `engine.ts` for the fast-path/gap-invalidation design and
 * `queryKeys.ts` for the Query key contract shared with whatever hooks own
 * the underlying `useQuery(['sync'], ...)` / `useInfiniteQuery(['messages',
 * sessionId], ...)` fetches.
 */

export type { SyncEngine, SyncSocketSource } from "./engine.js";
export { createSyncEngine } from "./engine.js";
export {
  isSyncQueryKey,
  messagesQueryKey,
  messagesSessionIdFromKey,
  syncQueryKey,
} from "./queryKeys.js";
export type { MessageItem, MessagesPage, MessagesQueryData, SyncSnapshot } from "./types.js";
