import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "@/lib/__tests__/test-storage.js";
import { getDefaultBranchMode, setDefaultBranchMode } from "../git-defaults.js";

describe("git-defaults (no window)", () => {
  it("getDefaultBranchMode falls back to 'repo-root' and setDefaultBranchMode is a safe no-op", () => {
    expect(getDefaultBranchMode()).toBe("repo-root");
    expect(() => setDefaultBranchMode("new-branch")).not.toThrow();
  });
});

describe("git-defaults (window.localStorage present)", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: createMemoryStorage() };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("defaults to 'repo-root' when nothing is stored", () => {
    expect(getDefaultBranchMode()).toBe("repo-root");
  });

  it("round-trips through set", () => {
    setDefaultBranchMode("new-branch");
    expect(getDefaultBranchMode()).toBe("new-branch");
    setDefaultBranchMode("repo-root");
    expect(getDefaultBranchMode()).toBe("repo-root");
  });

  it("falls back to 'repo-root' for an invalid stored value rather than throwing", () => {
    window.localStorage.setItem("falcon:git-default-branch-mode", "existing-branch");
    expect(getDefaultBranchMode()).toBe("repo-root");
    window.localStorage.setItem("falcon:git-default-branch-mode", "garbage");
    expect(getDefaultBranchMode()).toBe("repo-root");
  });
});
