import { describe, expect, it, vi } from "vitest";
import { logout } from "./logout";

describe("logout", () => {
  it("stops the shared bridge, then wipes key material, then disconnects the socket, then clears the token", async () => {
    const order: string[] = [];
    await logout({
      stopSharedBridge: () => {
        order.push("stop-shared");
      },
      wipeKeyMaterial: async () => {
        order.push("wipe");
      },
      disconnectSocket: () => {
        order.push("disconnect");
      },
      clearAccessToken: () => {
        order.push("clear");
      },
    });
    expect(order).toEqual(["stop-shared", "wipe", "disconnect", "clear"]);
  });

  it("still disconnects and clears the token when the key wipe fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const disconnectSocket = vi.fn();
    const clearAccessToken = vi.fn();
    await logout({
      wipeKeyMaterial: async () => {
        throw new Error("indexedDB unavailable");
      },
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
      disconnectSocket,
      clearAccessToken,
    });
    expect(wipeKeyMaterial).toHaveBeenCalledOnce();
    expect(disconnectSocket).toHaveBeenCalledOnce();
    expect(clearAccessToken).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });
});
