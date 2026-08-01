import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "@/lib/__tests__/test-storage.js";
import { getExpandedWorkspaces, setWorkspaceExpanded } from "./workspace-nav-expand-state.js";

describe("workspace-nav-expand-state (no window)", () => {
  it("getExpandedWorkspaces/setWorkspaceExpanded are safe no-ops without crashing", () => {
    expect(getExpandedWorkspaces()).toEqual(new Set());
    expect(() => setWorkspaceExpanded("w1", true)).not.toThrow();
  });
});

describe("workspace-nav-expand-state (window.localStorage present)", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: createMemoryStorage() };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("returns an empty set before anything has been expanded", () => {
    expect(getExpandedWorkspaces()).toEqual(new Set());
  });

  it("setWorkspaceExpanded(id, true) persists the id, getExpandedWorkspaces reflects it", () => {
    setWorkspaceExpanded("w1", true);
    expect(getExpandedWorkspaces()).toEqual(new Set(["w1"]));
  });

  it("setWorkspaceExpanded(id, false) removes a previously expanded id", () => {
    setWorkspaceExpanded("w1", true);
    setWorkspaceExpanded("w1", false);
    expect(getExpandedWorkspaces()).toEqual(new Set());
  });

  it("tracks multiple workspace ids independently", () => {
    setWorkspaceExpanded("w1", true);
    setWorkspaceExpanded("w2", true);
    expect(getExpandedWorkspaces()).toEqual(new Set(["w1", "w2"]));
    setWorkspaceExpanded("w1", false);
    expect(getExpandedWorkspaces()).toEqual(new Set(["w2"]));
  });

  it("returns an empty set when localStorage holds unparseable JSON", () => {
    window.localStorage.setItem("kvy:sidebar-expanded-workspaces", "not json");
    expect(getExpandedWorkspaces()).toEqual(new Set());
  });
});
