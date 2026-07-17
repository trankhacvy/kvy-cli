import { describe, expect, it } from "vitest";
import { compareVersions, isNewerVersion, parseVersion } from "./versionCompare.js";

describe("parseVersion", () => {
  it("parses a plain semver string", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("strips a leading v", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("drops pre-release/build metadata", () => {
    expect(parseVersion("1.2.3-beta.1")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("1.2.3+build5")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("treats missing/malformed components as 0 rather than throwing", () => {
    expect(parseVersion("1.2")).toEqual({ major: 1, minor: 2, patch: 0 });
    expect(parseVersion("garbage")).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseVersion("")).toEqual({ major: 0, minor: 0, patch: 0 });
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.9.9", "2.0.0")).toBe(-1);
    expect(compareVersions("1.3.0", "1.2.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("compares v-prefixed and bare versions identically", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });
});

describe("isNewerVersion", () => {
  it("is true when latest > current", () => {
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(true);
  });

  it("is false when equal", () => {
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1.0", "v0.1.0")).toBe(false);
  });

  it("is false when latest < current (never downgrade)", () => {
    expect(isNewerVersion("0.2.0", "0.1.0")).toBe(false);
  });
});
