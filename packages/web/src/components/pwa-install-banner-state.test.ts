import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "@/lib/__tests__/test-storage.js";
import {
  dismissInstallBanner,
  getInstallBannerDismissed,
  getInstallBannerMode,
} from "./pwa-install-banner-state.js";

describe("pwa-install-banner-state (no window)", () => {
  it("getInstallBannerDismissed/dismissInstallBanner are safe no-ops without crashing", () => {
    expect(getInstallBannerDismissed()).toBe(false);
    expect(() => dismissInstallBanner()).not.toThrow();
  });
});

describe("pwa-install-banner-state (window.localStorage present)", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: createMemoryStorage() };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("is not dismissed before anything is set", () => {
    expect(getInstallBannerDismissed()).toBe(false);
  });

  it("dismissInstallBanner persists across calls", () => {
    dismissInstallBanner();
    expect(getInstallBannerDismissed()).toBe(true);
  });
});

describe("getInstallBannerMode", () => {
  it("hides when already installed, regardless of other flags", () => {
    expect(
      getInstallBannerMode({ isInstalled: true, dismissed: false, canInstall: true, isIos: true }),
    ).toBe("hidden");
  });

  it("hides when dismissed, regardless of other flags", () => {
    expect(
      getInstallBannerMode({ isInstalled: false, dismissed: true, canInstall: true, isIos: true }),
    ).toBe("hidden");
  });

  it("shows the install CTA when the native prompt is available", () => {
    expect(
      getInstallBannerMode({
        isInstalled: false,
        dismissed: false,
        canInstall: true,
        isIos: false,
      }),
    ).toBe("install");
  });

  it("prefers the install CTA over the how-to path when both are true", () => {
    expect(
      getInstallBannerMode({ isInstalled: false, dismissed: false, canInstall: true, isIos: true }),
    ).toBe("install");
  });

  it("shows the how-to walkthrough on iOS when there's no native prompt", () => {
    expect(
      getInstallBannerMode({
        isInstalled: false,
        dismissed: false,
        canInstall: false,
        isIos: true,
      }),
    ).toBe("how-to");
  });

  it("hides when neither a native prompt nor iOS manual instructions apply", () => {
    expect(
      getInstallBannerMode({
        isInstalled: false,
        dismissed: false,
        canInstall: false,
        isIos: false,
      }),
    ).toBe("hidden");
  });
});
