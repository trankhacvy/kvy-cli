import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `public/sw.js` is a plain static file outside the TS build (see its own
 * header comment for why), so it can't be `import`ed like a normal module.
 * This loads its source into a sandboxed `vm` context with a fake
 * `self`/`ServiceWorkerGlobalScope`, registers its `addEventListener`
 * handlers the same way a real service worker runtime would, then invokes
 * those handlers directly with fake `push`/`notificationclick` events —
 * exercising the actual shipped file rather than a parallel reimplementation
 * that could drift from it.
 */
const swPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../public/sw.js");
const swSource = readFileSync(swPath, "utf8");

interface FakeSelf {
  listeners: Map<string, (event: unknown) => unknown>;
  showNotification: ReturnType<typeof vi.fn>;
  matchAll: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
  skipWaiting: ReturnType<typeof vi.fn>;
}

function loadServiceWorker(): FakeSelf {
  const listeners = new Map<string, (event: unknown) => unknown>();
  const fake: FakeSelf = {
    listeners,
    showNotification: vi.fn().mockResolvedValue(undefined),
    matchAll: vi.fn().mockResolvedValue([]),
    openWindow: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn().mockResolvedValue(undefined),
    skipWaiting: vi.fn(),
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

  const sandbox = { self, URL, console };
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

  it("registers install/activate/push/notificationclick handlers", () => {
    expect(sw.listeners.has("install")).toBe(true);
    expect(sw.listeners.has("activate")).toBe(true);
    expect(sw.listeners.has("push")).toBe(true);
    expect(sw.listeners.has("notificationclick")).toBe(true);
  });

  it("push: shows a kind-keyed notification with a session deep-link and a session-scoped tag", async () => {
    const push = sw.listeners.get("push");
    if (!push) throw new Error("no push handler registered");

    await fireWaitUntil(push, { data: { json: () => ({ sessionId: "sess_1", kind: "perm" }) } });

    expect(sw.showNotification).toHaveBeenCalledWith(
      "Falcon needs your permission",
      expect.objectContaining({ tag: "sess_1", data: { url: "/session/sess_1/" } }),
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
      expect.objectContaining({ data: { url: "/" } }),
    );
  });

  it("push: handles a push event carrying no data at all", async () => {
    const push = sw.listeners.get("push");
    if (!push) throw new Error("no push handler registered");

    await fireWaitUntil(push, { data: null });

    expect(sw.showNotification).toHaveBeenCalledWith(
      "Falcon",
      expect.objectContaining({ data: { url: "/" } }),
    );
  });

  it("notificationclick: focuses an already-open tab for the exact same session URL", async () => {
    const focus = vi.fn().mockResolvedValue(undefined);
    sw.matchAll.mockResolvedValue([{ url: "https://falcon.example/session/sess_1/", focus }]);
    const notificationclick = sw.listeners.get("notificationclick");
    if (!notificationclick) throw new Error("no notificationclick handler registered");
    const close = vi.fn();

    await fireWaitUntil(notificationclick, {
      notification: { close, data: { url: "/session/sess_1/" } },
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
      notification: { close: vi.fn(), data: { url: "/session/sess_2/" } },
    });

    expect(sw.openWindow).toHaveBeenCalledWith("https://falcon.example/session/sess_2/");
  });

  it("notificationclick: navigates an existing tab to the target session when none matches exactly", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    const focus = vi.fn().mockResolvedValue(undefined);
    sw.matchAll.mockResolvedValue([
      { url: "https://falcon.example/session/other/", focus, navigate },
    ]);
    const notificationclick = sw.listeners.get("notificationclick");
    if (!notificationclick) throw new Error("no notificationclick handler registered");

    await fireWaitUntil(notificationclick, {
      notification: { close: vi.fn(), data: { url: "/session/sess_3/" } },
    });

    expect(focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("https://falcon.example/session/sess_3/");
    expect(sw.openWindow).not.toHaveBeenCalled();
  });
});
