const SHELL_CACHE = "kvy-shell-v1";
const PRECACHE_URL = "/precache-manifest.json";
const OFFLINE_URL = "/offline.html";

const KIND_LABELS = {
  perm: "Kvy needs your permission",
  question: "Kvy has a question for you",
  done: "Kvy finished a task",
  failed: "A Kvy session failed",
};

const BASE_SHELL = [
  "/",
  "/dashboard/",
  "/offline.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/favicon.ico",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const urls = new Set(BASE_SHELL);
      try {
        const res = await fetch(PRECACHE_URL, { cache: "no-cache" });
        if (res.ok) {
          const list = await res.json();
          if (Array.isArray(list)) {
            for (const entry of list) {
              if (typeof entry === "string" && entry.startsWith("/")) urls.add(entry);
            }
          }
        }
      } catch {
        // Precache manifest is optional at install (dev / first deploy).
      }
      await Promise.all(
        [...urls].map(async (url) => {
          try {
            await cache.add(url);
          } catch {
            // Skip missing assets so install still succeeds.
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function shouldBypassCache(url) {
  if (url.pathname.startsWith("/v1/")) return true;
  if (url.pathname === "/sw.js") return true;
  if (url.pathname === "/crypto-worker.js") return true;
  if (url.pathname === PRECACHE_URL) return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (!isSameOrigin(url) || shouldBypassCache(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(request, response.clone());
          }
          return response;
        } catch {
          const cached = await caches.match(request);
          if (cached) return cached;
          const offline = await caches.match(OFFLINE_URL);
          if (offline) return offline;
          return new Response("Offline", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      const networkPromise = fetch(request)
        .then((response) => {
          if (response.ok) {
            void cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => undefined);
      if (cached) {
        void networkPromise;
        return cached;
      }
      const network = await networkPromise;
      if (network) return network;
      return new Response("", { status: 504, statusText: "Offline" });
    })(),
  );
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
  const title = (kind && KIND_LABELS[kind]) || "Kvy";
  const url = sessionId ? `/dashboard/session/${sessionId}/` : "/dashboard/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: "Tap to open the session.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: sessionId || "kvy-notification",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/dashboard/";

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
