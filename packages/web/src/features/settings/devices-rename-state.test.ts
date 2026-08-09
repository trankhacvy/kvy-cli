import { describe, expect, it } from "vitest";
import { cancelRename, isRenaming, startRename } from "./devices-rename-state";

describe("startRename / cancelRename", () => {
  it("startRename shows the rename affordance for that session's id", () => {
    expect(startRename("sess-1")).toBe("sess-1");
  });

  it("cancelRename always returns to no row renaming", () => {
    expect(cancelRename()).toBeNull();
  });
});

describe("isRenaming", () => {
  it("is true only for the row currently showing the rename affordance", () => {
    expect(isRenaming("sess-1", "sess-1")).toBe(true);
  });

  it("is false for a different row", () => {
    expect(isRenaming("sess-1", "sess-2")).toBe(false);
  });

  it("is false when nothing is being renamed", () => {
    expect(isRenaming(null, "sess-1")).toBe(false);
  });
});
