import { describe, expect, it } from "vitest";
import { createMockNewSessionActions } from "../mock-source";

describe("createMockNewSessionActions", () => {
  it("browses the seeded fake filesystem, sorted alphabetically", async () => {
    const actions = createMockNewSessionActions("mach-1");
    const listing = await actions.browseDirectory("/Users/vy/projects");
    expect(listing.entries.map((e) => e.name)).toEqual(["falcon", "happy", "scratch"]);
    expect(listing.parent).toBe("/Users/vy");
  });

  it("throws when browsing a directory that doesn't exist", async () => {
    const actions = createMockNewSessionActions("mach-1");
    await expect(actions.browseDirectory("/Users/vy/nope")).rejects.toThrow();
  });

  it("spawn succeeds directly for an existing directory", async () => {
    const actions = createMockNewSessionActions("mach-1");
    const outcome = await actions.spawn({
      directory: "/Users/vy/projects/falcon",
      provider: "claude-code",
      permissionMode: "default",
    });
    expect(outcome.type).toBe("success");
  });

  it("spawn requires approval for a directory that doesn't exist yet, then succeeds after creation", async () => {
    const actions = createMockNewSessionActions("mach-1");
    const request = {
      directory: "/Users/vy/projects/brand-new",
      provider: "claude-code" as const,
      permissionMode: "default" as const,
    };

    const first = await actions.spawn(request);
    expect(first).toEqual({
      type: "requiresApproval",
      action: "create-directory",
      directory: "/Users/vy/projects/brand-new",
    });

    await actions.createDirectory("/Users/vy/projects/brand-new");
    const second = await actions.spawn(request);
    expect(second.type).toBe("success");

    // The freshly created directory now shows up when browsing its parent.
    const listing = await actions.browseDirectory("/Users/vy/projects");
    expect(listing.entries.map((e) => e.name)).toContain("brand-new");
  });

  it("listImportCandidates returns seeded candidates for a directory that has them", async () => {
    const actions = createMockNewSessionActions("mach-1");
    const candidates = await actions.listImportCandidates("/Users/vy/projects/falcon");
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.running)).toBe(true);
  });

  it("listImportCandidates returns an empty array for a directory with none", async () => {
    const actions = createMockNewSessionActions("mach-1");
    const candidates = await actions.listImportCandidates("/Users/vy/Documents");
    expect(candidates).toEqual([]);
  });

  it("listBranches returns the seeded branches, including one current and one already checked out elsewhere", async () => {
    const actions = createMockNewSessionActions("mach-1");
    const branches = await actions.listBranches("/Users/vy/projects/falcon");
    expect(branches.some((b) => b.isCurrent)).toBe(true);
    expect(branches.some((b) => b.checkedOutAt !== undefined)).toBe(true);
  });

  it("listBranches returns an empty array for a directory with none", async () => {
    const actions = createMockNewSessionActions("mach-1");
    const branches = await actions.listBranches("/Users/vy/Documents");
    expect(branches).toEqual([]);
  });
});
