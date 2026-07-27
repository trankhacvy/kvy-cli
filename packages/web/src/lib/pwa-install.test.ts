import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetInstallStateForTests,
  ensureInstallListeners,
  getInstallSnapshot,
  isStandaloneDisplay,
  promptInstall,
  subscribeToInstall,
} from "./pwa-install";

describe("pwa-install", () => {
  afterEach(() => {
    __resetInstallStateForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports standalone display mode from matchMedia", () => {
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true }),
      navigator: {},
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    expect(isStandaloneDisplay()).toBe(true);
  });

  it("stores a deferred install prompt and clears it after prompting", async () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
      navigator: {},
      addEventListener: (type: string, listener: EventListener) => {
        listeners.set(type, listener);
      },
      removeEventListener: vi.fn(),
    });

    ensureInstallListeners();
    expect(getInstallSnapshot().canInstall).toBe(false);

    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = Object.assign(new Event("beforeinstallprompt"), {
      platforms: ["web"],
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" as const, platform: "web" }),
      preventDefault: vi.fn(),
    });
    listeners.get("beforeinstallprompt")?.(event);

    expect(getInstallSnapshot().canInstall).toBe(true);

    const seen: boolean[] = [];
    const unsub = subscribeToInstall(() => {
      seen.push(getInstallSnapshot().canInstall);
    });

    await expect(promptInstall()).resolves.toBe("accepted");
    expect(prompt).toHaveBeenCalled();
    expect(getInstallSnapshot().canInstall).toBe(false);
    expect(getInstallSnapshot().isInstalled).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    unsub();
  });
});
