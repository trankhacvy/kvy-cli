/**
 * `packages/web/src/sync/` — public surface: `apiSocket` (the WS transport)
 * plus the sync engine that reconciles it into a TanStack Query cache.
 *
 * `apiSocket` is the singleton app code imports. Call `.connect(token)` once
 * auth completes (design §9.1), then wire the engine up once:
 *
 *   const engine = createSyncEngine(queryClient, apiSocket);
 *   apiSocket.on('ephemeral', (e) => { ... activity/attention/presence ... });
 *   // ... later, on logout/teardown:
 *   engine.dispose();
 *   apiSocket.disconnect();
 *
 * `apiSocket` satisfies `SyncSocketSource` (`on('update'|'reconnect', ...)`)
 * structurally, so no adapter is needed between the two. On document
 * visibility change `apiSocket` also reports `app-state` to the server so
 * the push pipeline can suppress notifications for a foregrounded tab
 * (§6.4).
 *
 * See `engine.ts` for the fast-path/gap-invalidation design and
 * `queryKeys.ts` for the Query key contract shared with whatever hooks own
 * the underlying `useQuery(['sync'], ...)` / `useInfiniteQuery(['messages',
 * sessionId], ...)` fetches.
 */
import { createApiSocket } from "./apiSocket.js";
import { createSocketFactory } from "./socket-factory.js";
import { createBrowserVisibilitySource } from "./visibility.js";

export const apiSocket = createApiSocket(createSocketFactory(), createBrowserVisibilitySource());

export type {
  ApiSocket,
  ApiSocketAuth,
  AppState,
  ClientType,
  RpcCallResult,
  SocketFactory,
  SocketLike,
  VisibilitySource,
} from "./apiSocket.js";
export { createApiSocket } from "./apiSocket.js";
export type { SyncEngine, SyncSocketSource } from "./engine.js";
export { createSyncEngine } from "./engine.js";
export type {
  MachineRpcClient,
  MachineRpcCrypto,
  MachineRpcMethod,
  MachineRpcParams,
  MachineRpcResults,
} from "./machineRpc.js";
export { createMachineRpcClient, MachineRpcError } from "./machineRpc.js";
export type { MessageDecryptor } from "./messages.js";
export { decryptMessageBatches } from "./messages.js";
export {
  isSyncQueryKey,
  messagesQueryKey,
  messagesSessionIdFromKey,
  syncQueryKey,
} from "./queryKeys.js";
export type {
  InterruptResult,
  MessageRpcParams,
  MessageRpcResult,
  PermAnswerParams,
  PermAnswerResult,
  SessionRpcClient,
  SessionRpcCrypto,
  SessionRpcMethod,
  SessionRpcParams,
  SessionRpcResults,
  SetModeParams,
  SetModeResult,
  TakeControlResult,
} from "./sessionRpc.js";
export { createSessionRpcClient, SessionRpcError } from "./sessionRpc.js";
export { createSocketFactory } from "./socket-factory.js";
export type { MessageItem, MessagesPage, MessagesQueryData, SyncSnapshot } from "./types.js";
export { createBrowserVisibilitySource } from "./visibility.js";
