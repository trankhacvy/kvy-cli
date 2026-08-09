import { describe, expect, it } from "vitest";
import {
  isBackgroundUpdateRun,
  isUpdateOptedOut,
  releaseAssetUrl,
  resolveUpdateRepo,
} from "./config.js";

describe("resolveUpdateRepo", () => {
  it("defaults to trankhacvy/kvy-cli (same slug as scripts/install.sh)", () => {
    expect(resolveUpdateRepo({})).toBe("trankhacvy/kvy-cli");
  });

  it("honors KVY_REPO override", () => {
    expect(resolveUpdateRepo({ KVY_REPO: "acme/kvy-fork" })).toBe("acme/kvy-fork");
  });

  it("ignores a blank override", () => {
    expect(resolveUpdateRepo({ KVY_REPO: "   " })).toBe("trankhacvy/kvy-cli");
  });
});

describe("isUpdateOptedOut", () => {
  it("is false when unset", () => {
    expect(isUpdateOptedOut({})).toBe(false);
  });

  it("is false for '0' and 'false'", () => {
    expect(isUpdateOptedOut({ KVY_NO_UPDATE: "0" })).toBe(false);
    expect(isUpdateOptedOut({ KVY_NO_UPDATE: "false" })).toBe(false);
  });

  it("is true for '1' and any other non-empty value", () => {
    expect(isUpdateOptedOut({ KVY_NO_UPDATE: "1" })).toBe(true);
    expect(isUpdateOptedOut({ KVY_NO_UPDATE: "yes" })).toBe(true);
  });
});

describe("isBackgroundUpdateRun", () => {
  it("is true only when KVY_UPDATE_SILENT is exactly '1'", () => {
    expect(isBackgroundUpdateRun({ KVY_UPDATE_SILENT: "1" })).toBe(true);
    expect(isBackgroundUpdateRun({})).toBe(false);
    expect(isBackgroundUpdateRun({ KVY_UPDATE_SILENT: "true" })).toBe(false);
  });
});

describe("releaseAssetUrl", () => {
  it("builds a cli-latest rolling-tag download URL", () => {
    expect(releaseAssetUrl("trankhacvy/kvy-cli", "kvy-darwin-arm64")).toBe(
      "https://github.com/trankhacvy/kvy-cli/releases/download/cli-latest/kvy-darwin-arm64",
    );
  });
});
