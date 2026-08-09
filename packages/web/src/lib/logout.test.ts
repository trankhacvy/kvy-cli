import { describe, expect, it, vi } from "vitest";
import { logout } from "./logout";

describe("logout", () => {
  it("stops the shared bridge, then wipes key material, then revokes the session, then disconnects the socket, then clears the token", async () => {
    const order: string[] = [];
    await logout({
      stopSharedBridge: () => {
        order.push("stop-shared");
      },
      wipeKeyMaterial: async () => {
        order.push("wipe");
      },
      revokeSessionOnServer: async () => {
        order.push("revoke");
      },
      disconnectSocket: () => {
        order.push("disconnect");
      },
      clearAccessToken: () => {
        order.push("clear");
      },
    });
    expect(order).toEqual(["stop-shared", "wipe", "revoke", "disconnect", "clear"]);
  });

  it("still disconnects and clears the token when the key wipe fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const disconnectSocket = vi.fn();
    const clearAccessToken = vi.fn();
    await logout({
      wipeKeyMaterial: async () => {
        throw new Error("indexedDB unavailable");
      },
      revokeSessionOnServer: async () => {},
      disconnectSocket,
      clearAccessToken,
    });
    expect(disconnectSocket).toHaveBeenCalledOnce();
    expect(clearAccessToken).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  // A worker still alive after logout could re-create the IndexedDB databases the wipe
  // just deleted, but stopping it must never abort the rest of teardown.
  it("still runs the rest of logout when a throwing stopSharedBridge is given", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const wipeKeyMaterial = vi.fn(async () => {});
    const disconnectSocket = vi.fn();
    const clearAccessToken = vi.fn();
    await logout({
      stopSharedBridge: () => {
        throw new Error("worker already gone");
      },
      wipeKeyMaterial,
      revokeSessionOnServer: async () => {},
      disconnectSocket,
      clearAccessToken,
    });
    expect(wipeKeyMaterial).toHaveBeenCalledOnce();
    expect(disconnectSocket).toHaveBeenCalledOnce();
    expect(clearAccessToken).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  // The server-side revoke is best-effort (e.g. offline sign-out) — it must never block
  // the local teardown that actually removes the user's key material from this device.
  it("still disconnects and clears the token when the server-side revoke fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const disconnectSocket = vi.fn();
    const clearAccessToken = vi.fn();
    await logout({
      wipeKeyMaterial: async () => {},
      revokeSessionOnServer: async () => {
        throw new Error("network unreachable");
      },
      disconnectSocket,
      clearAccessToken,
    });
    expect(disconnectSocket).toHaveBeenCalledOnce();
    expect(clearAccessToken).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });
});
