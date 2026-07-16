import { describe, expect, it } from "vitest";
import { createMockNewSessionActions, useMockNewSessionMachines } from "../mock-source";

describe("useMockNewSessionMachines", () => {
  it("returns a non-empty list with at least one online and one offline machine", () => {
    const machines = useMockNewSessionMachines();
    expect(machines.length).toBeGreaterThan(0);
    expect(machines.some((m) => m.online)).toBe(true);
    expect(machines.some((m) => !m.online)).toBe(true);
  });
});

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
    expect(first).toEqual({ type: "requiresApproval", directory: "/Users/vy/projects/brand-new" });

    await actions.createDirectory("/Users/vy/projects/brand-new");
    const second = await actions.spawn(request);
    expect(second.type).toBe("success");

    // The freshly created directory now shows up when browsing its parent.
    const listing = await actions.browseDirectory("/Users/vy/projects");
    expect(listing.entries.map((e) => e.name)).toContain("brand-new");
  });
});
