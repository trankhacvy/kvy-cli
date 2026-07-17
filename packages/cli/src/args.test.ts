import { describe, expect, it } from "vitest";
import { ArgParseError, parseArgs } from "./args.js";

describe("parseArgs — help/version", () => {
  it("recognizes --help and -h", () => {
    expect(parseArgs(["--help"])).toEqual({ type: "help" });
    expect(parseArgs(["-h"])).toEqual({ type: "help" });
  });

  it("recognizes --version, -v, and -V", () => {
    expect(parseArgs(["--version"])).toEqual({ type: "version" });
    expect(parseArgs(["-v"])).toEqual({ type: "version" });
    expect(parseArgs(["-V"])).toEqual({ type: "version" });
  });

  it("top-level --help wins even if other args follow", () => {
    expect(parseArgs(["--help", "claude"])).toEqual({ type: "help" });
  });
});

describe("parseArgs — default start (no explicit provider)", () => {
  it("starts claude with no args when argv is empty", () => {
    expect(parseArgs([])).toEqual({ type: "start", provider: "claude", providerArgs: [] });
  });

  it("forwards unrecognized flags verbatim to the default provider", () => {
    expect(parseArgs(["--resume", "abc123"])).toEqual({
      type: "start",
      provider: "claude",
      providerArgs: ["--resume", "abc123"],
    });
  });

  it("extracts -b <branch> as a Falcon-level flag, not provider passthrough", () => {
    expect(parseArgs(["-b", "feature/x"])).toEqual({
      type: "start",
      provider: "claude",
      providerArgs: [],
      branch: "feature/x",
    });
  });

  it("extracts --branch <name> alongside other passthrough args", () => {
    expect(parseArgs(["--model", "opus", "--branch", "feature/y", "--verbose"])).toEqual({
      type: "start",
      provider: "claude",
      providerArgs: ["--model", "opus", "--verbose"],
      branch: "feature/y",
    });
  });

  it("throws when -b is given without a branch name", () => {
    expect(() => parseArgs(["-b"])).toThrow(ArgParseError);
    expect(() => parseArgs(["-b"])).toThrow(/requires a branch name/);
  });
});

describe("parseArgs — provider passthrough (claude/codex)", () => {
  it("passes every flag through verbatim for `falcon claude [args...]`", () => {
    expect(
      parseArgs(["claude", "--resume", "abc123", "--model", "opus", "--some-unknown-flag"]),
    ).toEqual({
      type: "start",
      provider: "claude",
      providerArgs: ["--resume", "abc123", "--model", "opus", "--some-unknown-flag"],
    });
  });

  it("passes every flag through verbatim for `falcon codex [args...]`", () => {
    expect(parseArgs(["codex", "-r", "--continue"])).toEqual({
      type: "start",
      provider: "codex",
      providerArgs: ["-r", "--continue"],
    });
  });

  it("does not intercept -b when it appears after an explicit provider name", () => {
    // -b is only a Falcon flag in the default-start form; once `claude` is
    // named explicitly, Falcon must not touch any of its args.
    expect(parseArgs(["claude", "-b", "feature/x"])).toEqual({
      type: "start",
      provider: "claude",
      providerArgs: ["-b", "feature/x"],
    });
  });

  it("forwards --help to the provider instead of showing Falcon's help", () => {
    expect(parseArgs(["claude", "--help"])).toEqual({
      type: "start",
      provider: "claude",
      providerArgs: ["--help"],
    });
  });

  it("supports an empty passthrough arg list", () => {
    expect(parseArgs(["codex"])).toEqual({ type: "start", provider: "codex", providerArgs: [] });
  });
});

describe("parseArgs — auth", () => {
  it.each(["login", "logout", "status"] as const)("accepts auth %s", (action) => {
    expect(parseArgs(["auth", action])).toEqual({ type: "auth", action });
  });

  it("throws on an unknown auth action", () => {
    expect(() => parseArgs(["auth", "bogus"])).toThrow(ArgParseError);
  });

  it("throws when no auth action is given", () => {
    expect(() => parseArgs(["auth"])).toThrow(/none/);
  });
});

describe("parseArgs — daemon", () => {
  it("parses daemon start without --no-wait", () => {
    expect(parseArgs(["daemon", "start"])).toEqual({
      type: "daemon",
      action: "start",
      noWait: false,
    });
  });

  it("parses daemon start --no-wait", () => {
    expect(parseArgs(["daemon", "start", "--no-wait"])).toEqual({
      type: "daemon",
      action: "start",
      noWait: true,
    });
  });

  it("parses daemon stop and status", () => {
    expect(parseArgs(["daemon", "stop"])).toEqual({
      type: "daemon",
      action: "stop",
      noWait: false,
    });
    expect(parseArgs(["daemon", "status"])).toEqual({
      type: "daemon",
      action: "status",
      noWait: false,
    });
  });

  it("parses daemon start-sync", () => {
    expect(parseArgs(["daemon", "start-sync"])).toEqual({
      type: "daemon",
      action: "start-sync",
      noWait: false,
    });
  });

  it("throws on an unknown daemon action", () => {
    expect(() => parseArgs(["daemon", "bogus"])).toThrow(ArgParseError);
  });
});

describe("parseArgs — kill", () => {
  it.each(["daemon", "sessions", "all", "all-force"] as const)("accepts kill %s", (target) => {
    expect(parseArgs(["kill", target])).toEqual({ type: "kill", target });
  });

  it("throws on an unknown kill target", () => {
    expect(() => parseArgs(["kill", "everything"])).toThrow(ArgParseError);
  });
});

describe("parseArgs — doctor", () => {
  it("defaults to the report action with no subcommand", () => {
    expect(parseArgs(["doctor"])).toEqual({ type: "doctor", action: "report" });
  });

  it("parses doctor clean", () => {
    expect(parseArgs(["doctor", "clean"])).toEqual({ type: "doctor", action: "clean" });
  });

  it("throws on an unknown doctor action", () => {
    expect(() => parseArgs(["doctor", "bogus"])).toThrow(ArgParseError);
  });
});

describe("parseArgs — sessions", () => {
  it("parses sessions list", () => {
    expect(parseArgs(["sessions", "list"])).toEqual({ type: "sessions", action: "list" });
  });

  it("throws on an unknown sessions action", () => {
    expect(() => parseArgs(["sessions", "bogus"])).toThrow(ArgParseError);
  });
});

describe("parseArgs — resume", () => {
  it("parses a session id", () => {
    expect(parseArgs(["resume", "sess_123"])).toEqual({ type: "resume", sessionId: "sess_123" });
  });

  it("throws when no session id is given", () => {
    expect(() => parseArgs(["resume"])).toThrow(ArgParseError);
  });
});

describe("parseArgs — workspace", () => {
  it("parses workspace sync", () => {
    expect(parseArgs(["workspace", "sync"])).toEqual({ type: "workspace-sync" });
  });

  it("parses workspace config with all flags", () => {
    expect(
      parseArgs([
        "workspace",
        "config",
        "--base-ref",
        "origin/main",
        "--remote",
        "origin",
        "--directory",
        "/repo",
      ]),
    ).toEqual({
      type: "workspace-config",
      baseRef: "origin/main",
      remote: "origin",
      directory: "/repo",
    });
  });

  it("parses workspace config with a subset of flags", () => {
    expect(parseArgs(["workspace", "config", "--base-ref", "main"])).toEqual({
      type: "workspace-config",
      baseRef: "main",
    });
  });

  it("throws on an unknown workspace config flag", () => {
    expect(() => parseArgs(["workspace", "config", "--bogus", "x"])).toThrow(ArgParseError);
  });

  it("throws when a workspace config flag is missing its value", () => {
    expect(() => parseArgs(["workspace", "config", "--base-ref"])).toThrow(ArgParseError);
  });

  it("throws on an unknown workspace action", () => {
    expect(() => parseArgs(["workspace", "bogus"])).toThrow(ArgParseError);
  });

  it("parses workspace register with all flags", () => {
    expect(
      parseArgs(["workspace", "register", "--directory", "/repo", "--name", "My Repo"]),
    ).toEqual({ type: "workspace-register", directory: "/repo", name: "My Repo" });
  });

  it("parses a bare workspace register", () => {
    expect(parseArgs(["workspace", "register"])).toEqual({ type: "workspace-register" });
  });

  it("throws on an unknown workspace register flag", () => {
    expect(() => parseArgs(["workspace", "register", "--bogus", "x"])).toThrow(ArgParseError);
  });

  it("throws when a workspace register flag is missing its value", () => {
    expect(() => parseArgs(["workspace", "register", "--directory"])).toThrow(ArgParseError);
  });

  it("parses workspace list", () => {
    expect(parseArgs(["workspace", "list"])).toEqual({ type: "workspace-list" });
  });

  it("parses workspace unregister with --directory", () => {
    expect(parseArgs(["workspace", "unregister", "--directory", "/repo"])).toEqual({
      type: "workspace-unregister",
      directory: "/repo",
    });
  });

  it("parses a bare workspace unregister", () => {
    expect(parseArgs(["workspace", "unregister"])).toEqual({ type: "workspace-unregister" });
  });

  it("throws on an unknown workspace unregister flag", () => {
    expect(() => parseArgs(["workspace", "unregister", "--bogus", "x"])).toThrow(ArgParseError);
  });
});

describe("parseArgs — adopt", () => {
  it("parses a bare `falcon adopt` as local, non-list", () => {
    expect(parseArgs(["adopt"])).toEqual({ type: "adopt", list: false, remote: false });
  });

  it("parses --list and --remote, in either order", () => {
    expect(parseArgs(["adopt", "--list"])).toEqual({ type: "adopt", list: true, remote: false });
    expect(parseArgs(["adopt", "--remote"])).toEqual({ type: "adopt", list: false, remote: true });
    expect(parseArgs(["adopt", "--remote", "--list"])).toEqual({
      type: "adopt",
      list: true,
      remote: true,
    });
  });

  it("throws on an unknown adopt flag", () => {
    expect(() => parseArgs(["adopt", "--bogus"])).toThrow(ArgParseError);
  });
});

describe("parseArgs — --continue alias", () => {
  it("aliases a bare `falcon --continue` to adopt (local, non-list)", () => {
    expect(parseArgs(["--continue"])).toEqual({ type: "adopt", list: false, remote: false });
  });

  it("composes with --remote/--list the same way `falcon adopt` does", () => {
    expect(parseArgs(["--continue", "--remote"])).toEqual({
      type: "adopt",
      list: false,
      remote: true,
    });
  });

  it("does not intercept --continue when it's not the first arg (provider passthrough wins)", () => {
    expect(parseArgs(["codex", "-r", "--continue"])).toEqual({
      type: "start",
      provider: "codex",
      providerArgs: ["-r", "--continue"],
    });
  });
});

describe("parseArgs — notify", () => {
  it("parses -p <message>", () => {
    expect(parseArgs(["notify", "-p", "build finished"])).toEqual({
      type: "notify",
      message: "build finished",
    });
  });

  it("throws when -p is missing", () => {
    expect(() => parseArgs(["notify"])).toThrow(ArgParseError);
  });

  it("throws when -p has no message", () => {
    expect(() => parseArgs(["notify", "-p"])).toThrow(ArgParseError);
  });
});

describe("ArgParseError", () => {
  it("carries a usage string alongside the message", () => {
    try {
      parseArgs(["resume"]);
      throw new Error("expected parseArgs to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ArgParseError);
      expect((error as ArgParseError).usage).toBe("falcon resume <session-id>");
    }
  });
});
