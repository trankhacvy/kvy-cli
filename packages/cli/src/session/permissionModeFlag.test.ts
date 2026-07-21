import { describe, expect, it } from "vitest";
import { extractPermissionModeFlag } from "./permissionModeFlag.js";

describe("extractPermissionModeFlag", () => {
  it("returns undefined when no --permission-mode flag is present", () => {
    expect(extractPermissionModeFlag([])).toBeUndefined();
    expect(extractPermissionModeFlag(["--verbose", "-p"])).toBeUndefined();
  });

  it("reads a space-separated --permission-mode <value>", () => {
    expect(extractPermissionModeFlag(["--permission-mode", "plan"])).toBe("plan");
  });

  it("reads a --permission-mode=value form", () => {
    expect(extractPermissionModeFlag(["--permission-mode=acceptEdits"])).toBe("acceptEdits");
  });

  it("ignores a --permission-mode flag with no following value (next token is another flag)", () => {
    expect(extractPermissionModeFlag(["--permission-mode", "--verbose"])).toBeUndefined();
  });

  it("ignores a --permission-mode flag that's the last token with nothing after it", () => {
    expect(extractPermissionModeFlag(["--verbose", "--permission-mode"])).toBeUndefined();
  });

  it("last occurrence wins when --permission-mode appears more than once", () => {
    expect(
      extractPermissionModeFlag(["--permission-mode", "plan", "--permission-mode", "acceptEdits"]),
    ).toBe("acceptEdits");
  });

  it("finds --permission-mode among other passthrough flags in any position", () => {
    expect(
      extractPermissionModeFlag(["-p", "--permission-mode", "bypassPermissions", "--verbose"]),
    ).toBe("bypassPermissions");
  });

  it("rejects an unrecognized mode value, same as no flag given", () => {
    expect(extractPermissionModeFlag(["--permission-mode", "yolo"])).toBeUndefined();
  });
});
