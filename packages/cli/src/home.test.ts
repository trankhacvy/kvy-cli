import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHomeDir } from "./home.js";

describe("resolveHomeDir", () => {
  it("defaults to ~/.kvy when KVY_HOME_DIR is unset", () => {
    expect(resolveHomeDir({})).toBe(path.join(homedir(), ".kvy"));
  });

  it("ignores a blank KVY_HOME_DIR", () => {
    expect(resolveHomeDir({ KVY_HOME_DIR: "   " })).toBe(path.join(homedir(), ".kvy"));
  });

  it("uses KVY_HOME_DIR when set, resolved to an absolute path", () => {
    expect(resolveHomeDir({ KVY_HOME_DIR: "/tmp/kvy-test-home" })).toBe(
      path.resolve("/tmp/kvy-test-home"),
    );
  });

  it("resolves a relative KVY_HOME_DIR against the cwd", () => {
    expect(resolveHomeDir({ KVY_HOME_DIR: "relative-home" })).toBe(path.resolve("relative-home"));
  });
});
