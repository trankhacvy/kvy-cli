/**
 * apiSocket — public surface for `packages/web/src/sync/`.
 *
 * `apiSocket` is the singleton app code imports. Call `.connect(token)` once
 * auth completes (design §9.1) and register listeners:
 *
 *   apiSocket.on('update', (u) => { ... fast-path or invalidate on gap ... });
 *   apiSocket.on('ephemeral', (e) => { ... activity/attention/presence ... });
 *   apiSocket.on('reconnect', () => queryClient.invalidateQueries());
 *
 * On document visibility change it reports `app-state` to the server so the
 * push pipeline can suppress notifications for a foregrounded tab (§6.4).
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
  SocketFactory,
  SocketLike,
  VisibilitySource,
} from "./apiSocket.js";
export { createApiSocket } from "./apiSocket.js";
export { createSocketFactory } from "./socket-factory.js";
export { createBrowserVisibilitySource } from "./visibility.js";
