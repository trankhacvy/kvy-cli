import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const swPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../public/sw.js");
const swSource = readFileSync(swPath, "utf8");

interface FakeCache {
  put: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  addAll: ReturnType<typeof vi.fn>;
}

interface FakeSelf {
  listeners: Map<string, (event: unknown) => unknown>;
  showNotification: ReturnType<typeof vi.fn>;
  matchAll: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
  skipWaiting: ReturnType<typeof vi.fn>;
  caches: {
    open: ReturnType<typeof vi.fn>;
    keys: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    match: ReturnType<typeof vi.fn>;
  };
  fetch: ReturnType<typeof vi.fn>;
  cache: FakeCache;
}

function loadServiceWorker(): FakeSelf {
  const listeners = new Map<string, (event: unknown) => unknown>();
  const cache: FakeCache = {
    put: vi.fn().mockResolvedValue(undefined),
    match: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    addAll: vi.fn().mockResolvedValue(undefined),
  };
  const fake: FakeSelf = {
    listeners,
    showNotification: vi.fn().mockResolvedValue(undefined),
    matchAll: vi.fn().mockResolvedValue([]),
    openWindow: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn().mockResolvedValue(undefined),
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    caches: {
      open: vi.fn().mockResolvedValue(cache),
      keys: vi.fn().mockResolvedValue(["falcon-shell-v1"]),
      delete: vi.fn().mockResolvedValue(true),
      match: vi.fn().mockResolvedValue(undefined),
    },
    fetch: vi.fn(),
    cache,
  };

  const self = {
    addEventListener: (event: string, handler: (e: unknown) => unknown) => {
      listeners.set(event, handler);
    },
    skipWaiting: fake.skipWaiting,
    clients: { claim: fake.claim, matchAll: fake.matchAll, openWindow: fake.openWindow },
    registration: { showNotification: fake.showNotification },
    location: { origin: "https://falcon.example" },
  };

  const sandbox = {
    self,
    URL,
    console,
    caches: fake.caches,
    fetch: fake.fetch,
    Response,
  };
  vm.createContext(sandbox);
  vm.runInContext(swSource, sandbox);

  return fake;
}

async function fireWaitUntil(handler: (event: unknown) => unknown, event: object): Promise<void> {
  let captured: Promise<unknown> | undefined;
  handler({ ...event, waitUntil: (p: Promise<unknown>) => (captured = p) });
  await captured;
}

describe("public/sw.js", () => {
  let sw: FakeSelf;

  beforeEach(() => {
    sw = loadServiceWorker();
  });

  it("registers install/activate/fetch/push/notificationclick handlers", () => {
    expect(sw.listeners.has("install")).toBe(true);
    expect(sw.listeners.has("activate")).toBe(true);
    expect(sw.listeners.has("fetch")).toBe(true);
    expect(sw.listeners.has("push")).toBe(true);
    expect(sw.listeners.has("notificationclick")).toBe(true);
  });

  it("install: precaches the app shell", async () => {
    sw.cache.add = vi.fn().mockResolvedValue(undefined);
    sw.fetch.mockResolvedValue({
      ok: false,
    });
    const install = sw.listeners.get("install");
    if (!install) throw new Error("no install handler registered");

    await fireWaitUntil(install, {});

    expect(sw.cache.add).toHaveBeenCalled();
    const urls = sw.cache.add.mock.calls.map((call) => call[0] as string);
    expect(urls).toEqual(
      expect.arrayContaining(["/dashboard/", "/offline.html", "/manifest.webmanifest"]),
    );
    expect(sw.skipWaiting).toHaveBeenCalled();
  });

  it("push: shows a kind-keyed notification with icon, badge, deep-link, and tag", async () => {
    const push = sw.listeners.get("push");
    if (!push) throw new Error("no push handler registered");

    await fireWaitUntil(push, { data: { json: () => ({ sessionId: "sess_1", kind: "perm" }) } });

    expect(sw.showNotification).toHaveBeenCalledWith(
      "Falcon needs your permission",
      expect.objectContaining({
        tag: "sess_1",
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        data: { url: "/dashboard/session/sess_1/" },
      }),
    );
  });

  it("push: falls back to a generic title/url for a malformed or missing payload", async () => {
    const push = sw.listeners.get("push");
    if (!push) throw new Error("no push handler registered");

    await fireWaitUntil(push, {
      data: {
        json: () => {
          throw new Error("not json");
        },
      },
    });

    expect(sw.showNotification).toHaveBeenCalledWith(
      "Falcon",
      expect.objectContaining({ data: { url: "/dashboard/" } }),
    );
  });

  it("push: handles a push event carrying no data at all", async () => {
    const push = sw.listeners.get("push");
    if (!push) throw new Error("no push handler registered");

    await fireWaitUntil(push, { data: null });

    expect(sw.showNotification).toHaveBeenCalledWith(
      "Falcon",
      expect.objectContaining({ data: { url: "/dashboard/" } }),
    );
  });

  it("notificationclick: focuses an already-open tab for the exact same session URL", async () => {
    const focus = vi.fn().mockResolvedValue(undefined);
    sw.matchAll.mockResolvedValue([
      { url: "https://falcon.example/dashboard/session/sess_1/", focus },
    ]);
    const notificationclick = sw.listeners.get("notificationclick");
    if (!notificationclick) throw new Error("no notificationclick handler registered");
    const close = vi.fn();

    await fireWaitUntil(notificationclick, {
      notification: { close, data: { url: "/dashboard/session/sess_1/" } },
    });

    expect(close).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it("notificationclick: opens a new window when no Falcon tab is open at all", async () => {
    sw.matchAll.mockResolvedValue([]);
    const notificationclick = sw.listeners.get("notificationclick");
    if (!notificationclick) throw new Error("no notificationclick handler registered");

    await fireWaitUntil(notificationclick, {
      notification: { close: vi.fn(), data: { url: "/dashboard/session/sess_2/" } },
    });

    expect(sw.openWindow).toHaveBeenCalledWith("https://falcon.example/dashboard/session/sess_2/");
  });

  it("notificationclick: navigates an existing tab to the target session when none matches exactly", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    const focus = vi.fn().mockResolvedValue(undefined);
    sw.matchAll.mockResolvedValue([
      { url: "https://falcon.example/dashboard/session/other/", focus, navigate },
    ]);
    const notificationclick = sw.listeners.get("notificationclick");
    if (!notificationclick) throw new Error("no notificationclick handler registered");

    await fireWaitUntil(notificationclick, {
      notification: { close: vi.fn(), data: { url: "/dashboard/session/sess_3/" } },
    });

    expect(focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("https://falcon.example/dashboard/session/sess_3/");
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it("fetch: ignores cross-origin and API paths", async () => {
    const fetchHandler = sw.listeners.get("fetch");
    if (!fetchHandler) throw new Error("no fetch handler registered");

    let responded = false;
    fetchHandler({
      request: { method: "GET", mode: "cors", url: "https://api.example/v1/sync" },
      respondWith: () => {
        responded = true;
      },
    });
    expect(responded).toBe(false);

    fetchHandler({
      request: {
        method: "GET",
        mode: "cors",
        url: "https://falcon.example/v1/sync",
      },
      respondWith: () => {
        responded = true;
      },
    });
    expect(responded).toBe(false);
  });
});
