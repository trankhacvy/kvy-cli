import { describe, expect, it } from "vitest";
import { detectPlatformAsset } from "./platformAsset.js";

describe("detectPlatformAsset", () => {
  it("maps darwin/arm64 to kvy-darwin-arm64", () => {
    expect(detectPlatformAsset("darwin", "arm64")).toEqual({
      platform: "darwin",
      arch: "arm64",
      assetName: "kvy-darwin-arm64",
    });
  });

  it("maps darwin/x64 to kvy-darwin-x64", () => {
    expect(detectPlatformAsset("darwin", "x64")).toEqual({
      platform: "darwin",
      arch: "x64",
      assetName: "kvy-darwin-x64",
    });
  });

  it("maps linux/x64 to kvy-linux-x64", () => {
    expect(detectPlatformAsset("linux", "x64")).toEqual({
      platform: "linux",
      arch: "x64",
      assetName: "kvy-linux-x64",
    });
  });

  it("returns null for linux/arm64 — no binary published yet", () => {
    expect(detectPlatformAsset("linux", "arm64")).toBeNull();
  });

  it("returns null for unsupported platforms (win32) and archs (ia32)", () => {
    expect(detectPlatformAsset("win32", "x64")).toBeNull();
    expect(detectPlatformAsset("darwin", "ia32")).toBeNull();
  });
});
