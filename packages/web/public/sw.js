/**
 * Falcon's service worker (design §8.5/§9.3, FR-7.6). A plain static file —
 * not part of the TS build — because Next's static export (`next.config.ts`:
 * `output: "export"`) doesn't bundle anything under `public/`, and there's
 * no equivalent of `new Worker(new URL(...))`'s webpack integration for
 * service workers (contrast `src/crypto/worker.ts`, which *is* bundled that
 * way, since it's a regular Worker). Registered from
 * `src/push/subscribe.ts`'s `createBrowserPushEnvironment()`.
 *
 * Two responsibilities only:
 *  - `push`: decode the generic `{sessionId, kind}` payload (design §6.4 —
 *    never session content, the server holds no keys to encrypt anything
 *    richer anyway) and show a fixed, kind-keyed notification.
 *  - `notificationclick`: deep-link to `/session/<id>/`, focusing an
 *    already-open Falcon tab instead of opening a new one when possible.
 */

const KIND_LABELS = {
  perm: "Falcon needs your permission",
  question: "Falcon has a question for you",
  done: "Falcon finished a task",
  failed: "A Falcon session failed",
};

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }

  const sessionId = payload && typeof payload.sessionId === "string" ? payload.sessionId : null;
  const kind = payload && typeof payload.kind === "string" ? payload.kind : null;
  const title = (kind && KIND_LABELS[kind]) || "Falcon";
  const url = sessionId ? `/session/${sessionId}/` : "/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: "Tap to open the session.",
      tag: sessionId || "falcon-notification", // coalesce repeat notifications per session
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const target = new URL(url, self.location.origin).href;
      for (const client of clientsList) {
        if (client.url === target && "focus" in client) {
          await client.focus();
          return;
        }
      }
      // No existing tab has this exact session open — reuse any Falcon tab
      // by navigating it, or fall back to opening a fresh one.
      const existing = clientsList[0];
      if (existing && "navigate" in existing && "focus" in existing) {
        await existing.focus();
        await existing.navigate(target);
        return;
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(target);
      }
    })(),
  );
});
