import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./register-sw";

describe("registerServiceWorker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns null when service workers are unavailable", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    await expect(registerServiceWorker()).resolves.toBeNull();
  });

  it("registers /sw.js at root scope", async () => {
    const registration = { scope: "/" };
    const register = vi.fn().mockResolvedValue(registration);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      serviceWorker: { register },
    });

    await expect(registerServiceWorker()).resolves.toBe(registration);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("returns null when registration fails", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: vi.fn().mockRejectedValue(new Error("blocked")),
      },
    });
    await expect(registerServiceWorker()).resolves.toBeNull();
  });
});
