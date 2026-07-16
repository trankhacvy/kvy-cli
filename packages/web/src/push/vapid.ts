/**
 * `PushManager.subscribe`'s `applicationServerKey` option wants a raw
 * `Uint8Array`, but VAPID public keys are handed out base64url-encoded
 * (design §6.4's config; `packages/server/src/config.ts`'s `VAPID_PUBLIC_KEY`).
 * Standard base64url -> bytes decode, ported from the canonical MDN/web.dev
 * Web Push snippet (no library needed for one function).
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}
