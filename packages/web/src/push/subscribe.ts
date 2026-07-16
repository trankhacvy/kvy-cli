/**
 * Web Push subscribe/unsubscribe (design §8.5/§9.3, FR-7.6). Registers the
 * service worker at `/sw.js` (`public/sw.js` — a static file, since Next's
 * static export doesn't bundle `public/` and there's no equivalent of
 * `new Worker(new URL(...))`'s webpack integration for service workers) and
 * exchanges the resulting `PushSubscription` for the server's
 * `POST`/`DELETE /v1/push/subscribe` (design §6.2).
 *
 * Structured like `apiSocket.ts`: the platform surface this needs
 * (`navigator.serviceWorker`, `PushManager`) is narrowed to a small
 * injectable `PushEnvironment` interface so the orchestration logic below is
 * unit-testable against an in-memory fake instead of a real browser, and the
 * two server calls go through an injectable `PushApiPort` for the same
 * reason (no real network in tests) — mirrors `lib/api.ts`'s
 * `subscribePush`/`unsubscribePush`, which is what the real `PushApiPort`
 * wraps.
 */
import type { PushSubscribeBody } from "@falcon/wire";
import { urlBase64ToUint8Array } from "./vapid.js";

export interface PushSubscriptionLike {
  readonly endpoint: string;
  toJSON(): { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array;
  }): Promise<PushSubscriptionLike>;
}

export interface PushEnvironment {
  /** Feature-detection: `'serviceWorker' in navigator && 'PushManager' in window`. */
  isSupported(): boolean;
  /** Registers (or returns the already-registered) service worker and resolves once it's active. */
  getPushManager(): Promise<PushManagerLike>;
}

export interface PushApiPort {
  subscribe(token: string, body: PushSubscribeBody): Promise<{ id: string }>;
  unsubscribe(token: string, endpoint: string): Promise<{ ok: true }>;
}

export type SubscribeOutcome = "subscribed" | "unsupported";
export type UnsubscribeOutcome = "unsubscribed" | "not-subscribed" | "unsupported";

/** Converts a browser `PushSubscription` into the server's request body — throws if the
 * browser didn't hand back the p256dh/auth keys Web Push needs (shouldn't happen in
 * practice; a defensive check rather than a silent, half-working subscription). */
export function toSubscribeBody(sub: PushSubscriptionLike): PushSubscribeBody {
  const json = sub.toJSON();
  const endpoint = json.endpoint ?? sub.endpoint;
  const { p256dh, auth } = json.keys ?? {};
  if (!p256dh || !auth) {
    throw new Error("Push subscription is missing its p256dh/auth keys");
  }
  return { channel: "webpush", endpoint, keys: { p256dh, auth } };
}

/**
 * Registers for push and POSTs the subscription to the server. A no-op
 * (returns `"unsupported"`) rather than throwing when the browser lacks Web
 * Push support (design §6.4 "iOS reality": this is expected on iOS Safari
 * outside an installed PWA) — the settings page shows a message instead of
 * a button in that case.
 */
export async function subscribeToPush(
  env: PushEnvironment,
  api: PushApiPort,
  token: string,
  vapidPublicKey: string,
): Promise<SubscribeOutcome> {
  if (!env.isSupported()) return "unsupported";

  const pushManager = await env.getPushManager();
  const existing = await pushManager.getSubscription();
  const subscription =
    existing ??
    (await pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));

  await api.subscribe(token, toSubscribeBody(subscription));
  return "subscribed";
}

/** Unsubscribes both browser-side (so the push service stops delivering) and server-side. */
export async function unsubscribeFromPush(
  env: PushEnvironment,
  api: PushApiPort,
  token: string,
): Promise<UnsubscribeOutcome> {
  if (!env.isSupported()) return "unsupported";

  const pushManager = await env.getPushManager();
  const existing = await pushManager.getSubscription();
  if (!existing) return "not-subscribed";

  const endpoint = existing.endpoint;
  await existing.unsubscribe();
  await api.unsubscribe(token, endpoint);
  return "unsubscribed";
}

/**
 * The real `PushEnvironment`, backed by `navigator`/`window`. Defensive
 * against build-time evaluation (Next prerenders in Node — no `navigator`)
 * the same way `visibility.ts` is: `isSupported()` returns `false` rather
 * than throwing.
 */
export function createBrowserPushEnvironment(): PushEnvironment {
  return {
    isSupported(): boolean {
      return (
        typeof navigator !== "undefined" &&
        "serviceWorker" in navigator &&
        typeof window !== "undefined" &&
        "PushManager" in window
      );
    },
    async getPushManager(): Promise<PushManagerLike> {
      await navigator.serviceWorker.register("/sw.js");
      // `.ready` resolves with the *active* registration — `.register()`'s
      // return value may still be installing, and `pushManager.subscribe`
      // requires an active worker.
      const active = await navigator.serviceWorker.ready;
      return active.pushManager as unknown as PushManagerLike;
    },
  };
}
