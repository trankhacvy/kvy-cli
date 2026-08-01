import { describe, expect, it, vi } from "vitest";
import { registerSessionWorkspace } from "./registerSessionWorkspace.js";

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("registerSessionWorkspace", () => {
  it("returns the registered entry's path on success", async () => {
    const registerWorkspace = vi
      .fn()
      .mockResolvedValue({ path: "/real/repo", registeredAt: "now" });
    const logger = fakeLogger();

    const workspaceId = await registerSessionWorkspace("/some/dir", { registerWorkspace, logger });

    expect(workspaceId).toBe("/real/repo");
    expect(registerWorkspace).toHaveBeenCalledWith("/some/dir");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns null and logs a warning, never throws, when registerWorkspace fails", async () => {
    const registerWorkspace = vi.fn().mockRejectedValue(new Error("lock contended"));
    const logger = fakeLogger();

    const workspaceId = await registerSessionWorkspace("/some/dir", { registerWorkspace, logger });

    expect(workspaceId).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "[register-session-workspace] failed, continuing without workspaceId",
      { message: "lock contended" },
    );
  });

  it("stringifies a non-Error rejection instead of throwing", async () => {
    const registerWorkspace = vi.fn().mockRejectedValue("plain string failure");
    const logger = fakeLogger();

    const workspaceId = await registerSessionWorkspace("/some/dir", { registerWorkspace, logger });

    expect(workspaceId).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "[register-session-workspace] failed, continuing without workspaceId",
      { message: "plain string failure" },
    );
  });
});
