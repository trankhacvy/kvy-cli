import { describe, expect, it } from "vitest";
import {
  isBackgroundUpdateRun,
  isUpdateOptedOut,
  releaseAssetUrl,
  resolveUpdateRepo,
} from "./config.js";

describe("resolveUpdateRepo", () => {
  it("defaults to falcon-dev/falcon (same slug as scripts/install.sh)", () => {
    expect(resolveUpdateRepo({})).toBe("falcon-dev/falcon");
  });

  it("honors FALCON_REPO override", () => {
    expect(resolveUpdateRepo({ FALCON_REPO: "acme/falcon-fork" })).toBe("acme/falcon-fork");
  });

  it("ignores a blank override", () => {
    expect(resolveUpdateRepo({ FALCON_REPO: "   " })).toBe("falcon-dev/falcon");
  });
});

describe("isUpdateOptedOut", () => {
  it("is false when unset", () => {
    expect(isUpdateOptedOut({})).toBe(false);
  });

  it("is false for '0' and 'false'", () => {
    expect(isUpdateOptedOut({ FALCON_NO_UPDATE: "0" })).toBe(false);
    expect(isUpdateOptedOut({ FALCON_NO_UPDATE: "false" })).toBe(false);
  });

  it("is true for '1' and any other non-empty value", () => {
    expect(isUpdateOptedOut({ FALCON_NO_UPDATE: "1" })).toBe(true);
    expect(isUpdateOptedOut({ FALCON_NO_UPDATE: "yes" })).toBe(true);
  });
});

describe("isBackgroundUpdateRun", () => {
  it("is true only when FALCON_UPDATE_SILENT is exactly '1'", () => {
    expect(isBackgroundUpdateRun({ FALCON_UPDATE_SILENT: "1" })).toBe(true);
    expect(isBackgroundUpdateRun({})).toBe(false);
    expect(isBackgroundUpdateRun({ FALCON_UPDATE_SILENT: "true" })).toBe(false);
  });
});

describe("releaseAssetUrl", () => {
  it("builds a cli-latest rolling-tag download URL", () => {
    expect(releaseAssetUrl("falcon-dev/falcon", "falcon-darwin-arm64")).toBe(
      "https://github.com/falcon-dev/falcon/releases/download/cli-latest/falcon-darwin-arm64",
    );
  });
});
