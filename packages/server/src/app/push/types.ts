import type { LifecycleKind } from "@kvy/wire";
import type { pushSubscriptions } from "../../db/schema.js";

export type { LifecycleKind };

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/**
 * any user-scoped connection reports `app-state: active` and has the
 * session's room joined"). Narrowed to this one method — like
 * `EventRouterPort` next door — so tests can inject a fake instead of a real
 * Socket.IO server. The real implementation is `eventRouter`'s
 * `hasActiveVisibleClient` (events/eventRouter.ts).
 */
export interface PresencePort {
  hasActiveVisibleClient(accountId: string, sessionId: string): Promise<boolean>;
}

/**
 * fallback channels"). `send` throwing is the normal way to report failure —
 * `dispatch.ts` catches per-subscription so one dead endpoint never blocks
 * the others. A thrown error with a `statusCode` of 404/410 is treated as
 * `DeviceNotRegistered` cleanup in `pushDispatch.ts`).
 */
export interface PushChannel {
  send(
    sub: PushSubscriptionRow,
    payload: { sessionId: string; kind: LifecycleKind },
  ): Promise<void>;
}

export interface PushDispatcherPort {
  dispatch(params: { accountId: string; sessionId: string; kind: LifecycleKind }): Promise<void>;
}
