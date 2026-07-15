import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHomeDir } from "./home.js";

describe("resolveHomeDir", () => {
  it("defaults to ~/.falcon when FALCON_HOME_DIR is unset", () => {
    expect(resolveHomeDir({})).toBe(path.join(homedir(), ".falcon"));
  });

  it("ignores a blank FALCON_HOME_DIR", () => {
    expect(resolveHomeDir({ FALCON_HOME_DIR: "   " })).toBe(path.join(homedir(), ".falcon"));
  });

  it("uses FALCON_HOME_DIR when set, resolved to an absolute path", () => {
    expect(resolveHomeDir({ FALCON_HOME_DIR: "/tmp/falcon-test-home" })).toBe(
      path.resolve("/tmp/falcon-test-home"),
    );
  });

  it("resolves a relative FALCON_HOME_DIR against the cwd", () => {
    expect(resolveHomeDir({ FALCON_HOME_DIR: "relative-home" })).toBe(
      path.resolve("relative-home"),
    );
  });
});
