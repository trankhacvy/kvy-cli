import { describe, expect, it, vi } from "vitest";
import { logout } from "./logout";

describe("logout", () => {
  it("wipes key material, then disconnects the socket, then clears the token", async () => {
    const order: string[] = [];
    await logout({
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
    expect(order).toEqual(["wipe", "disconnect", "clear"]);
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
});
