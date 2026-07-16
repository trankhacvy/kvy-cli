import { eq } from "drizzle-orm";
import { pushSubscriptions } from "../../db/schema.js";
import type { Database } from "../../db/types.js";
import { channels } from "./channels/index.js";
import { createRenotifyScheduler } from "./renotify.js";
import type { LifecycleKind, PresencePort, PushDispatcherPort } from "./types.js";

/**
 * Port of Happy's dispatch model (`happy-server/sources/app/push/
 * pushDispatch.ts`, plan.md §10): lifecycle events only (`perm`, `question`,
 * `done`/turn-completed, `failed`) — generic per-message pushes were
 * explicitly ruled out by both Happy and Omnara's own postmortems (one buzz
 * every 10s during a turn, no useful title). Never called for message
 * inserts, only from the small set of dedicated lifecycle-signal routes
 * (`sessionStatus.ts`'s `failed` transition, `sessionNotify.ts`'s `perm`/
 * `question`/`done`).
 *
 * Falcon add vs. Happy: presence suppression here also require the session's
 * room to be joined (`PresencePort.hasActiveVisibleClient`), not just "any
 * non-machine client connected" — see `eventRouter.ts`'s implementation and
 * its comment on how that room-scoping degrades gracefully today.
 *
 * Falcon add vs. Happy: `pushSubscriptions.channel` fans out to a pluggable
 * `channels` registry (`webpush` | `telegram` | `ntfy`) instead of a single
 * hardcoded Expo sender — iOS Web Push is unreliable and the notification
 * IS the product (plan.md §10).
 *
 * `dispatch` never rejects: every failure (presence check, subscription
 * lookup, a channel's `send`) is caught and logged so a broken push path
 * never takes down the caller's request/response cycle — callers invoke
 * this fire-and-forget (`void dispatcher.dispatch(...)`), same as Happy's
 * `void dispatchSessionEventPush(...)`.
 *
 * Falcon add — re-notify scheduling (design §6.4, plan.md §10's "Server
 * dispatch" bullet): a `perm`/`question` dispatch is a request awaiting a
 * human answer, so after the initial attempt this arms up to two follow-up
 * attempts at +5 min and +10 min (max 3 notifications total) via
 * `./renotify.js`'s `RenotifyScheduler`. Each follow-up re-runs the exact
 * same presence-checked, per-channel attempt as the initial dispatch — a
 * visible client suppresses a follow-up exactly the way it suppresses the
 * first push. A later dispatch for the same session (a new perm-request, or
 * a terminal `done`/`failed`) cancels any schedule still pending.
 */
export function buildPushDispatcher(db: Database, presence: PresencePort): PushDispatcherPort {
  const scheduler = createRenotifyScheduler();

  async function attempt(params: {
    accountId: string;
    sessionId: string;
    kind: LifecycleKind;
  }): Promise<void> {
    const { accountId, sessionId, kind } = params;
    try {
      try {
        if (await presence.hasActiveVisibleClient(accountId, sessionId)) {
          return; // suppressed — a visible client already shows this in-app
        }
      } catch (err) {
        // Fail OPEN on a broken presence check (Happy's own comment: "Presence
        // check failed, sending push anyway") — a presence bug must never
        // silently swallow a real notification.
        console.error({ module: "push" }, `presence check failed, dispatching anyway: ${err}`);
      }

      const subs = await db.query.pushSubscriptions.findMany({
        where: eq(pushSubscriptions.accountId, accountId),
      });
      if (subs.length === 0) return;

      await Promise.all(
        subs.map(async (sub) => {
          const channel = channels[sub.channel as keyof typeof channels];
          if (!channel) {
            console.error(
              { module: "push" },
              `unknown push channel "${sub.channel}" for subscription ${sub.id}`,
            );
            return;
          }
          try {
            await channel.send(sub, { sessionId, kind });
          } catch (err) {
            const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
            if (statusCode === 404 || statusCode === 410) {
              // The push service says this endpoint is gone for good (expired/
              // unsubscribed) — prune it so future dispatches stop retrying it.
              // Mirrors Happy's DeviceNotRegistered cleanup in pushDispatch.ts.
              await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
              return;
            }
            console.error(
              { module: "push" },
              `channel "${sub.channel}" send failed for subscription ${sub.id}: ${err}`,
            );
          }
        }),
      );
    } catch (err) {
      console.error({ module: "push" }, `lifecycle dispatch failed: ${err}`);
    }
  }

  return {
    async dispatch(params) {
      await attempt(params);
      scheduler.onDispatch({
        sessionId: params.sessionId,
        kind: params.kind,
        retry: () => attempt(params),
      });
    },
  };
}
