import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  preferredRcFile,
  rcFileCandidates,
  shimBinaryNames,
  shimBinaryPath,
  shimBinDir,
} from "./paths.js";

describe("shimBinDir / shimBinaryPath", () => {
  it("resolves under the given homeDir's bin/ subdirectory", () => {
    expect(shimBinDir({ homeDir: "/home/x/.falcon" })).toBe(path.join("/home/x/.falcon", "bin"));
  });

  it("shimBinaryPath joins the binary name onto the bin dir", () => {
    expect(shimBinaryPath("claude", { homeDir: "/home/x/.falcon" })).toBe(
      path.join("/home/x/.falcon", "bin", "claude"),
    );
    expect(shimBinaryPath("codex", { homeDir: "/home/x/.falcon" })).toBe(
      path.join("/home/x/.falcon", "bin", "codex"),
    );
  });

  it("shimBinaryNames returns exactly claude and codex", () => {
    expect(shimBinaryNames()).toEqual(["claude", "codex"]);
  });
});

describe("rcFileCandidates", () => {
  it("returns zsh, bash, fish, and profile under the given userHomeDir", () => {
    const candidates = rcFileCandidates({ userHomeDir: "/home/x" });
    expect(candidates).toEqual([
      { path: path.join("/home/x", ".zshrc"), syntax: "posix" },
      { path: path.join("/home/x", ".bashrc"), syntax: "posix" },
      { path: path.join("/home/x", ".config", "fish", "config.fish"), syntax: "fish" },
      { path: path.join("/home/x", ".profile"), syntax: "posix" },
    ]);
  });
});

describe("preferredRcFile", () => {
  it("picks .zshrc for $SHELL=/bin/zsh", () => {
    const rc = preferredRcFile({ userHomeDir: "/home/x", env: { SHELL: "/bin/zsh" } });
    expect(rc).toEqual({ path: path.join("/home/x", ".zshrc"), syntax: "posix" });
  });

  it("picks .bashrc for $SHELL=/bin/bash", () => {
    const rc = preferredRcFile({ userHomeDir: "/home/x", env: { SHELL: "/bin/bash" } });
    expect(rc).toEqual({ path: path.join("/home/x", ".bashrc"), syntax: "posix" });
  });

  it("picks fish config for $SHELL=/usr/local/bin/fish", () => {
    const rc = preferredRcFile({ userHomeDir: "/home/x", env: { SHELL: "/usr/local/bin/fish" } });
    expect(rc).toEqual({
      path: path.join("/home/x", ".config", "fish", "config.fish"),
      syntax: "fish",
    });
  });

  it("falls back to .profile for an unrecognized or unset $SHELL", () => {
    expect(preferredRcFile({ userHomeDir: "/home/x", env: {} })).toEqual({
      path: path.join("/home/x", ".profile"),
      syntax: "posix",
    });
    expect(preferredRcFile({ userHomeDir: "/home/x", env: { SHELL: "/bin/tcsh" } })).toEqual({
      path: path.join("/home/x", ".profile"),
      syntax: "posix",
    });
  });
});
