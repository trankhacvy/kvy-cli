import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetInstallStateForTests,
  ensureInstallListeners,
  getInstallSnapshot,
  isIosDevice,
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

  it("returns the same object reference across calls when nothing changed", () => {
    // useSyncExternalStore compares snapshots by reference - a getter that
    // allocates a new object every call looks like a change on every render
    // and loops forever.
    expect(getInstallSnapshot()).toBe(getInstallSnapshot());
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

  it("returns false without a global navigator", () => {
    expect(isIosDevice()).toBe(false);
  });

  it("detects iPhone/iPad/iPod from the user agent", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" });
    expect(isIosDevice()).toBe(true);
  });

  it("detects iPadOS 13+ reporting as MacIntel via touch support", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    expect(isIosDevice()).toBe(true);
  });

  it("does not mistake a real Mac (no touch points) for iPadOS", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    expect(isIosDevice()).toBe(false);
  });

  it("returns false for a normal desktop/Android user agent", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120",
      platform: "Win32",
      maxTouchPoints: 0,
    });
    expect(isIosDevice()).toBe(false);
  });
});
